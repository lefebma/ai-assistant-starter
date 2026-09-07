/**
 * Workspace-specific guards, layered on the daily-sync ones. A workspace is
 * shared with people outside this install, so the bar is higher than "do not
 * leak a key": do not leak a number the owner has said stays private, and do
 * not push a binary nobody asked for.
 */

const ALLOWED_EXT = /\.(md|txt|png|jpe?g|gif|svg|webp)$/i

export function parsePrivatePatterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

export function findPrivatePatternHits(
  files: Array<{ path: string; content: string | null }>,
  patterns: string[]
): string[] {
  if (patterns.length === 0) return []
  const lowered = patterns.map((p) => p.toLowerCase())
  return files
    .filter((f) => f.content !== null && lowered.some((p) => (f.content as string).toLowerCase().includes(p)))
    .map((f) => f.path)
}

export function findDisallowedTypes(paths: string[]): string[] {
  return paths.filter((p) => !p.startsWith('inbox/') && !ALLOWED_EXT.test(p))
}

export function buildCommitSummary(assistant: string, paths: string[]): string {
  const head = paths.slice(0, 3).join(', ')
  const rest = paths.length - 3
  return `${assistant.toLowerCase()}: update ${head}${rest > 0 ? ` and ${rest} more` : ''}`
}
