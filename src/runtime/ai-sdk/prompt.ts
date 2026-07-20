/**
 * System prompt assembly for the AI SDK runtime.
 *
 * Claude Code loads CLAUDE.md files automatically (settingSources
 * ['project', 'user'] in the claude runtime); this runtime assembles the
 * equivalent by hand: user-level ~/.claude/CLAUDE.md first, then the
 * project CLAUDE.md (project guidance wins on conflict, matching Claude
 * Code precedence), plus a small environment block the harness would
 * otherwise provide.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir, platform } from 'node:os'

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

export function buildSystemPrompt(projectRoot: string): string {
  const parts: string[] = []

  parts.push(
    'You are a persistent personal assistant agent. You run as a service with tool access '
      + '(shell, file system). Follow the operating instructions below exactly; they override defaults.'
  )

  const userMd = readIfExists(resolve(homedir(), '.claude', 'CLAUDE.md'))
  if (userMd?.trim()) {
    parts.push(`# User instructions (global)\n\n${userMd.trim()}`)
  }

  const projectMd = readIfExists(resolve(projectRoot, 'CLAUDE.md'))
  if (projectMd?.trim()) {
    parts.push(`# Project instructions\n\n${projectMd.trim()}`)
  }

  const now = new Date()
  const dateStr = now.toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false })
  parts.push(
    '# Environment\n\n'
      + `- Working directory: ${projectRoot}\n`
      + `- Platform: ${platform()}\n`
      + `- Current date/time (America/Toronto): ${dateStr}\n`
      + `- Agent runtime: ai-sdk (direct API billing, no Claude Code harness)`
  )

  return parts.join('\n\n---\n\n')
}
