import { describe, it, expect } from 'vitest'
import { mapInbound, referenceFrom } from '../src/platform/teams/activities.js'
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
