/**
 * tests/teams-files.test.ts
 *
 * Sending a file into Teams, which until now printed "not supported yet" and
 * left the file on the box. Two paths with different failure modes:
 *
 *   An image rides inside the message as a base64 data URI. The things worth
 *   pinning are the boundary (1 MB, Microsoft's documented ceiling) and the
 *   formats Teams actually renders, because the failure is a broken image in
 *   someone's chat rather than an error anyone sees.
 *
 *   Everything else asks permission, then uploads to a URL that arrives in
 *   the reply. That makes the consent handler the one place in this adapter
 *   where a remote value decides where a local file is written, so most of
 *   these tests are about refusing to do that wrong: no upload off a
 *   non-OneDrive host, no bot token attached, no second upload from a
 *   re-clicked card, no upload for a chat we would not act for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-files`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import { TeamsAdapter, MAX_PENDING_UPLOADS, PENDING_UPLOAD_TTL_MS } from '../src/platform/teams/adapter.js'
import {
  FILE_CONSENT_CARD,
  FILE_INFO_CARD,
  INLINE_IMAGE_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  contentTypeFor,
  decideDelivery,
  isOneDriveUploadHost,
  uploadHeaders,
} from '../src/platform/teams/files.js'
import { putFileBytes, UploadError } from '../src/platform/teams/upload.js'
import { mapInbound } from '../src/platform/teams/activities.js'
import type { Activity } from '../src/platform/teams/types.js'

const APP_ID = '11111111-2222-3333-4444-555555555555'
const BOT_ID = `28:${APP_ID}`
const CHAT = 'a:1conv'
const UPLOAD_URL = 'https://contoso.sharepoint.com/personal/sam/_api/v2.0/drive/items/01ABC/uploadSession?guid=x'

type Sent = { activity: Record<string, unknown> }

function harness(extra: Record<string, unknown> = {}) {
  const sent: Sent[] = []
  const uploads: Array<{ url: string; bytes: Buffer }> = []
  const adapter = new TeamsAdapter({
    appId: APP_ID,
    appSecret: 'secret',
    validator: { validate: async () => true },
    connector: {
      sendActivity: async (_ref: unknown, activity: unknown) => {
        sent.push({ activity: activity as Record<string, unknown> })
        return `sent-${sent.length}`
      },
      updateActivity: async () => {},
      deleteActivity: async () => {},
      sendTyping: async () => {},
    },
    registerRoute: () => () => {},
    isAuthorizedChat: () => true,
    upload: async (url: string, bytes: Buffer) => {
      uploads.push({ url, bytes })
    },
    ...extra,
  })
  return { adapter, sent, uploads }
}

function activity(overrides: Partial<Activity>): Activity {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
    from: { id: '29:1abc', aadObjectId: 'aad-sam' },
    recipient: { id: BOT_ID },
    conversation: { id: CHAT, tenantId: 't1' },
    ...overrides,
  }
}

/** A real one-pixel PNG, so content sniffing and base64 round-trips are honest. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teams-files-'))
})

/** Establish the conversation reference an outbound send needs. */
async function connect(adapter: TeamsAdapter): Promise<void> {
  await adapter.processActivity(activity({ text: 'hello' }))
}

describe('which path a file takes', () => {
  it('reads a content type off the extension, and shrugs at unknown ones', () => {
    expect(contentTypeFor('/tmp/shot.png')).toBe('image/png')
    expect(contentTypeFor('/tmp/SHOT.JPEG')).toBe('image/jpeg')
    expect(contentTypeFor('/tmp/report.pdf')).toBe('application/pdf')
    expect(contentTypeFor('/tmp/mystery.qqq')).toBe('application/octet-stream')
  })

  it('inlines a small png, jpeg or gif', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif']) {
      expect(decideDelivery(50_000, type)).toEqual({ kind: 'inline', contentType: type })
    }
  })

  it('asks permission at exactly one byte over the inline ceiling', () => {
    expect(decideDelivery(INLINE_IMAGE_MAX_BYTES, 'image/png')).toEqual({ kind: 'inline', contentType: 'image/png' })
    expect(decideDelivery(INLINE_IMAGE_MAX_BYTES + 1, 'image/png')).toEqual({ kind: 'consent' })
  })

  it('does not inline webp, which Teams will not render', () => {
    // Screenshot tools emit webp happily; inlining it would put a broken
    // image in the chat with no error anywhere.
    expect(decideDelivery(20_000, 'image/webp')).toEqual({ kind: 'consent' })
  })

  it('refuses an empty file and anything over the upload cap', () => {
    expect(decideDelivery(0, 'application/pdf').kind).toBe('refuse')
    expect(decideDelivery(UPLOAD_MAX_BYTES + 1, 'application/pdf').kind).toBe('refuse')
    expect(decideDelivery(UPLOAD_MAX_BYTES, 'application/pdf')).toEqual({ kind: 'consent' })
  })
})

