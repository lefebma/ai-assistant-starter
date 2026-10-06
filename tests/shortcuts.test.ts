import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// STORE_DIR is read at config import time, so set it before db.js loads.
const STORE = mkdtempSync(join(tmpdir(), 'havn-shortcuts-'))
process.env['AGENT_STORE_DIR'] = STORE

type Tokens = typeof import('../src/shortcut-tokens.js')
type Route = typeof import('../src/shortcut-route.js')
let tokens: Tokens
let route: Route

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  tokens = await import('../src/shortcut-tokens.js')
  route = await import('../src/shortcut-route.js')
})

afterAll(async () => {
  try {
    const { getDb } = await import('../src/db.js')
    getDb().close()
  } catch {
    // no handle to close
  }
  try {
    rmSync(STORE, { recursive: true, force: true })
  } catch {
    // a temp dir is not worth failing over
  }
})

describe('shortcut keys', () => {
  it('answers as the chat that minted it', () => {
    const t = tokens.mintShortcutToken('chat-a')
    expect(t.startsWith('hvs_')).toBe(true)
    expect(tokens.resolveShortcutToken(t)).toBe('chat-a')
  })

  it('stores only a hash, so the database is not a list of working keys', async () => {
    const t = tokens.mintShortcutToken('chat-hash')
    const { getDb } = await import('../src/db.js')
    const row = getDb().prepare('SELECT token_hash FROM shortcut_tokens WHERE chat_id = ?').get('chat-hash') as {
      token_hash: string
    }
    expect(row.token_hash).toBe(tokens.hashShortcutToken(t))
    expect(row.token_hash).not.toContain(t.slice(4))
  })

  it('replaces the old key when a new one is minted', () => {
    const first = tokens.mintShortcutToken('chat-b')
    const second = tokens.mintShortcutToken('chat-b')
    expect(tokens.resolveShortcutToken(first)).toBeNull()
    expect(tokens.resolveShortcutToken(second)).toBe('chat-b')
  })

  it('stops working when revoked', () => {
    const t = tokens.mintShortcutToken('chat-c')
    expect(tokens.revokeShortcutToken('chat-c')).toBe(true)
    expect(tokens.resolveShortcutToken(t)).toBeNull()
    expect(tokens.revokeShortcutToken('chat-c')).toBe(false)
  })

  it('records use, so /shortcut status can say whether the phone ever called', () => {
    const t = tokens.mintShortcutToken('chat-d', 1000)
    expect(tokens.shortcutTokenInfo('chat-d')).toEqual({ createdAt: 1000, lastUsedAt: null })
    tokens.resolveShortcutToken(t, 5000)
    expect(tokens.shortcutTokenInfo('chat-d')?.lastUsedAt).toBe(5000)
  })

  it('refuses anything that is not a shortcut key without touching the database', () => {
    expect(tokens.resolveShortcutToken('')).toBeNull()
    expect(tokens.resolveShortcutToken('some-voice-link-token')).toBeNull()
    expect(tokens.resolveShortcutToken('hvs_never-issued')).toBeNull()
  })
})

describe('reading the question', () => {
  it('takes the text field of a JSON body', () => {
    expect(route.parseShortcutBody('{"text":"  what is on today? "}', 'application/json')).toBe('what is on today?')
  })

  it('takes a plain-text body as the question', () => {
    expect(route.parseShortcutBody('what is on today?', 'text/plain')).toBe('what is on today?')
  })

  it('reads JSON even when Shortcuts labels it something else', () => {
    expect(route.parseShortcutBody('{"text":"hi"}', undefined)).toBe('hi')
  })

  it('refuses JSON with no text field rather than asking the model about braces', () => {
    expect(route.parseShortcutBody('{"question":"hi"}', 'application/json')).toBeNull()
    expect(route.parseShortcutBody('{not json', 'application/json')).toBeNull()
  })
})

