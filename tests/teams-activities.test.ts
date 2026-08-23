import { describe, it, expect } from 'vitest'
import {
  mapInbound,
  referenceFrom,
  formatForTeams,
  buildCardActivity,
  buildTextActivity,
  buildTypingActivity,
  isMicrosoftAttachmentHost,
} from '../src/platform/teams/activities.js'
import type { Activity } from '../src/platform/teams/types.js'

const BOT_ID = '28:11111111-2222-3333-4444-555555555555'

function activity(overrides: Partial<Activity>): Activity {
  return {
    type: 'message',
    id: '1724400000001',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
    from: { id: '29:1abc', name: 'Marc', aadObjectId: 'aad-marc' },
    recipient: { id: BOT_ID, name: 'Nami' },
    conversation: { id: 'a:1conv', tenantId: 'tenant-1', conversationType: 'personal' },
    ...overrides,
  }
}

describe('referenceFrom', () => {
  it('captures everything a proactive reply needs', () => {
    expect(referenceFrom(activity({}))).toEqual({
      conversationId: 'a:1conv',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botId: BOT_ID,
      userId: 'aad-marc',
      tenantId: 'tenant-1',
    })
  })

  it('falls back to from.id when there is no AAD object id', () => {
    expect(referenceFrom(activity({ from: { id: '29:1abc' } }))?.userId).toBe('29:1abc')
  })

  it('returns null without a conversation or serviceUrl', () => {
    expect(referenceFrom(activity({ conversation: undefined }))).toBeNull()
    expect(referenceFrom(activity({ serviceUrl: undefined }))).toBeNull()
  })
})

describe('mapInbound', () => {
  it('maps a text message, trimming the @mention Teams prepends', () => {
    const m = mapInbound(activity({ text: '<at>Nami</at> hello there' }), BOT_ID)
    expect(m.kind).toBe('message')
    if (m.kind !== 'message') return
    expect(m.message).toEqual({
      chatId: 'a:1conv',
      userId: 'aad-marc',
      text: 'hello there',
      type: 'text',
      messageId: '1724400000001',
      updateId: '1724400000001',
    })
  })

  it('keeps newlines and list structure in multi-line messages', () => {
    const m = mapInbound(activity({ text: '<at>Nami</at> line one\nline two\n\n- bullet\n- bullet2' }), BOT_ID)
    expect(m.kind).toBe('message')
    if (m.kind !== 'message') return
    expect(m.message.text).toBe('line one\nline two\n\n- bullet\n- bullet2')
  })

  it('maps a messageBack button click to the callback shape the bot already handles', () => {
    const m = mapInbound(
      activity({ text: 'Send', value: { btn: 'Send' }, replyToId: '1724400000000' }),
      BOT_ID
    )
    expect(m.kind).toBe('message')
    if (m.kind !== 'message') return
    expect(m.message.type).toBe('callback')
    expect(m.message.callbackData).toBe('btn:Send')
    expect(m.message.messageId).toBe('1724400000000')
  })

  it('maps a Teams file attachment to a document download with a pre-authorised url', () => {
    const m = mapInbound(
      activity({
        text: 'here is the contract',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.file.download.info',
            name: 'contract.pdf',
            content: { downloadUrl: 'https://files.example/contract.pdf?sig=abc', fileType: 'pdf' },
          },
        ],
      }),
      BOT_ID
    )
    expect(m.kind).toBe('attachment')
    if (m.kind !== 'attachment') return
    expect(m.download).toEqual({
      url: 'https://files.example/contract.pdf?sig=abc',
      name: 'contract.pdf',
      needsAuth: false,
      kind: 'document',
    })
    expect(m.base.type).toBe('document')
    expect(m.base.caption).toBe('here is the contract')
    expect(m.base.fileName).toBe('contract.pdf')
  })

  it('maps an inline image to a photo download that needs the bot token', () => {
    const m = mapInbound(
      activity({
        attachments: [{ contentType: 'image/png', contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/x/views/original' }],
      }),
      BOT_ID
    )
    expect(m.kind).toBe('attachment')
    if (m.kind !== 'attachment') return
    expect(m.download.kind).toBe('photo')
    expect(m.download.needsAuth).toBe(true)
    expect(m.download.name).toMatch(/\.png$/)
  })

  it('maps a voice message (audio attachment) to a voice download with the bot token', () => {
    const m = mapInbound(
      activity({
        attachments: [{ contentType: 'audio/mp4', contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/v/views/original' }],
      }),
      BOT_ID
    )
    expect(m.kind).toBe('attachment')
    if (m.kind !== 'attachment') return
    expect(m.download.kind).toBe('voice')
    expect(m.download.needsAuth).toBe(true)
    expect(m.download.name).toMatch(/\.m4a$/)
    expect(m.base.type).toBe('voice')
  })

  it('keeps voice-note text as the caption and maps common audio types to transcribable extensions', () => {
    const m = mapInbound(
      activity({
        text: 'listen to this',
        attachments: [{ contentType: 'audio/mpeg', contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/v/views/original', name: undefined }],
      }),
      BOT_ID
    )
    expect(m.kind).toBe('attachment')
    if (m.kind !== 'attachment') return
    expect(m.download.name).toMatch(/\.mp3$/)
    expect(m.base.caption).toBe('listen to this')
    const wav = mapInbound(
      activity({ attachments: [{ contentType: 'audio/wav', contentUrl: 'https://smba.trafficmanager.net/x' }] }),
      BOT_ID
    )
    if (wav.kind === 'attachment') expect(wav.download.name).toMatch(/\.wav$/)
  })

  it('routes an uploaded audio file to the voice path, not the document path', () => {
    const m = mapInbound(
      activity({
        attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'memo.m4a', content: { downloadUrl: 'https://f/memo.m4a' } }],
      }),
      BOT_ID
    )
    expect(m.kind).toBe('attachment')
    if (m.kind !== 'attachment') return
    expect(m.download.kind).toBe('voice')
    expect(m.base.type).toBe('voice')
    const pdf = mapInbound(
      activity({
        attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'a.pdf', content: { downloadUrl: 'https://f/a.pdf' } }],
      }),
      BOT_ID
    )
    if (pdf.kind === 'attachment') expect(pdf.base.type).toBe('document')
  })

  it('ignores the text/html duplicate Teams attaches to every message', () => {
    const m = mapInbound(
      activity({ text: 'plain', attachments: [{ contentType: 'text/html', content: '<p>plain</p>' }] }),
      BOT_ID
    )
    expect(m.kind).toBe('message')
  })

  it('recognises the bot being added to a conversation', () => {
    const m = mapInbound(activity({ type: 'conversationUpdate', membersAdded: [{ id: BOT_ID }] }), BOT_ID)
    expect(m.kind).toBe('bot-added')
  })

  it('ignores other members being added, invokes, reactions, and empty messages', () => {
    expect(mapInbound(activity({ type: 'conversationUpdate', membersAdded: [{ id: '29:someone' }] }), BOT_ID).kind).toBe('ignore')
    expect(mapInbound(activity({ type: 'invoke' }), BOT_ID).kind).toBe('ignore')
    expect(mapInbound(activity({ type: 'messageReaction' }), BOT_ID).kind).toBe('ignore')
    expect(mapInbound(activity({ type: 'message', text: '   ' }), BOT_ID).kind).toBe('ignore')
  })
})

