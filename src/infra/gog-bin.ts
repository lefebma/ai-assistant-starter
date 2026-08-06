/**
 * Locating the gog CLI (github.com/steipete/gogcli), which backs the Gmail and
 * Calendar skills.
 *
 * This used to be the literal string '/opt/homebrew/bin/gog'. That is the
 * Apple Silicon Homebrew prefix and nowhere else: an Intel Mac puts it under
 * /usr/local, Linux varies, and Windows has no Homebrew at all. A Windows
 * install therefore reported no Gmail connection with no way to fix it, and an
 * Intel Mac would have failed the same way.
 *
 * Absolute candidates are tried before the bare command name on purpose. The
 * assistant normally runs from launchd or Task Scheduler, which hand it a
 * minimal PATH that often does not include Homebrew or a user-local bin.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

type Exists = (path: string) => boolean

/** Where gog plausibly lives, most likely first. */
export function gogCandidates(platform: string, home: string): string[] {
  if (platform === 'win32') {
    return [
      `${home}\\.local\\bin\\gog.exe`,
      `${home}\\scoop\\shims\\gog.exe`,
      'C:\\Program Files\\gogcli\\gog.exe',
    ]
  }

  return [
    '/opt/homebrew/bin/gog', // Homebrew, Apple Silicon
    '/usr/local/bin/gog', // Homebrew on Intel, and the usual Linux manual install
    `${home}/.local/bin/gog`, // non-admin install
    '/usr/bin/gog',
  ]
}

/** The bare name, for the PATH fallback. */
function bareName(platform: string): string {
  return platform === 'win32' ? 'gog.exe' : 'gog'
}

/**
 * Resolve the gog executable. `GOG_BIN` in the environment always wins, so an
 * unusual install is one line in .env rather than a code change.
 */
export function resolveGogBin(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  home: string = homedir(),
  exists: Exists = existsSync,
): string {
  const override = env['GOG_BIN']?.trim()
  if (override) return override

  return gogCandidates(platform, home).find(exists) ?? bareName(platform)
}
