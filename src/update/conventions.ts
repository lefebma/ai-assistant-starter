/**
 * Teaching an existing install a new reply convention.
 *
 * The markers the bot core understands ([[buttons:]], [[file:]]) are only
 * ever read by the assistant from CLAUDE.md, and CLAUDE.md is in
 * PRESERVED_PATHS, so an update never rewrites it. Without something like
 * this, a marker added to templates/CLAUDE.md.template reaches fresh installs
 * only, and every box already in service keeps an assistant that has never
 * heard of it. Same role as syncPlaywrightMcp and syncAlwaysOnSkills: config
 * the owner owns, which the payload cannot carry and the engine still needs
 * reconciled.
 *
 * Append-only and idempotent, and it never touches a line the owner wrote.
 * Detection is by the marker itself rather than by the heading, so an owner
 * who documented it in their own words is left alone.
 */

export const FILE_MARKER_SECTION = `
## Sending a file

To hand over an actual file (a screenshot, a PDF, a CSV you just built), end
your reply with:

\`[[file: workspace/uploads/chart.png]]\`

The bot strips the marker and sends the file to this chat after the message
text. The path is relative to the project folder, or absolute inside it.
Images arrive as pictures, everything else as a file. Up to four per reply.

- Say what the file is in the message. The marker is the delivery, not the
  explanation.
- A path outside the project folder, a credential file, a database, or
  anything over 25 MB is refused, and the owner sees why.
- Teams asks the owner to accept anything that is not a small image, because
  it lands in their OneDrive. That is Microsoft's flow, not a choice.
`

/**
 * @returns the file's new contents, or null when the section is already there.
 */
export function ensureFileMarkerSection(claudeMd: string): string | null {
  if (claudeMd.includes('[[file:')) return null
  const trimmed = claudeMd.replace(/\s+$/, '')
  return `${trimmed}\n${FILE_MARKER_SECTION}`
}
