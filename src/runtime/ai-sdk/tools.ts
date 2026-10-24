/**
 * Built-in tools for the AI SDK runtime.
 *
 * The Claude Code harness provides bash/read/write/edit invisibly; this is
 * the owned replacement. Semantics deliberately mirror Claude Code's tools
 * (edit requires a unique match, outputs are truncated with an explicit
 * marker) so prompts and skills written against the claude runtime behave
 * the same here. MCP servers land in the next Phase 2 slice.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { toolEnv } from '../../egress/tool-env.js'
import { currentProxy } from '../../egress/index.js'
import { inToolsCgroup } from '../../egress/hosted.js'

const BASH_TIMEOUT_DEFAULT_MS = 120_000
const BASH_TIMEOUT_MAX_MS = 600_000
const OUTPUT_CAP = 30_000
const READ_CAP = 50_000

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n[output truncated at ${cap} characters]`
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

let cachedShell: { cmd: string; buildArgs: (command: string) => string[] } | null = null

/**
 * Portable shell resolution. POSIX: zsh (macOS default), then bash (Linux
 * default), then sh — with -l so the user's profile PATH (homebrew, nvm) is
 * loaded, matching the claude runtime's shell behavior. Windows: cmd.exe via
 * COMSPEC as a functional baseline until the installer ships a richer story.
 * Hardcoding /bin/zsh broke the tool on every non-Mac platform (caught by
 * the first CI matrix run).
 */
function resolveShell(): { cmd: string; buildArgs: (command: string) => string[] } {
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    cachedShell = { cmd: process.env.COMSPEC || 'cmd.exe', buildArgs: c => ['/d', '/s', '/c', c] }
    return cachedShell
  }
  for (const sh of ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash']) {
    if (existsSync(sh)) {
      cachedShell = { cmd: sh, buildArgs: c => ['-lc', c] }
      return cachedShell
    }
  }
  cachedShell = { cmd: '/bin/sh', buildArgs: c => ['-c', c] }
  return cachedShell
}

const BASH_MAX_BUFFER = 10 * 1024 * 1024

/**
 * On POSIX the shell leads its own process group, so a cancel (card #232) or
 * a timeout kills what it started too, not just the shell: `sleep 600 &` or a
 * curl in a pipeline would otherwise outlive the run. spawn, not execFile:
 * execFile ignores `detached`, so there was no group to kill.
 */
function runBash(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.resolve('cancelled: the run was stopped before this command started')
  const shell = resolveShell()
  // Hosted box with egress enforced: the shell runs in the tools cgroup (card #231).
  const run = currentProxy() ? inToolsCgroup(shell.cmd, shell.buildArgs(command)) : { command: shell.cmd, args: shell.buildArgs(command) }
  const posix = process.platform !== 'win32'
  return new Promise(resolvePromise => {
    const child = spawn(run.command, run.args, {
      cwd,
      // The run key (card #229) and the egress proxy (card #231).
      env: toolEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // cmd.exe mangles quoted args without this; no-op elsewhere.
      ...(posix ? { detached: true } : { windowsVerbatimArguments: true }),
    })
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        // already gone
      }
    }
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let timedOut = false
    let overflow = false
    const collect = (append: (s: string) => void) => (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > BASH_MAX_BUFFER) {
        if (!overflow) { overflow = true; killTree('SIGTERM') }
        return
      }
      append(chunk.toString())
    }
    child.stdout?.on('data', collect((t) => { stdout += t }))
    child.stderr?.on('data', collect((t) => { stderr += t }))
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree('SIGTERM') }, timeoutMs) : null
    const onAbort = () => killTree('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const finish = (code: number | null, failed: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        resolvePromise('cancelled: the run was stopped')
        return
      }
      const out = truncate(stdout, OUTPUT_CAP)
      const err = truncate(stderr, OUTPUT_CAP)
      if (failed || timedOut || overflow || code !== 0) {
        resolvePromise(
          `exit code: ${typeof code === 'number' && code !== 0 ? code : 1}${timedOut ? ' (timed out)' : ''}\n`
            + (out ? `stdout:\n${out}\n` : '')
            + (err ? `stderr:\n${err}` : '')
        )
        return
      }
      resolvePromise(out || err || '(no output)')
    }
    child.on('error', () => finish(null, true))
    child.on('close', (code) => finish(code, false))
  })
}

