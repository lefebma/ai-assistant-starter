/**
 * Built-in tools for the AI SDK runtime.
 *
 * The Claude Code harness provides bash/read/write/edit invisibly; this is
 * the owned replacement. Semantics deliberately mirror Claude Code's tools
 * (edit requires a unique match, outputs are truncated with an explicit
 * marker) so prompts and skills written against the claude runtime behave
 * the same here. MCP servers land in the next Phase 2 slice.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

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

function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise(resolvePromise => {
    execFile(
      '/bin/zsh',
      ['-lc', command],
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = truncate(String(stdout ?? ''), OUTPUT_CAP)
        const err = truncate(String(stderr ?? ''), OUTPUT_CAP)
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
          const timedOut = (error as { killed?: boolean }).killed && timeoutMs > 0
          resolvePromise(
            `exit code: ${typeof code === 'number' ? code : 1}${timedOut ? ' (timed out)' : ''}\n`
              + (out ? `stdout:\n${out}\n` : '')
              + (err ? `stderr:\n${err}` : '')
          )
          return
        }
        resolvePromise(out || err || '(no output)')
      }
    )
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
        'Execute a shell command (zsh) and return its output. Use for anything the file tools do not cover: '
        + 'listing/searching files, git, network requests, running scripts.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z
          .number()
          .optional()
          .describe(`Timeout in milliseconds (default ${BASH_TIMEOUT_DEFAULT_MS}, max ${BASH_TIMEOUT_MAX_MS})`),
      }),
      execute: async ({ command, timeout_ms }) => {
        report('bash', command)
        // Treat 0/negative as "use default": execFile interprets timeout 0 as unbounded.
        const requested = timeout_ms && timeout_ms > 0 ? timeout_ms : BASH_TIMEOUT_DEFAULT_MS
        return runBash(command, cwd, Math.min(requested, BASH_TIMEOUT_MAX_MS))
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