describe('formatForTeams', () => {
  it('keeps the Markdown subset Teams renders and rewrites the rest', () => {
    const out = formatForTeams('# Title\n\n**bold** and __also__ and *it* `code`\n\n- a\n- b\n\n[link](https://x.y)\n\n~~gone~~')
    expect(out).toContain('**Title**')
    expect(out).toContain('**bold** and **also** and *it* `code`')
    expect(out).toContain('- a\n- b')
    expect(out).toContain('[link](https://x.y)')
    expect(out).toContain('~~gone~~')
    expect(out).not.toMatch(/^#/m)
  })

  it('turns the HTML tags the bot emits for Telegram into Markdown', () => {
    expect(formatForTeams('<b>bold</b> <i>it</i> <code>x</code> <a href="https://x.y">link</a>')).toBe(
      '**bold** *it* `x` [link](https://x.y)'
    )
  })

  it('renders a Markdown table as a code block, since Teams has no tables in bot text', () => {
    const out = formatForTeams('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out.startsWith('```')).toBe(true)
    expect(out).toContain('| 1 | 2 |')
  })

  it('leaves fenced code blocks alone', () => {
    const src = 'Run this:\n\n```python\n# comment\ndef __init__(self):\n    pass\n```\n\n# Heading after'
    const out = formatForTeams(src)
    expect(out).toContain('```python\n# comment\ndef __init__(self):\n    pass\n```')
    expect(out).toContain('**Heading after**')
  })

  it('leaves inline code alone', () => {
    expect(formatForTeams('call `__init__` then `<b>` literally')).toBe('call `__init__` then `<b>` literally')
  })
})

describe('outbound builders', () => {
  it('builds a markdown text activity', () => {
    expect(buildTextActivity('hi **there**')).toEqual({ type: 'message', text: 'hi **there**', textFormat: 'markdown' })
  })

  it('builds a typing activity', () => {
    expect(buildTypingActivity()).toEqual({ type: 'typing' })
  })

  it('builds an Adaptive Card with one messageBack action per button', () => {
    const a = buildCardActivity('Send this?', ['Send', 'Edit', 'Discard'])
    expect(a.type).toBe('message')
    expect(a.attachments).toHaveLength(1)
    const card = a.attachments![0]
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive')
    const content = card.content as { version: string; body: unknown[]; actions: Array<{ type: string; title: string; data: unknown }> }
    expect(content.version).toBe('1.4')
    expect(content.actions.map((x) => x.title)).toEqual(['Send', 'Edit', 'Discard'])
    expect(content.actions[0]).toEqual({
      type: 'Action.Submit',
      title: 'Send',
      data: { msteams: { type: 'messageBack', text: 'Send', displayText: 'Send', value: { btn: 'Send' } }, btn: 'Send' },
    })
    expect(JSON.stringify(content.body)).toContain('Send this?')
  })
})

describe('isMicrosoftAttachmentHost', () => {
  it('allows known Bot Framework / Microsoft download hosts over https', () => {
    expect(isMicrosoftAttachmentHost('https://smba.trafficmanager.net/amer/v3/attachments/x')).toBe(true)
  })

  it('rejects arbitrary hosts', () => {
    expect(isMicrosoftAttachmentHost('https://evil.example/x')).toBe(false)
  })

  it('rejects a Microsoft host over plain http', () => {
    expect(isMicrosoftAttachmentHost('http://smba.trafficmanager.net/x')).toBe(false)
  })

  it('rejects unparseable input', () => {
    expect(isMicrosoftAttachmentHost('not a url')).toBe(false)
  })
})
