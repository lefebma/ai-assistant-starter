/**
 * Pick the changelog entry for a specific version.
 *
 * The update check used to return the first `## ` section of CHANGELOG.md,
 * which is `## Unreleased`. Right after a release that section is empty, and
 * an empty changelog handed to the model got filled in from memory: a box on
 * 1.21.0 described 1.22.0 with features from 1.18 to 1.20. The entry for the
 * version being offered is the only one that answers "what's in it".
 */

const HEADING = /^## (\S+)(?:\s+-\s+(\S+))?\s*$/

/** The body of the `## <version>` entry, or null when absent or empty. */
export function extractChangelogSection(text: string, version: string): string | null {
  const want = version.replace(/^v/, '')
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i])
    if (!m) continue
    if (start >= 0) return finish(lines.slice(start, i))
    if (m[1].replace(/^v/, '') === want) start = i
  }
  return start >= 0 ? finish(lines.slice(start)) : null
}

function finish(section: string[]): string | null {
  const body = section.slice(1).join('\n').trim()
  if (!body) return null
  return `${section[0].trim()}\n\n${body}`
}
