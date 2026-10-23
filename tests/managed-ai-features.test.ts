/**
 * Features that need a key the client never has: voice, video, and the AI keys
 * themselves. On a managed box none of them may ask for or accept a key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'managed-feat-'))
  process.env['AGENT_STORE_DIR'] = store
  return { store: store as string, runAgent: vi.fn() }
})

vi.mock('../src/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  PRIMARY_CHAT_ID: 'owner',
  PUBLIC_HOSTNAME: 'box.example.com',
}))
vi.mock('../src/agent.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runAgent: h.runAgent,
}))

import { createBot } from '../src/bot.js'
import { initDatabase } from '../src/db.js'
import { voiceCapabilities } from '../src/voice.js'
import { buildVideoMessage, buildAttachmentMessage } from '../src/media.js'
import { SecretFlow } from '../src/secrets/flow.js'
import { SecretVault } from '../src/vault/store.js'
import { MANAGED_AI_FILE } from '../src/ai-limit.js'

const VOICE_OFF = "Voice messages aren't available on this assistant."
const VIDEO_HINT = "Video analysis isn't available on this assistant. Tell the owner that plainly."
const SECRETS_LINE = "This assistant's AI connection is managed for you, so that key can't be changed here."

function harness() {
  const sent: string[] = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons: false,
    maxMessageLength: 4096,
    onMessage: (fn: typeof handler) => {
      handler = fn
    },
    formatText: (s: string) => s,
    splitMessage: (s: string) => [s],
    sendMessage: async (_c: string, t: string) => {
      sent.push(t)
      return String(sent.length)
    },
    editMessage: async () => {},
    deleteMessage: async () => true,
    sendTyping: async () => {},
    clearButtons: async () => {},
    sendFile: async () => {},
  }
  createBot(adapter as never)
  return { sent, send: (m: Record<string, unknown>) => handler({ chatId: 'owner', ...m }) }
}

function markManaged() {
  writeFileSync(join(h.store, MANAGED_AI_FILE), JSON.stringify({ since: '2026-11-01T00:00:00Z' }))
}

describe('managed box: voice, video, secrets', () => {
  beforeEach(() => {
    initDatabase()
    markManaged()
  })
  afterEach(() => {
    rmSync(join(h.store, MANAGED_AI_FILE), { force: true })
  })

  it('reports no speech capability', () => {
    expect(voiceCapabilities()).toEqual({ stt: false, tts: false })
  })

  it('answers a voice note with the voice line only', async () => {
    const t = harness()
    await t.send({ type: 'voice', filePath: '/tmp/x.ogg' })
    expect(t.sent).toEqual([VOICE_OFF])
  })

  it('answers /voice and /voice ui with the voice line, no link, no key names', async () => {
    const t = harness()
    await t.send({ type: 'text', text: '/voice' })
    await t.send({ type: 'text', text: '/voice ui' })
    expect(t.sent).toEqual([VOICE_OFF, VOICE_OFF])
    for (const s of t.sent) expect(s).not.toMatch(/OPENAI_API_KEY|GOOGLE_API_KEY/)
  })

  it('gives the model a plain video hint, with no key name', () => {
    const v = buildVideoMessage('/tmp/a.mp4', 'hi')
    expect(v).toContain(VIDEO_HINT)
    const n = buildAttachmentMessage('video_note', '/tmp/a.mp4')
    expect(n).toContain(VIDEO_HINT)
    expect(v + n).not.toMatch(/GOOGLE_API_KEY/)
  })

  it.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'])('refuses /secret set %s and stores nothing', async (name) => {
    const t = harness()
    await t.send({ type: 'text', text: `/secret set ${name} sk-secret-value-123`, messageId: '9' })
    await t.send({ type: 'text', text: `/secret set ${name}` })
    expect(t.sent).toEqual([SECRETS_LINE, SECRETS_LINE])
  })

  it('SecretFlow stores nothing and refuses a captured value for those names', async () => {
    const dir = require('node:fs').mkdtempSync(join(require('node:os').tmpdir(), 'vault-'))
    const vault = new SecretVault({ dir })
    const flow = new SecretFlow({ vault: () => vault, validate: async () => ({ status: 'ok' }), isManaged: () => true })
    const r = await flow.handleCommand('c', '/secret set openai_api_key abc123')
    expect(r.reply).toBe(SECRETS_LINE)
    expect(vault.list()).toEqual([])
    const other = await flow.handleCommand('c', '/secret set IMAP_PASSWORD_X')
    expect(other.reply).toMatch(/Send the key for IMAP_PASSWORD_X/)
    expect(await flow.capture('c', 'pw')).toMatchObject({ saved: true })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('non-managed box keeps today\'s texts', () => {
  beforeEach(() => {
    initDatabase()
    expect(existsSync(join(h.store, MANAGED_AI_FILE))).toBe(false)
  })

  it('names the key where it is the fix', async () => {
    const t = harness()
    await t.send({ type: 'voice', filePath: '/tmp/x.ogg' })
    expect(t.sent[0]).toBe('Voice transcription is not enabled. Add OPENAI_API_KEY to .env.')
    expect(buildVideoMessage('/tmp/a.mp4')).toContain('GOOGLE_API_KEY')
  })

  it('lets SecretFlow accept the key', async () => {
    const dir = require('node:fs').mkdtempSync(join(require('node:os').tmpdir(), 'vault-'))
    const vault = new SecretVault({ dir })
    const flow = new SecretFlow({ vault: () => vault, validate: async () => ({ status: 'ok' }), isManaged: () => false })
    const r = await flow.handleCommand('c', '/secret set OPENAI_API_KEY abc123')
    expect(r.reply).toMatch(/saved to the encrypted vault/)
    rmSync(dir, { recursive: true, force: true })
  })
})
