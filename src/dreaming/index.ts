import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { getAgentRuntime } from '../runtime/index.js'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

// Auto-detect the Claude Code project directory from PROJECT_ROOT
const projectKey = PROJECT_ROOT.replace(/\//g, '-').replace(/^-/, '')
const MEMORY_DIR = resolve(homedir(), `.claude/projects/${projectKey}/memory`)
const SESSIONS_DIR = resolve(homedir(), `.claude/projects/${projectKey}`)
const DREAMS_FILE = join(MEMORY_DIR, 'DREAMS.md')
const LOOKBACK_DAYS = 7
const MAX_USER_CHARS = 120_000

interface UserTurn {
  sessionId: string
  timestamp: string
  text: string
}

function stripSystemWrappers(text: string): string {
  return text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .replace(/\[Request interrupted by user[^\]]*\]/g, '')
    .trim()
}

function collectRecentUserTurns(cutoffMs: number): UserTurn[] {
  const turns: UserTurn[] = []
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(SESSIONS_DIR, f))
    .filter((p) => statSync(p).mtimeMs >= cutoffMs)

  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj.type !== 'user' || !obj.message?.content) continue
      const content = obj.message.content
      const parts: string[] = []
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const cleaned = stripSystemWrappers(block.text)
            if (cleaned) parts.push(cleaned)
          }
        }
      } else if (typeof content === 'string') {
        const cleaned = stripSystemWrappers(content)
        if (cleaned) parts.push(cleaned)
      }
      const text = parts.join('\n').trim()
      if (!text) continue
      if (text.length < 4) continue
      const ts = obj.timestamp ?? ''
      if (ts && Date.parse(ts) < cutoffMs) continue
      turns.push({
        sessionId: obj.sessionId ?? 'unknown',
        timestamp: ts,
        text,
      })
    }
  }

  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return turns
}

function loadExistingMemory(): string {
  if (!existsSync(MEMORY_DIR)) return '(no memory dir yet)'
  const entries = readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'))
  const parts: string[] = []
  for (const entry of entries) {
    if (entry === 'DREAMS.md') continue
    const body = readFileSync(join(MEMORY_DIR, entry), 'utf8')
    parts.push(`=== ${entry} ===\n${body}`)
  }
  return parts.join('\n\n') || '(no memory files)'
}

function formatTurnsForPrompt(turns: UserTurn[]): string {
  const lines: string[] = []
  let total = 0
  for (const turn of turns) {
    const date = turn.timestamp ? turn.timestamp.slice(0, 10) : '????-??-??'
    const chunk = `[${date}] ${turn.text}\n`
    if (total + chunk.length > MAX_USER_CHARS) break
    lines.push(chunk)
    total += chunk.length
  }
  return lines.join('\n')
}

function buildPrompt(existingMemory: string, turnsBlock: string): string {
  return `You are the dreaming sub-agent. Your job is memory consolidation: review the last ${LOOKBACK_DAYS} days of conversations and identify what deserves to land in persistent memory.

EXISTING MEMORY (do not duplicate, but note drift):
<existing_memory>
${existingMemory}
</existing_memory>

RECENT USER MESSAGES (filtered; assistant turns omitted to save budget):
<recent_turns>
${turnsBlock}
</recent_turns>

YOUR TASK
Produce a DREAMS.md diary entry. Be disciplined: quality over quantity, and never hallucinate recurrence that isn't in the evidence.

FORMAT your response EXACTLY like this (no preamble, no meta commentary):

## Sweep: <today's ISO date>

### Themes
- <2-4 bullets of patterns observed across multiple sessions>

### Candidates for promotion
For each candidate, use this block:
\`\`\`
TYPE: <user|feedback|project|reference>
NAME: <kebab-case identifier matching existing naming>
CONFIDENCE: <1-10>
RATIONALE: <one sentence citing recurrence evidence>
CONTENT:
<the full memory body, following the same frontmatter+body format used by existing memory files>
\`\`\`
Only propose candidates with clear recurrence (appeared in 2+ sessions) or high single-shot salience (explicit "remember this" / correction / project pivot). Skip vague vibes.

### Drift to reconcile
Note any existing memory that now contradicts current reality. Cite the file and propose an update. If none, say "None detected."

### Skipped
One-line list of things you considered but rejected (with reason). Max 5.

RULES:
- Never fabricate facts not present in the turns.
- Never mention this dreaming process in memory content (content should be written as if directly observed).
- No em dashes. Use commas or periods.
- Absolute date references only (convert "yesterday" to YYYY-MM-DD based on the session timestamps).
- Total response under 1200 words.`
}

async function runDreamingAgent(prompt: string): Promise<string> {
  return getAgentRuntime().runOnce(prompt)
}

function appendDream(body: string): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
  const header = existsSync(DREAMS_FILE)
    ? '\n\n---\n\n'
    : '# DREAMS.md\n\nAutomatic memory consolidation sweeps. Written nightly by the dreaming job.\n\n'
  appendFileSync(DREAMS_FILE, header + body + '\n')
}

export async function runDream(options: { dryRun?: boolean } = {}): Promise<void> {
  const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const turns = collectRecentUserTurns(cutoffMs)
  logger.info({ turnCount: turns.length, lookbackDays: LOOKBACK_DAYS }, 'Collected user turns')

  if (turns.length === 0) {
    logger.info('No recent turns, skipping dream sweep')
    return
  }

  const existingMemory = loadExistingMemory()
  const turnsBlock = formatTurnsForPrompt(turns)
  const prompt = buildPrompt(existingMemory, turnsBlock)

  if (options.dryRun) {
    logger.info({ promptChars: prompt.length }, 'Dry run: prompt built')
    process.stdout.write(prompt)
    return
  }

  logger.info({ promptChars: prompt.length }, 'Calling dreaming agent')
  const body = await runDreamingAgent(prompt)
  if (!body) {
    logger.warn('Dreaming agent returned empty body, skipping write')
    return
  }

  appendDream(body)
  logger.info({ chars: body.length, file: DREAMS_FILE }, 'Dream written')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run')
  runDream({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Dream sweep failed')
      process.exit(1)
    })
}
