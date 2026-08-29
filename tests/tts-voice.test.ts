import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The TTS voice was hardcoded in engine code until 2026-08-29. A pilot box had
 * been patched in place to speak as "nova", so the next update would have
 * quietly changed the assistant's voice back to the default. It belongs in
 * .env, where PRESERVED_PATHS keeps it across updates.
 */

const envFile: Record<string, string> = {}

vi.mock('../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/env.js')>()
  return { ...actual, readEnvFile: () => envFile }
})

async function loadVoice(): Promise<string> {
  vi.resetModules()
  const mod = await import('../src/config.js')
  return mod.TTS_VOICE
}

describe('TTS_VOICE', () => {
  beforeEach(() => {
    for (const k of Object.keys(envFile)) delete envFile[k]
  })

  it('defaults to fable when unset', async () => {
    expect(await loadVoice()).toBe('fable')
  })

  it('takes the configured voice, so a per-install choice survives updates', async () => {
    envFile['TTS_VOICE'] = 'nova'
    expect(await loadVoice()).toBe('nova')
  })

  it('falls back rather than sending an empty voice to the API', async () => {
    envFile['TTS_VOICE'] = '   '
    expect(await loadVoice()).toBe('fable')
  })
})