describe('sending an image', () => {
  it('puts a small png in the message as a data URI', async () => {
    const { adapter, sent } = harness()
    await connect(adapter)
    const file = join(dir, 'screenshot.png')
    writeFileSync(file, PNG_1PX)

    await adapter.sendFile(CHAT, file, 'photo')

    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, string>>)[0]
    expect(att.contentType).toBe('image/png')
    expect(att.name).toBe('screenshot.png')
    expect(att.contentUrl).toBe(`data:image/png;base64,${PNG_1PX.toString('base64')}`)
    // No consent card: an image the owner can simply see should not make them
    // click Allow first.
    expect(JSON.stringify(sent)).not.toContain(FILE_CONSENT_CARD)
  })

  it('falls back to asking when the image is too big to inline', async () => {
    const { adapter, sent } = harness()
    await connect(adapter)
    const file = join(dir, 'huge.png')
    writeFileSync(file, Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1, 7))

    await adapter.sendFile(CHAT, file, 'photo')

    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
    expect(att.contentType).toBe(FILE_CONSENT_CARD)
    expect(att.name).toBe('huge.png')
    const content = att.content as { sizeInBytes: number; description: string; acceptContext: { pendingId: string } }
    expect(content.sizeInBytes).toBe(INLINE_IMAGE_MAX_BYTES + 1)
    expect(content.acceptContext.pendingId).toMatch(/[0-9a-f-]{36}/)
    expect(content.description).toContain('too large to show in the chat')
  })

  it('says so, and says where the file is, when it will not send at all', async () => {
    const { adapter, sent } = harness()
    await connect(adapter)
    const file = join(dir, 'enormous.pdf')
    writeFileSync(file, Buffer.alloc(UPLOAD_MAX_BYTES + 1))

    await adapter.sendFile(CHAT, file, 'document')

    const text = String(sent.at(-1)!.activity.text)
    expect(text).toContain('enormous.pdf')
    expect(text).toContain(file)
    expect(JSON.stringify(sent)).not.toContain(FILE_CONSENT_CARD)
  })

  it('reports a file it cannot read instead of throwing', async () => {
    const { adapter, sent } = harness()
    await connect(adapter)
    await adapter.sendFile(CHAT, join(dir, 'never-existed.pdf'), 'document')
    expect(String(sent.at(-1)!.activity.text)).toContain('could not read never-existed.pdf')
  })
})

