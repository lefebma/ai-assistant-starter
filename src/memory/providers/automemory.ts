import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ContextProvider, ContextFragment } from './base.js'
import { logger } from '../../logger.js'

const projectKey = process.cwd().replace(/\//g, '-').replace(/^-/, '')
const AUTO_MEMORY_DIR = resolve(
  homedir(),
  `.claude/projects/${projectKey}/memory`
)
const INDEX_FILE = 'MEMORY.md'
const SKIP_FILES = new Set(['MEMORY.md', 'DREAMS.md'])
const MAX_FILE_MATCHES = 3
const MIN_KEYWORD_LEN = 4

interface MemoryFile {
  filename: string
  name: string
  description: string
  type: string
  body: string
  mtimeMs: number
  haystack: string
}

const STOPWORDS = new Set([
  'about','above','after','again','against','all','also','any','are','because','been','before',
  'being','below','between','both','could','does','doing','down','during','each','from','further',
  'have','having','here','into','more','most','once','only','other','over','same','some','such',
  'than','that','them','then','there','these','they','this','those','through','under','until',
  'very','what','when','where','which','while','with','would','your','yours',
])

function parseFile(path: string): MemoryFile | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!fm) return null
    const frontmatter = Object.fromEntries(
      fm[1]
        .split('\n')
        .map((line) => {
          const m = line.match(/^([A-Za-z_]+):\s*(.*)$/)
          return m ? [m[1], m[2].trim()] : null
        })
        .filter((x): x is [string, string] => x !== null)
    )
    const body = fm[2]
    const filename = path.split('/').pop() ?? path
    return {
      filename,
      name: frontmatter.name ?? filename,
      description: frontmatter.description ?? '',
      type: frontmatter.type ?? 'unknown',
      body,
      mtimeMs: statSync(path).mtimeMs,
      haystack: `${frontmatter.name ?? ''} ${frontmatter.description ?? ''} ${body}`.toLowerCase(),
    }
  } catch (err) {
    logger.debug({ err, path }, 'Failed to parse memory file')
    return null
  }
}

function loadMemoryFiles(): { index: string | null; files: MemoryFile[] } {
  if (!existsSync(AUTO_MEMORY_DIR)) return { index: null, files: [] }
  const entries = readdirSync(AUTO_MEMORY_DIR).filter((f) => f.endsWith('.md'))
  const indexPath = join(AUTO_MEMORY_DIR, INDEX_FILE)
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').trim() : null
  const files: MemoryFile[] = []
  for (const entry of entries) {
    if (SKIP_FILES.has(entry)) continue
    const parsed = parseFile(join(AUTO_MEMORY_DIR, entry))
    if (parsed) files.push(parsed)
  }
  return { index, files }
}

function extractKeywords(message: string): string[] {
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_KEYWORD_LEN && !STOPWORDS.has(t))
  return [...new Set(tokens)]
}

function scoreFile(file: MemoryFile, keywords: string[]): number {
  if (keywords.length === 0) return 0
  let hits = 0
  for (const kw of keywords) {
    if (file.haystack.includes(kw)) hits++
  }
  return hits / keywords.length
}

/**
 * AutoMemoryProvider - injects persistent memory from auto-memory file store.
 *
 * Behavior:
 * - Always injects MEMORY.md index so Claude knows what memories exist
 * - Matches message keywords against each memory file and injects top matches
 * - Keeps budget reasonable by only inlining the top N scored files
 *
 * This is the Umi analog to OpenClaw's Active Memory plugin: a pre-reply
 * memory surface so persistent facts reach the agent without the agent needing
 * to explicitly read files.
 */
export class AutoMemoryProvider implements ContextProvider {
  name = 'auto-memory'
  priority = 90
  enabled = true

  async retrieve(_chatId: string, message: string): Promise<ContextFragment[]> {
    const { index, files } = loadMemoryFiles()
    if (!index && files.length === 0) return []

    const keywords = extractKeywords(message)
    const fragments: ContextFragment[] = []

    if (index) {
      fragments.push({
        source: 'auto-memory:index',
        content: `Persistent memory index (MEMORY.md):\n${index}`,
        relevance: 1.0,
      })
    }

    const scored = files
      .map((f) => ({ file: f, score: scoreFile(f, keywords) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FILE_MATCHES)

    for (const { file, score } of scored) {
      fragments.push({
        source: `auto-memory:${file.filename}`,
        content: `Memory entry (${file.type}) — ${file.name}:\n${file.body.trim()}`,
        relevance: 0.6 + score * 0.4,
      })
    }

    logger.debug(
      { indexIncluded: !!index, matched: scored.length, totalFiles: files.length },
      'AutoMemoryProvider'
    )

    return fragments
  }
}