describe('shaping a reply for the phone', () => {
  it('passes plain text through untouched', () => {
    expect(route.shapeShortcutReply('Three meetings today.')).toEqual({ phone: 'Three meetings today.', toChat: null })
  })

  it('sends a file to the chat and tells the phone where it went', () => {
    const shaped = route.shapeShortcutReply('Here is the report. [[file: workspace/report.pdf]]')
    expect(shaped.phone).toBe('Here is the report.\n\nI sent the file to your chat.')
    expect(shaped.toChat).toContain('[[file: workspace/report.pdf]]')
  })

  it('never shows a button marker on the phone, and puts the approval in the chat', () => {
    const shaped = route.shapeShortcutReply('Draft ready. [[buttons: Send | Discard]]')
    expect(shaped.phone).not.toContain('[[')
    expect(shaped.phone).toContain('Answer there.')
    expect(shaped.toChat).toBe('Draft ready.')
  })

  it('says something when the reply was only a marker', () => {
    expect(route.shapeShortcutReply('[[file: workspace/a.png]]').phone).toBe('I sent the file to your chat.')
  })
})

describe('POST /api/shortcut', () => {
  type Deps = import('../src/shortcut-route.js').ShortcutDeps
  let server: Server
  let base = ''
  let deps: Deps
  const delivered: { chatId: string; text: string }[] = []

  function defaults(): Deps {
    return {
      resolveToken: (t) => (t === 'hvs_good' ? 'chat-1' : null),
      isChatAllowed: () => true,
      isChatBusy: () => false,
      runTurn: async (_chat, text) => `You said: ${text}`,
      deliverToChat: async (chatId, text) => {
        delivered.push({ chatId, text })
        return true
      },
      waitMs: 2000,
    }
  }

  beforeAll(async () => {
    deps = defaults()
    // Port 0: the OS picks a free one, so this suite claims no band.
    server = createServer((req, res) => void route.handleShortcut(req, res, deps))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shortcut`
  })

  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  function ask(body: string, auth = 'Bearer hvs_good', type = 'application/json') {
    return fetch(base, { method: 'POST', headers: { Authorization: auth, 'Content-Type': type }, body })
  }

  it('answers in plain text, which is what Show Result and Siri can use as is', async () => {
    deps = defaults()
    const res = await ask('{"text":"hello"}')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('You said: hello')
  })

  it('refuses a missing or unknown key with a sentence a person can act on', async () => {
    deps = defaults()
    const res = await ask('{"text":"hello"}', 'Bearer hvs_bad')
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('/shortcut')
    expect((await ask('{"text":"hello"}', '')).status).toBe(401)
  })

  it('refuses a key whose chat has lost access', async () => {
    deps = { ...defaults(), isChatAllowed: () => false }
    expect((await ask('{"text":"hello"}')).status).toBe(403)
  })

  it('will not run beside a turn already going in that chat', async () => {
    let ran = false
    deps = { ...defaults(), isChatBusy: () => true, runTurn: async () => ((ran = true), 'x') }
    const res = await ask('{"text":"hello"}')
    expect(res.status).toBe(409)
    expect(ran).toBe(false)
  })

  it('refuses an empty question and an unreadable body', async () => {
    deps = defaults()
    expect((await ask('{"text":"   "}')).status).toBe(400)
    expect((await ask('{"nope":1}')).status).toBe(400)
  })

  it('refuses a body too large for a shortcut', async () => {
    deps = defaults()
    expect((await ask(JSON.stringify({ text: 'x'.repeat(9000) }))).status).toBe(413)
    expect((await ask('x'.repeat(70 * 1024), 'Bearer hvs_good', 'text/plain')).status).toBe(413)
  })

  it('hands a slow answer to the chat instead of letting the phone time out', async () => {
    delivered.length = 0
    let finish: (v: string) => void = () => {}
    deps = { ...defaults(), waitMs: 50, runTurn: () => new Promise<string>((r) => (finish = r)) }
    const res = await ask('{"text":"plan my week"}')
    expect(res.status).toBe(202)
    expect(await res.text()).toContain('send the answer to your chat')
    finish('Monday is clear.')
    await new Promise((r) => setTimeout(r, 20))
    expect(delivered).toEqual([{ chatId: 'chat-1', text: 'From your shortcut: "plan my week"\n\nMonday is clear.' }])
  })

  it('tells the chat when a handed-off turn fails, rather than going quiet', async () => {
    delivered.length = 0
    let fail: (e: Error) => void = () => {}
    deps = { ...defaults(), waitMs: 50, runTurn: () => new Promise<string>((_r, j) => (fail = j)) }
    expect((await ask('{"text":"x"}')).status).toBe(202)
    fail(new Error('boom'))
    await new Promise((r) => setTimeout(r, 20))
    expect(delivered[0]?.text).toContain('failed on my side')
  })

  it('answers 500 in words when the turn fails while the phone is still waiting', async () => {
    deps = { ...defaults(), runTurn: async () => { throw new Error('boom') } }
    const res = await ask('{"text":"x"}')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('went wrong')
  })

  it('still delivers to the chat when the phone hangs up before the budget', async () => {
    delivered.length = 0
    let finish: (v: string) => void = () => {}
    deps = { ...defaults(), waitMs: 5000, runTurn: () => new Promise<string>((r) => (finish = r)) }
    const ac = new AbortController()
    const pending = fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer hvs_good', 'Content-Type': 'application/json' },
      body: '{"text":"long one"}',
      signal: ac.signal,
    }).catch(() => null)
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    await pending
    await new Promise((r) => setTimeout(r, 50))
    finish('Done after all.')
    await new Promise((r) => setTimeout(r, 20))
    expect(delivered.map((d) => d.text)).toEqual(['From your shortcut: "long one"\n\nDone after all.'])
  })

  it('sends a file reply to the chat and tells the phone', async () => {
    delivered.length = 0
    deps = { ...defaults(), runTurn: async () => 'Chart attached. [[file: workspace/c.png]]' }
    const res = await ask('{"text":"chart"}')
    expect(await res.text()).toBe('Chart attached.\n\nI sent the file to your chat.')
    await new Promise((r) => setTimeout(r, 20))
    expect(delivered[0]?.text).toContain('[[file: workspace/c.png]]')
  })
})

describe('wiring', () => {
  const REPO = join(__dirname, '..')
  const http = readFileSync(join(REPO, 'src', 'http-server.ts'), 'utf-8')

  it('routes /api/shortcut to its own key, not the box token or a voice link', () => {
    const block = http.slice(http.indexOf("url.pathname === '/api/shortcut'"))
    expect(block.slice(0, 600)).toContain('resolveToken: resolveShortcutToken')
    expect(block.slice(0, 600)).not.toContain('requireAuth(req')
  })

  it('hands a slow voice answer to the chat that asked, not always the primary', () => {
    expect(http).toContain('const target = auth.chatId ?? PRIMARY_CHAT_ID')
  })
})

describe('/shortcut setup', () => {
  it('points a box with an edge at its public https address', async () => {
    const { shortcutUrl } = await import('../src/shortcut-setup.js')
    expect(shortcutUrl('havn.example.com', 3030, '192.168.1.5')).toEqual({
      url: 'https://havn.example.com/api/shortcut',
      reach: 'public',
    })
  })

  it('points a box without one at its LAN address, and says it only works at home', async () => {
    const { shortcutUrl, shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    expect(shortcutUrl('', 3030, '192.168.1.5')).toEqual({ url: 'http://192.168.1.5:3030/api/shortcut', reach: 'lan' })
    expect(shortcutSetupMessage('lan', 20, true)).toContain('same Wi-Fi')
    expect(shortcutSetupMessage('public', 20, true)).not.toContain('same Wi-Fi')
  })

  it('has nothing to offer when there is no address at all', async () => {
    const { shortcutUrl } = await import('../src/shortcut-setup.js')
    expect(shortcutUrl('', 3030, null)).toBeNull()
  })

  it('names the wait the box actually uses', async () => {
    const { shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    expect(shortcutSetupMessage('public', 20, true)).toContain('about 20 seconds')
  })

  it('contains no em dashes', async () => {
    const { shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    expect(shortcutSetupMessage('lan', 20, true)).not.toContain('—')
  })

  it('falls back to building it by hand when the file did not send', async () => {
    const { shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    const msg = shortcutSetupMessage('public', 20, false)
    expect(msg).not.toContain('file above')
    expect(msg).toContain('Get Contents of URL')
  })

  it('asks for the key before the address, the order the file asks in', async () => {
    const { shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    const msg = shortcutSetupMessage('public', 20, true)
    expect(msg.indexOf('paste the key')).toBeLessThan(msg.indexOf('then the address'))
  })

  it('ships the signed shortcut the command sends', async () => {
    const { SHORTCUT_TEMPLATE } = await import('../src/shortcut-setup.js')
    const bytes = readFileSync(join(__dirname, '..', SHORTCUT_TEMPLATE))
    // Signed shortcuts are Apple Encrypted Archives; an unsigned plist starts
    // with "bplist" and iOS refuses to import it.
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('AEA1')
  })

  it('is called Ask Haven, because that is what Siri hears when you say Havn', async () => {
    const { SHORTCUT_TEMPLATE, shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    expect(SHORTCUT_TEMPLATE).toMatch(/Ask Haven\.shortcut$/)
    for (const withFile of [true, false]) {
      const msg = shortcutSetupMessage('public', 20, withFile)
      expect(msg).not.toContain('Ask Havn')
      expect(msg).toContain('Hey Siri, Ask Haven" and nothing else')
    }
  })
})

describe('shortcut keys stay out of group chats', () => {
  const REPO = join(__dirname, '..')

  it('reads a Teams personal chat as private, and a group chat, a channel or no type as not', async () => {
    const { mapInbound } = await import('../src/platform/teams/activities.js')
    const act = (conversationType?: string) => ({
      type: 'message',
      id: 'm1',
      text: '/shortcut',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'u1', name: 'Owner' },
      recipient: { id: 'bot', name: 'Bot' },
      conversation: { id: 'c1', tenantId: 't1', ...(conversationType ? { conversationType } : {}) },
    })
    const priv = (t?: string) => {
      const m = mapInbound(act(t) as never, 'bot')
      return m.kind === 'message' ? m.message.isPrivate : 'not a message'
    }
    expect(priv('personal')).toBe(true)
    expect(priv('groupChat')).toBe(false)
    expect(priv('channel')).toBe(false)
    expect(priv(undefined)).toBe(false)
  })

  it('marks Telegram private chats and Slack DMs, at every place a message is built', () => {
    const tg = readFileSync(join(REPO, 'src', 'platform', 'telegram.ts'), 'utf-8')
    const sites = (tg.match(/chatId: String\(ctx\.chat\??\.id/g) ?? []).length
    expect(sites).toBeGreaterThan(0)
    expect((tg.match(/isPrivate: ctx\.chat\??\.type === 'private'/g) ?? []).length).toBe(sites)
    const slack = readFileSync(join(REPO, 'src', 'platform', 'slack.ts'), 'utf-8')
    expect(slack).toContain("const isPrivate = message.channel_type === 'im'")
  })

  it('refuses /shortcut anywhere that is not known to be one-to-one', () => {
    const bot = readFileSync(join(REPO, 'src', 'bot.ts'), 'utf-8')
    const fn = bot.slice(bot.indexOf('async function handleShortcutCommand(')).slice(0, 900)
    // Before anything else, status and revoke included: unknown is a group.
    expect(fn).toMatch(/if \(isPrivate !== true\) \{[\s\S]*?return\s*\}\s*const action/)
    expect(bot).toContain('handleShortcutCommand(adapter, chatId, trimmed, msg.isPrivate)')
  })
})

describe('/shortcut status wording', () => {
  // 2026-10-06 00:45 UTC is 8:45 PM on Oct 5 in Toronto: the exact case that
  // read as "made 2026-10-06 00:38 UTC" and made the owner do the arithmetic.
  const TZ = 'America/Toronto'
  const now = Date.UTC(2026, 9, 6, 0, 52)

  it('answers whether it works and when it last got through, in the owner\'s time', async () => {
    const { describeShortcutKey } = await import('../src/shortcut-setup.js')
    const msg = describeShortcutKey({ createdAt: Date.UTC(2026, 9, 6, 0, 38), lastUsedAt: Date.UTC(2026, 9, 6, 0, 45) }, now, TZ)
    expect(msg).toBe('Your shortcut key is active. You set it up today at 8:38 PM, and it last got through 7 minutes ago.')
    expect(msg).not.toContain('UTC')
  })

  it('says plainly when it has never been used, or does not exist', async () => {
    const { describeShortcutKey } = await import('../src/shortcut-setup.js')
    expect(describeShortcutKey({ createdAt: now - 60_000, lastUsedAt: null }, now, TZ)).toContain('has not been used yet')
    expect(describeShortcutKey(null, now, TZ)).toBe('You do not have a shortcut key. Send /shortcut to set one up.')
  })

  it('falls back to yesterday and a date for older times', async () => {
    const { whenWords } = await import('../src/shortcut-setup.js')
    expect(whenWords(Date.UTC(2026, 9, 4, 13, 5), now, TZ, true)).toBe('yesterday at 9:05 AM')
    expect(whenWords(Date.UTC(2026, 9, 3, 18, 10), now, TZ)).toBe('on Oct 3 at 2:10 PM')
    expect(whenWords(now - 20_000, now, TZ, true)).toBe('just now')
  })
})

describe('the shortcut is named after the assistant', () => {
  const personality = (n: string) => `# Personality\n\nYour name is ${n}. You're not just an assistant, you're Marina's digital right hand.`

  it('reads the name setup wrote, preferring PERSONALITY.md over the CLAUDE.md heading', async () => {
    const { assistantName } = await import('../src/shortcut-setup.js')
    expect(assistantName(personality('Joy'), '# Joy\n')).toBe('Joy')
    expect(assistantName(personality('Joy'), '# Old Name\n')).toBe('Joy')
    expect(assistantName(null, '# Nami\n\nYou are...')).toBe('Nami')
    expect(assistantName('no name sentence here', '# Ocean Bot\n')).toBe('Ocean Bot')
  })

  it('ignores a placeholder, markup, or anything that would make a bad file name', async () => {
    const { assistantName } = await import('../src/shortcut-setup.js')
    expect(assistantName(personality('{{ASSISTANT_NAME}}'), '# {{ASSISTANT_NAME}}')).toBeNull()
    expect(assistantName(personality('**Joy**'), null)).toBe('Joy')
    expect(assistantName(personality('Joy/../../etc'), null)).toBeNull()
    expect(assistantName(personality('A name far too long to say to Siri comfortably'), null)).toBeNull()
    expect(assistantName(null, null)).toBeNull()
  })

  it('says Havn the way Siri hears it, and falls back to Haven', async () => {
    const { spokenShortcutName } = await import('../src/shortcut-setup.js')
    expect(spokenShortcutName('Joy')).toBe('Joy')
    expect(spokenShortcutName('Havn')).toBe('Haven')
    expect(spokenShortcutName(null)).toBe('Haven')
  })

  it('names the file, and every Siri instruction, after the assistant', async () => {
    const { shortcutFileName, shortcutSetupMessage } = await import('../src/shortcut-setup.js')
    expect(shortcutFileName('Joy')).toBe('Ask Joy.shortcut')
    for (const withFile of [true, false]) {
      const msg = shortcutSetupMessage('public', 20, withFile, 'Joy')
      expect(msg).toContain('"Hey Siri, Ask Joy" and nothing else')
      expect(msg).not.toContain('Haven')
    }
    expect(shortcutSetupMessage('public', 20, true, 'Joy')).toContain('open the "Ask Joy" file above')
  })

  it('sends a renamed copy of the signed template, not the template itself', () => {
    const bot = readFileSync(join(__dirname, '..', 'src', 'bot.ts'), 'utf-8')
    const fn = bot.slice(bot.indexOf('async function handleShortcutCommand(')).slice(0, 3000)
    expect(fn).toContain('copyFileSync(template, named)')
    expect(fn).toContain("adapter.sendFile(chatId, named, 'document')")
  })
})