describe('the consent reply', () => {
  const consentInvoke = (pendingId: string | null, action: 'accept' | 'decline', uploadUrl = UPLOAD_URL): Activity =>
    activity({
      type: 'invoke',
      name: 'fileConsent/invoke',
      value: {
        type: 'fileUpload',
        action,
        ...(pendingId ? { context: { pendingId } } : {}),
        ...(action === 'accept'
          ? { uploadInfo: { name: 'report.pdf', uploadUrl, contentUrl: 'https://contoso.sharepoint.com/x/report.pdf', uniqueId: 'u-1', fileType: 'pdf' } }
          : {}),
      },
    })

  async function offer(adapter: TeamsAdapter, sent: Sent[], name = 'report.pdf'): Promise<string> {
    const file = join(dir, name)
    writeFileSync(file, Buffer.from('%PDF-1.4 pretend'))
    await adapter.sendFile(CHAT, file, 'document')
    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
    return (att.content as { acceptContext: { pendingId: string } }).acceptContext.pendingId
  }

  it('maps the invoke into a decision, an id and an upload target', () => {
    const mapped = mapInbound(consentInvoke('p-1', 'accept'), BOT_ID)
    expect(mapped).toMatchObject({
      kind: 'file-consent',
      chatId: CHAT,
      decision: 'accept',
      pendingId: 'p-1',
      uploadInfo: { uploadUrl: UPLOAD_URL, fileType: 'pdf' },
    })
  })

  it('treats anything that is not an explicit accept as a decline', () => {
    const weird = activity({ type: 'invoke', name: 'fileConsent/invoke', value: { action: 'something-else' } })
    expect(mapInbound(weird, BOT_ID)).toMatchObject({ kind: 'file-consent', decision: 'decline' })
  })

  it('uploads on accept, then shows the file card', async () => {
    const { adapter, sent, uploads } = harness()
    await connect(adapter)
    const pendingId = await offer(adapter, sent)

    await adapter.processActivity(consentInvoke(pendingId, 'accept'))

    expect(uploads).toHaveLength(1)
    expect(uploads[0].url).toBe(UPLOAD_URL)
    expect(uploads[0].bytes.toString()).toBe('%PDF-1.4 pretend')
    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
    expect(att.contentType).toBe(FILE_INFO_CARD)
    expect(att.name).toBe('report.pdf')
    expect(att.content).toEqual({ uniqueId: 'u-1', fileType: 'pdf' })
    expect(String(sent.at(-1)!.activity.text)).toContain('in your OneDrive')
  })

  it('uploads once, however many times the card is clicked', async () => {
    // Teams leaves the card in the chat and will send a second invoke, but an
    // upload URL is single-use, so the second attempt would fail in a way
    // that reads like the file never sent.
    const { adapter, sent, uploads } = harness()
    await connect(adapter)
    const pendingId = await offer(adapter, sent)

    await adapter.processActivity(consentInvoke(pendingId, 'accept'))
    await adapter.processActivity(consentInvoke(pendingId, 'accept'))

    expect(uploads).toHaveLength(1)
    expect(String(sent.at(-1)!.activity.text)).toContain('no longer waiting')
  })

  it('does not upload on decline, and says where the file still is', async () => {
    const { adapter, sent, uploads } = harness()
    await connect(adapter)
    const pendingId = await offer(adapter, sent)

    await adapter.processActivity(consentInvoke(pendingId, 'decline'))

    expect(uploads).toEqual([])
    expect(String(sent.at(-1)!.activity.text)).toContain('Not sent')
  })

  it('does not upload for a chat it would not act for', async () => {
    const { adapter, sent, uploads } = harness({ isAuthorizedChat: () => false })
    await connect(adapter)
    // Offer the file while unauthorized too: what matters is that the accept
    // never reaches the upload.
    const file = join(dir, 'secret.pdf')
    writeFileSync(file, Buffer.from('x'))
    await adapter.sendFile(CHAT, file, 'document')
    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
    const pendingId = (att.content as { acceptContext: { pendingId: string } }).acceptContext.pendingId

    await adapter.processActivity(consentInvoke(pendingId, 'accept'))

    expect(uploads).toEqual([])
  })

  it('reports an accept that arrives with no upload address', async () => {
    const { adapter, sent, uploads } = harness()
    await connect(adapter)
    const pendingId = await offer(adapter, sent)

    const noUrl = activity({
      type: 'invoke',
      name: 'fileConsent/invoke',
      value: { action: 'accept', context: { pendingId }, uploadInfo: { name: 'report.pdf' } },
    })
    await adapter.processActivity(noUrl)

    expect(uploads).toEqual([])
    expect(String(sent.at(-1)!.activity.text)).toContain('did not say where to put it')
  })

  it('reports a file that vanished between the offer and the click', async () => {
    const { adapter, sent, uploads } = harness()
    await connect(adapter)
    const pendingId = await offer(adapter, sent, 'temporary.pdf')
    unlinkSync(join(dir, 'temporary.pdf'))

    await adapter.processActivity(consentInvoke(pendingId, 'accept'))

    expect(uploads).toEqual([])
    expect(String(sent.at(-1)!.activity.text)).toContain('no longer on the assistant')
  })

  it('passes an upload failure on in plain words', async () => {
    const { adapter, sent } = harness({
      upload: async () => {
        throw new UploadError(507, 'OneDrive upload failed: 507')
      },
    })
    await connect(adapter)
    const pendingId = await offer(adapter, sent)

    await adapter.processActivity(consentInvoke(pendingId, 'accept'))

    expect(String(sent.at(-1)!.activity.text)).toContain('507')
  })
})

