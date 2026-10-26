// What the update notice says, read from /api/web/status. Shared by the
// banner, the update icon by the Settings link, and the Settings update
// section, so all three agree. Pure, no DOM, so tests can import it.

export const RESTART_TEXT = 'An update is installed and starts on the next restart.'

/**
 * available: a newer version is waiting (the icon shows, dismissed or not).
 * text: what to tell the user, or '' when there is nothing to say.
 */
export function updateInfo(s) {
  if (!s) return { available: false, text: '' }
  if (s.updateAvailable && s.latestVersion) {
    return { available: true, text: 'Version ' + s.latestVersion + ' is available. Send /update to install it.' }
  }
  if (s.restartPending) return { available: false, text: RESTART_TEXT }
  return { available: false, text: '' }
}
