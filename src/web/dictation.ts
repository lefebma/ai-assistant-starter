/**
 * Dictation from the chat box's microphone (card #252).
 *
 * The box transcribes when it can, with the same engine Telegram voice notes
 * use. When it cannot (no OpenAI key, or a managed-AI box), the page falls
 * back to the browser's own speech recognition, and hides the microphone when
 * neither is there. `/api/web/me` carries the flag, so the page learns which
 * path to use from a call it already makes.
 */
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { transcribeAudio, voiceCapabilities } from '../voice.js'

/**
 * The upload cap. Two minutes of speech is about 1 MB at the 64 kbps the page
 * asks for, and about 2 MB at the 128 kbps some browsers use anyway, so this
 * leaves room without letting the route take an arbitrary file.
 */
export const MAX_DICTATION_BYTES = 6 * 1024 * 1024

/** The page stops recording here. The byte cap is the server's guard. */
export const MAX_DICTATION_SECONDS = 120

export interface DictationDeps {
  /** Whether this box can turn speech into text. */
  canTranscribe(): boolean
  transcribe(path: string): Promise<string>
  /** Where a recording waits while it is transcribed. Deleted straight after. */
  tmpDir: string
}

const realDeps: DictationDeps = {
  canTranscribe: () => voiceCapabilities().stt,
  transcribe: (path) => transcribeAudio(path),
  tmpDir: join(STORE_DIR, 'dictation-tmp'),
}

let current: DictationDeps = realDeps

export function dictationDeps(): DictationDeps {
  return current
}

/** Test hook: stub the engine so no paid call is made. Pass null to restore. */
export function setDictationDepsForTest(deps: DictationDeps | null): void {
  current = deps ?? realDeps
}