describe('where we are willing to put a file', () => {
  it('accepts OneDrive for Business hosts over https', () => {
    expect(isOneDriveUploadHost(UPLOAD_URL)).toBe(true)
    expect(isOneDriveUploadHost('https://contoso-my.sharepoint.com/personal/x')).toBe(true)
  })

  it('refuses everything else, including plain http and lookalike hosts', () => {
    for (const url of [
      'http://contoso.sharepoint.com/x',
      'https://sharepoint.com.evil.example/x',
      'https://evil.example/upload',
      'https://smba.trafficmanager.net/amer/upload',
      'not a url',
      '',
    ]) {
      expect(isOneDriveUploadHost(url)).toBe(false)
    }
  })

  it('refuses to upload to a host outside OneDrive, before any request leaves', async () => {
    const calls: string[] = []
    await expect(
      putFileBytes('https://evil.example/upload', Buffer.from('x'), async (url) => {
        calls.push(url)
        return new Response('', { status: 200 })
      })
    ).rejects.toThrow(/not a OneDrive host/)
    expect(calls).toEqual([])
  })

  it('sends the bytes with a content range, and no Authorization header', async () => {
    // The upload URL is pre-authorized. A bearer token here would be a
    // credential handed to a host outside the Bot Framework for no gain.
    let seen: RequestInit | undefined
    await putFileBytes(UPLOAD_URL, Buffer.from('hello'), async (_url, init) => {
      seen = init
      return new Response('', { status: 201 })
    })
    expect(seen?.method).toBe('PUT')
    const headers = seen?.headers as Record<string, string>
    expect(headers).toEqual(uploadHeaders(5))
    expect(headers['Content-Range']).toBe('bytes 0-4/5')
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('treats a non-2xx upload as a failure', async () => {
    await expect(
      putFileBytes(UPLOAD_URL, Buffer.from('x'), async () => new Response('nope', { status: 403 }))
    ).rejects.toThrow(UploadError)
  })
})

describe('files waiting on an answer', () => {
  it('forgets the oldest once too many are waiting', async () => {
    const { adapter, sent } = harness()
    await connect(adapter)
    const ids: string[] = []
    for (let i = 0; i < MAX_PENDING_UPLOADS + 3; i++) {
      const file = join(dir, `f${i}.pdf`)
      writeFileSync(file, Buffer.from(`file ${i}`))
      await adapter.sendFile(CHAT, file, 'document')
      const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
      ids.push((att.content as { acceptContext: { pendingId: string } }).acceptContext.pendingId)
    }

    const stale = activity({
      type: 'invoke',
      name: 'fileConsent/invoke',
      value: { action: 'accept', context: { pendingId: ids[0] }, uploadInfo: { name: 'f0.pdf', uploadUrl: UPLOAD_URL } },
    })
    await adapter.processActivity(stale)
    expect(String(sent.at(-1)!.activity.text)).toContain('no longer waiting')
  })

  it('forgets a card nobody answered for a day', async () => {
    let clock = 1_000_000
    const { adapter, sent, uploads } = harness({ now: () => clock })
    await connect(adapter)
    const file = join(dir, 'yesterday.pdf')
    writeFileSync(file, Buffer.from('old'))
    await adapter.sendFile(CHAT, file, 'document')
    const att = (sent.at(-1)!.activity.attachments as Array<Record<string, unknown>>)[0]
    const pendingId = (att.content as { acceptContext: { pendingId: string } }).acceptContext.pendingId

    // The sweep runs when the next card is remembered, which is the only
    // moment anything here gets a chance to notice time passing.
    clock += PENDING_UPLOAD_TTL_MS + 1
    const other = join(dir, 'today.pdf')
    writeFileSync(other, Buffer.from('new'))
    await adapter.sendFile(CHAT, other, 'document')

    await adapter.processActivity(
      activity({
        type: 'invoke',
        name: 'fileConsent/invoke',
        value: { action: 'accept', context: { pendingId }, uploadInfo: { name: 'yesterday.pdf', uploadUrl: UPLOAD_URL } },
      })
    )
    expect(uploads).toEqual([])
    expect(String(sent.at(-1)!.activity.text)).toContain('no longer waiting')
  })
})