/**
 * Build the tool set for one agent run. `notify` fires on each invocation so
 * the runtime can surface tool progress (parity with the claude runtime's
 * tool_progress events).
 */
export function createTools(cwd: string, notify?: (toolName: string, status: string) => void): ToolSet {
  const report = (name: string, status: string) => {
    try {
      notify?.(name, status.slice(0, 100))
    } catch {
      // progress reporting must never break a tool call
    }
  }

  return {
    bash: tool({
      description:
        'Execute a shell command and return its output. Use for anything the file tools do not cover: '
        + 'listing/searching files, git, network requests, running scripts.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z
          .number()
          .optional()
          .describe(`Timeout in milliseconds (default ${BASH_TIMEOUT_DEFAULT_MS}, max ${BASH_TIMEOUT_MAX_MS})`),
      }),
      execute: async ({ command, timeout_ms }, { abortSignal }) => {
        report('bash', command)
        // Treat 0/negative as "use default": a timeout of 0 would mean unbounded.
        const requested = timeout_ms && timeout_ms > 0 ? timeout_ms : BASH_TIMEOUT_DEFAULT_MS
        return runBash(command, cwd, Math.min(requested, BASH_TIMEOUT_MAX_MS), abortSignal)
      },
    }),

    read_file: tool({
      description: 'Read a file from the filesystem. Returns the content (truncated if very large).',
      inputSchema: z.object({
        path: z.string().describe('Absolute path, or path relative to the working directory'),
      }),
      execute: async ({ path }) => {
        report('read_file', path)
        try {
          return truncate(readFileSync(resolvePath(cwd, path), 'utf-8'), READ_CAP)
        } catch (err) {
          return `Error reading file: ${String((err as Error).message ?? err)}`
        }
      },
    }),

    write_file: tool({
      description: 'Write content to a file, creating parent directories and overwriting if it exists.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path, or path relative to the working directory'),
        content: z.string().describe('The full file content to write'),
      }),
      execute: async ({ path, content }) => {
        report('write_file', path)
        try {
          const target = resolvePath(cwd, path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, content)
          return `Wrote ${content.length} characters to ${target}`
        } catch (err) {
          return `Error writing file: ${String((err as Error).message ?? err)}`
        }
      },
    }),

    edit_file: tool({
      description:
        'Replace an exact string in a file. old_string must match the file content exactly and be unique '
        + '(or set replace_all to replace every occurrence).',
      inputSchema: z.object({
        path: z.string().describe('Absolute path, or path relative to the working directory'),
        old_string: z.string().describe('The exact text to replace'),
        new_string: z.string().describe('The replacement text'),
        replace_all: z.boolean().optional().describe('Replace all occurrences (default false)'),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        report('edit_file', path)
        try {
          const target = resolvePath(cwd, path)
          const content = readFileSync(target, 'utf-8')
          const occurrences = content.split(old_string).length - 1
          if (occurrences === 0) {
            return 'Error: old_string not found in file. It must match the file content exactly, including whitespace.'
          }
          if (occurrences > 1 && !replace_all) {
            return `Error: old_string matches ${occurrences} times. Provide a longer, unique string or set replace_all.`
          }
          // Literal splice, never String.replace: its replacement argument
          // interprets $-tokens ($&, $`, $') even for string searches.
          const idx = content.indexOf(old_string)
          const updated = replace_all
            ? content.split(old_string).join(new_string)
            : content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
          writeFileSync(target, updated)
          return `Edited ${target} (${replace_all ? occurrences : 1} replacement${occurrences > 1 && replace_all ? 's' : ''})`
        } catch (err) {
          return `Error editing file: ${String((err as Error).message ?? err)}`
        }
      },
    }),
  }
}
