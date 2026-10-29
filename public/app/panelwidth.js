// Width of the files panel on the right: limits, the saved value and the
// pointer maths. Pure, no DOM, so tests can import it.

export const DEFAULT_WIDTH = 340
export const MIN_WIDTH = 240
export const MAX_WIDTH = 720
export const LEFT_WIDTH = 288
export const MIN_CHAT = 360
export const STEP = 16
export const STORAGE_KEY = 'files-panel-width'

/** Keep a width between the minimum and maximum and leave the chat room. */
export function clampWidth(width, windowWidth) {
  const n = Number(width)
  if (!Number.isFinite(n)) return DEFAULT_WIDTH
  const room = Number.isFinite(windowWidth) ? windowWidth - LEFT_WIDTH - MIN_CHAT : MAX_WIDTH
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room))
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, n)))
}

/** The panel sits on the right edge, so its width is the pointer's distance from it. */
export function widthFromPointer(clientX, windowWidth) {
  return windowWidth - clientX
}

export function loadWidth(storage, windowWidth) {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined || raw === '') return DEFAULT_WIDTH
    return clampWidth(Number(raw), windowWidth)
  } catch {
    return DEFAULT_WIDTH
  }
}

export function saveWidth(storage, width) {
  try { storage.setItem(STORAGE_KEY, String(Math.round(width))) } catch { /* private mode */ }
}

export function clearWidth(storage) {
  try { storage.removeItem(STORAGE_KEY) } catch { /* private mode */ }
}
