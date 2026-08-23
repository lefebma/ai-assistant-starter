# Microsoft Teams Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Havn install can use Microsoft Teams (1:1 personal chat) as its chat surface, with text, typing, streaming edits, `[[buttons]]` approvals, and inbound files, validated on a hosted VPS box.

**Architecture:** One Azure Bot per install. Microsoft POSTs activities to `https://<box>/api/teams/messages`; Caddy on the box proxies only that path to the app's existing `node:http` server on 3030. A new `src/platform/teams/` module validates the Bot Framework JWT with `jose`, maps activities to the existing `IncomingMessage` shape, and replies through a thin Bot Connector REST client using stored conversation references. No Bot Framework SDK.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20+, `node:http`, `better-sqlite3`, `jose` (new), vitest, bash + `az` CLI for registration, Caddy on Ubuntu 24.04.

**Spec:** `docs/superpowers/specs/2026-08-22-teams-adapter-design.md`

> **Execution note (2026-08-23):** Tasks 13 and 14 below specify bash scripts. The repo forbids `.sh` files (`tests/no-bash.test.ts`), so they were built as TypeScript: `scripts/hosted/enable-teams.ts` (+ `src/deploy/teams-edge.ts`) and `scripts/teams-register.ts` (+ `src/deploy/teams-register.ts`, `npm run teams-register`). Task 9's handler validates the JWT before reading the body. Task 17's commands are updated accordingly. The SDD ledger in `.superpowers/sdd/` (not committed) holds every ruling.

## Global Constraints

- Only one new runtime dependency: `jose`. Nothing else is added to `package.json`.
- Every network call in `src/platform/teams/` goes through an injected `fetch`-compatible function so unit tests never touch the network.
- Inbound handler responds `200` before processing; processing errors are logged with the activity id and never retried.
- Inbound auth failures return `401` with an empty body and are logged at most once per minute.
- Only `POST /api/teams/messages` is exposed through Caddy; ufw opens 80 and 443 only.
- `TEAMS_APP_SECRET` is never logged. No secret appears in argv of any script.
- Repo conventions: `src/**` and `scripts/**` compile with `tsc --noEmit`; tests live in `tests/*.test.ts` and run with `npx vitest run`; imports inside `src/` use `.js` suffixes; logging via `import { logger } from '../../logger.js'`.
- Commit after every task with the message given in the task. Do not squash tasks together.
- Before Task 1 and again before Task 9, read the API-authorisation and supply-chain playbooks in `/Users/marclefebvre/Projects/ClaudeClaw/reference/security-playbooks/` (see its `README.md`); they are the checklist the tester applies to the webhook and the new dependency.

---

## File map

| File | Responsibility |
|---|---|
| `src/http-server.ts` (modify) | `registerHttpRoute()` registry consulted before the existing if-chain; `startHttpServer(port?)` override for tests |
| `src/platform/teams/types.ts` (create) | `Activity`, `OutboundActivity`, `ConversationReference`, `TeamsAdapterOptions` |
| `src/platform/teams/activities.ts` (create) | Pure mappers: inbound Activity → `InboundMapping`; outbound builders; `formatForTeams` |
| `src/platform/teams/conversations.ts` (create) | SQLite tables `teams_conversations`, `teams_processed_activities`; upsert/get/dedupe |
| `src/platform/teams/auth.ts` (create) | `InboundTokenValidator` (JWT via jose), `OutboundTokenProvider` (client credentials) |
| `src/platform/teams/connector.ts` (create) | `BotConnector`: send/update/delete/typing with retry policy |
| `src/platform/teams/adapter.ts` (create) | `TeamsAdapter implements PlatformAdapter` |
| `src/media.ts` (modify) | `downloadToUploads(url, filename, headers?)` |
| `src/platform/index.ts` (modify) | `teams` case + auto-detect |
| `src/setup/plan.ts`, `scripts/setup.ts` (modify) | Teams env keys incl. `ALLOWED_CHAT_ID`; wizard prompts |
| `scripts/hosted/enable-teams.sh` (create) | Caddy + ufw on the box |
| `scripts/teams-register.sh` (create) | `az` registration |
| `scripts/teams-manifest.ts`, `deploy/teams/manifest.json.template` (create) | Teams app package |
| `docs/HOSTED-VPS.md`, `docs/SETUP-GUIDE.md`, `.env.example`, `CHANGELOG.md` (modify) | Docs |
| `tests/teams-*.test.ts`, `tests/http-routes.test.ts` (create) | Coverage per task |

---

### Task 1: HTTP route registry and `jose` dependency

**Files:**
- Modify: `src/http-server.ts` (the `createServer` callback around line 284, `startHttpServer` signature at line 283)
- Modify: `package.json` (dependency)
- Test: `tests/http-routes.test.ts`

**Interfaces:**
- Produces: `export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>`; `export function registerHttpRoute(method: string, pathname: string, handler: RouteHandler): () => void` (returns an unregister function); `export function startHttpServer(port: number = HTTP_PORT): void`.
- Registered routes are matched before the built-in routes and do not pass through `requireAuth`.

- [ ] **Step 1: Add the dependency**

Run: `npm install jose@^6.2.10`
Expected: `package.json` gains `"jose": "^6.2.10"` under `dependencies`; lockfile updated.

- [ ] **Step 2: Write the failing test**

Create `tests/http-routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { registerHttpRoute, startHttpServer, stopHttpServer } from '../src/http-server.js'

const PORT = 3900 + Math.floor(Math.random() * 100)

describe('registerHttpRoute', () => {
  afterEach(async () => {
    await stopHttpServer()
  })

  it('serves a registered route before the built-in ones and without bearer auth', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('routed')
    })
    startHttpServer(PORT)
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('routed')
    unregister()
    const after = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(after.status).toBe(405)
  })

  it('matches method and path exactly', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', (_req, res) => {
      res.writeHead(200)
      res.end('routed')
    })
    startHttpServer(PORT)
    const get = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`)
    expect(get.status).not.toBe(200)
    const other = await fetch(`http://127.0.0.1:${PORT}/api/teams/other`, { method: 'POST', body: '{}' })
    expect(other.status).toBe(405)
    unregister()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/http-routes.test.ts`
Expected: FAIL, `registerHttpRoute` is not exported / `startHttpServer` takes no argument.

- [ ] **Step 4: Implement the registry**

In `src/http-server.ts`, add near the top (after the imports):

```ts
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

// Routes registered by platform adapters (the Teams webhook). Consulted at
// request time, before the built-in routes, so registration order relative to
// listen() does not matter. They carry their own authentication and are
// deliberately not behind requireAuth().
const registeredRoutes = new Map<string, RouteHandler>()

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`
}

export function registerHttpRoute(method: string, pathname: string, handler: RouteHandler): () => void {
  const key = routeKey(method, pathname)
  registeredRoutes.set(key, handler)
  return () => {
    if (registeredRoutes.get(key) === handler) registeredRoutes.delete(key)
  }
}
```

Change the signature `export function startHttpServer(): void {` to `export function startHttpServer(port: number = HTTP_PORT): void {` and the listen call `server.listen(HTTP_PORT, '0.0.0.0', () => {` to `server.listen(port, '0.0.0.0', () => {` (also change `{ port: HTTP_PORT }` in that log line to `{ port }`).

Inside the `createServer((req, res) => {` callback, immediately after the `OPTIONS` early return, add:

```ts
    const registered = registeredRoutes.get(routeKey(req.method ?? 'GET', url.pathname))
    if (registered) {
      Promise.resolve(registered(req, res)).catch((err) => {
        logger.error({ err, path: url.pathname }, 'registered route failed')
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      })
      return
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/http-routes.test.ts && npm run typecheck`
Expected: 2 passed; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/http-server.ts tests/http-routes.test.ts
git commit -m "HTTP server: route registry for platform webhooks, port override for tests; add jose"
```

---

### Task 2: Teams types and inbound activity mapping

**Files:**
- Create: `src/platform/teams/types.ts`
- Create: `src/platform/teams/activities.ts`
- Test: `tests/teams-activities.test.ts`

**Interfaces:**
- Produces (`types.ts`):

```ts
export interface ActivityAccount { id: string; name?: string; aadObjectId?: string }
export interface ActivityAttachment { contentType: string; contentUrl?: string; name?: string; content?: unknown }
export interface Activity {
  type: string
  id?: string
  replyToId?: string
  text?: string
  value?: unknown
  serviceUrl?: string
  channelId?: string
  from?: ActivityAccount
  recipient?: ActivityAccount
  conversation?: { id: string; tenantId?: string; conversationType?: string }
  channelData?: { tenant?: { id: string } }
  attachments?: ActivityAttachment[]
  membersAdded?: ActivityAccount[]
}
export interface OutboundActivity {
  type: 'message' | 'typing'
  text?: string
  textFormat?: 'markdown' | 'plain'
  attachments?: ActivityAttachment[]
}
export interface ConversationReference {
  conversationId: string
  serviceUrl: string
  botId: string
  userId: string
  tenantId?: string
}
```

- Produces (`activities.ts`):

```ts
export type AttachmentDownload = { url: string; name: string; needsAuth: boolean; kind: 'photo' | 'document' }
export type InboundMapping =
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'attachment'; download: AttachmentDownload; base: IncomingMessage }
  | { kind: 'bot-added' }
  | { kind: 'ignore'; reason: string }
export function referenceFrom(activity: Activity): ConversationReference | null
export function mapInbound(activity: Activity, botId: string): InboundMapping
```

`base` in the attachment mapping is a complete `IncomingMessage` with `type` set to the attachment kind and `filePath` unset; the adapter fills `filePath` after download.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-activities.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-activities.test.ts`
Expected: FAIL, cannot find module `../src/platform/teams/activities.js`.

- [ ] **Step 3: Create the types**

Create `src/platform/teams/types.ts`:

```ts
/**
 * The slice of the Bot Framework Activity schema this adapter reads and
 * writes. Kept deliberately small: anything not listed here is ignored.
 */

export interface ActivityAccount {
  id: string
  name?: string
  aadObjectId?: string
}

export interface ActivityAttachment {
  contentType: string
  contentUrl?: string
  name?: string
  content?: unknown
}

export interface Activity {
  type: string
  id?: string
  replyToId?: string
  text?: string
  value?: unknown
  serviceUrl?: string
  channelId?: string
  from?: ActivityAccount
  recipient?: ActivityAccount
  conversation?: { id: string; tenantId?: string; conversationType?: string }
  channelData?: { tenant?: { id: string } }
  attachments?: ActivityAttachment[]
  membersAdded?: ActivityAccount[]
}

export interface OutboundActivity {
  type: 'message' | 'typing'
  text?: string
  textFormat?: 'markdown' | 'plain'
  attachments?: ActivityAttachment[]
}

/** Everything a proactive send needs, persisted per conversation. */
export interface ConversationReference {
  conversationId: string
  serviceUrl: string
  botId: string
  userId: string
  tenantId?: string
}

export interface TeamsCredentials {
  appId: string
  appSecret: string
  tenantId?: string
}
```

- [ ] **Step 4: Create the inbound mapper**

Create `src/platform/teams/activities.ts`:

```ts
/**
 * Pure mapping between Bot Framework activities and the adapter-neutral
 * IncomingMessage / outbound shapes. No I/O here; the adapter does the
 * downloading and sending.
 */
import type { IncomingMessage } from '../types.js'
import type { Activity, ConversationReference } from './types.js'

export type AttachmentDownload = { url: string; name: string; needsAuth: boolean; kind: 'photo' | 'document' }

export type InboundMapping =
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'attachment'; download: AttachmentDownload; base: IncomingMessage }
  | { kind: 'bot-added' }
  | { kind: 'ignore'; reason: string }

const TEAMS_FILE_INFO = 'application/vnd.microsoft.teams.file.download.info'

export function referenceFrom(activity: Activity): ConversationReference | null {
  const conversationId = activity.conversation?.id
  const serviceUrl = activity.serviceUrl
  if (!conversationId || !serviceUrl) return null
  return {
    conversationId,
    serviceUrl,
    botId: activity.recipient?.id ?? '',
    userId: activity.from?.aadObjectId ?? activity.from?.id ?? '',
    tenantId: activity.conversation?.tenantId ?? activity.channelData?.tenant?.id,
  }
}

/** Teams wraps the bot mention as <at>Name</at>; strip it and surrounding space. */
function stripMentions(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/g, '').replace(/\s+/g, ' ').trim()
}

function buttonLabel(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { btn?: unknown }).btn === 'string') {
    return (value as { btn: string }).btn
  }
  return null
}

function extensionFor(contentType: string): string {
  const sub = contentType.split('/')[1] ?? 'bin'
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '')
}

export function mapInbound(activity: Activity, botId: string): InboundMapping {
  if (activity.type === 'conversationUpdate') {
    const added = activity.membersAdded?.some((m) => m.id === botId) ?? false
    return added ? { kind: 'bot-added' } : { kind: 'ignore', reason: 'conversationUpdate without the bot' }
  }
  if (activity.type !== 'message') return { kind: 'ignore', reason: `activity type ${activity.type}` }

  const ref = referenceFrom(activity)
  if (!ref) return { kind: 'ignore', reason: 'message without conversation/serviceUrl' }

  const id = activity.id ?? ''
  const common = { chatId: ref.conversationId, userId: ref.userId, messageId: id, updateId: id }
  const text = stripMentions(activity.text ?? '')

  const label = buttonLabel(activity.value)
  if (label) {
    return {
      kind: 'message',
      message: {
        ...common,
        text: label,
        type: 'callback',
        callbackData: `btn:${label}`,
        messageId: activity.replyToId ?? id,
      },
    }
  }

  for (const att of activity.attachments ?? []) {
    if (att.contentType === TEAMS_FILE_INFO) {
      const content = (att.content ?? {}) as { downloadUrl?: string }
      if (!content.downloadUrl) continue
      const name = att.name ?? 'file'
      return {
        kind: 'attachment',
        download: { url: content.downloadUrl, name, needsAuth: false, kind: 'document' },
        base: { ...common, text: '', type: 'document', fileName: name, caption: text || undefined },
      }
    }
    if (att.contentType.startsWith('image/') && att.contentUrl) {
      const name = att.name ?? `image-${id || Date.now()}.${extensionFor(att.contentType)}`
      return {
        kind: 'attachment',
        download: { url: att.contentUrl, name, needsAuth: true, kind: 'photo' },
        base: { ...common, text: '', type: 'photo', fileName: name, caption: text || undefined },
      }
    }
    // text/html and card echoes duplicate activity.text; fall through.
  }

  if (!text) return { kind: 'ignore', reason: 'empty message' }
  return { kind: 'message', message: { ...common, text, type: 'text' } }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/teams-activities.test.ts && npm run typecheck`
Expected: 9 passed; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/platform/teams/types.ts src/platform/teams/activities.ts tests/teams-activities.test.ts
git commit -m "Teams: activity types and inbound mapping to IncomingMessage"
```

---

### Task 3: Outbound builders and Teams Markdown formatting

**Files:**
- Modify: `src/platform/teams/activities.ts` (append)
- Test: `tests/teams-activities.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export function formatForTeams(markdown: string): string
export function buildTextActivity(text: string): OutboundActivity
export function buildCardActivity(text: string, buttons: string[]): OutboundActivity
export function buildClearedCardActivity(text: string): OutboundActivity   // same as buildTextActivity; named for intent
export function buildTypingActivity(): OutboundActivity
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/teams-activities.test.ts`:

```ts
import {
  buildCardActivity,
  buildTextActivity,
  buildTypingActivity,
  formatForTeams,
} from '../src/platform/teams/activities.js'

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/teams-activities.test.ts`
Expected: FAIL, `formatForTeams` is not exported.

- [ ] **Step 3: Implement the builders and formatter**

Append to `src/platform/teams/activities.ts`:

```ts
import type { OutboundActivity } from './types.js'

const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive'

/**
 * Teams bot text renders a Markdown subset: bold, italic, strikethrough,
 * inline code, fenced code, links, lists. No headings, no tables, no HTML.
 * The bot core produces Markdown, and a few HTML tags left over from the
 * Telegram path; both are normalised here.
 */
export function formatForTeams(markdown: string): string {
  let out = markdown

  // HTML leftovers from the Telegram formatter → Markdown
  out = out.replace(/<b>(.*?)<\/b>/gs, '**$1**')
  out = out.replace(/<strong>(.*?)<\/strong>/gs, '**$1**')
  out = out.replace(/<i>(.*?)<\/i>/gs, '*$1*')
  out = out.replace(/<em>(.*?)<\/em>/gs, '*$1*')
  out = out.replace(/<code>(.*?)<\/code>/gs, '`$1`')
  out = out.replace(/<pre>(.*?)<\/pre>/gs, '```\n$1\n```')
  out = out.replace(/<a href="([^"]+)">(.*?)<\/a>/gs, '[$2]($1)')

  // Markdown tables → fenced block (Teams renders pipes literally otherwise)
  out = out.replace(/((?:^\|.*\|\s*$\n?){2,})/gm, (table) => '```\n' + table.trimEnd() + '\n```\n')

  // Headings → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')

  // __bold__ → **bold**
  out = out.replace(/__(.+?)__/g, '**$1**')

  return out.trim()
}

export function buildTextActivity(text: string): OutboundActivity {
  return { type: 'message', text, textFormat: 'markdown' }
}

/** Replacing a card with plain text is how buttons are "cleared". */
export function buildClearedCardActivity(text: string): OutboundActivity {
  return buildTextActivity(text)
}

export function buildTypingActivity(): OutboundActivity {
  return { type: 'typing' }
}

/**
 * One Adaptive Card: the text as a wrapping TextBlock, one Action.Submit per
 * label. `msteams.type = messageBack` makes the click arrive as a normal
 * message activity carrying `value.btn`, which mapInbound turns into the
 * callback shape the bot core already handles. `btn` is duplicated at the top
 * level of `data` because Teams merges `data` into `value` on the way back.
 */
export function buildCardActivity(text: string, buttons: string[]): OutboundActivity {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [{ type: 'TextBlock', text, wrap: true }],
    actions: buttons.map((label) => ({
      type: 'Action.Submit',
      title: label,
      data: { msteams: { type: 'messageBack', text: label, displayText: label, value: { btn: label } }, btn: label },
    })),
  }
  return { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD, content: card }] }
}
```

Move the `import type { OutboundActivity } from './types.js'` line up to join the existing import at the top of the file (one import per module).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/teams-activities.test.ts && npm run typecheck`
Expected: 15 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/activities.ts tests/teams-activities.test.ts
git commit -m "Teams: outbound activity builders and Markdown subset formatter"
```

---

### Task 4: Conversation reference store and activity dedupe

**Files:**
- Create: `src/platform/teams/conversations.ts`
- Test: `tests/teams-conversations.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `src/db.ts`; `ConversationReference` from `./types.js`.
- Produces:

```ts
export function initTeamsTables(): void                       // idempotent CREATE TABLE IF NOT EXISTS
export function upsertConversation(ref: ConversationReference): void
export function getConversation(conversationId: string): ConversationReference | null
export function hasProcessedActivity(activityId: string): boolean
export function markActivityProcessed(activityId: string): void  // also prunes rows older than 7 days
```

- [ ] **Step 1: Write the failing test**

Create `tests/teams-conversations.test.ts`:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

// Own SQLite store for this file, set before src/config.js is evaluated
// (vi.hoisted runs ahead of the hoisted imports). Other files share the
// default AGENT_STORE_DIR and would race on one database file otherwise.
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-conversations`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import {
  initTeamsTables,
  upsertConversation,
  getConversation,
  hasProcessedActivity,
  markActivityProcessed,
} from '../src/platform/teams/conversations.js'

describe('teams conversation store', () => {
  beforeAll(() => {
    initTeamsTables()
    initTeamsTables() // idempotent
  })

  it('round-trips a reference and updates it in place', () => {
    upsertConversation({ conversationId: 'a:1', serviceUrl: 'https://s1/', botId: '28:bot', userId: 'aad-1', tenantId: 't1' })
    expect(getConversation('a:1')).toEqual({ conversationId: 'a:1', serviceUrl: 'https://s1/', botId: '28:bot', userId: 'aad-1', tenantId: 't1' })
    upsertConversation({ conversationId: 'a:1', serviceUrl: 'https://s2/', botId: '28:bot', userId: 'aad-1' })
    expect(getConversation('a:1')?.serviceUrl).toBe('https://s2/')
    expect(getConversation('a:1')?.tenantId).toBeUndefined()
  })

  it('returns null for an unknown conversation', () => {
    expect(getConversation('a:nope')).toBeNull()
  })

  it('remembers processed activity ids', () => {
    expect(hasProcessedActivity('act-1')).toBe(false)
    markActivityProcessed('act-1')
    expect(hasProcessedActivity('act-1')).toBe(true)
    markActivityProcessed('act-1') // no throw on repeat
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-conversations.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the store**

Create `src/platform/teams/conversations.ts`:

```ts
/**
 * Conversation references for proactive sends, and a dedupe table for
 * inbound activity ids. Teams activity ids are strings, so they cannot share
 * the integer-keyed processed_updates table Telegram uses.
 */
import { getDb } from '../../db.js'
import type { ConversationReference } from './types.js'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

export function initTeamsTables(): void {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS teams_conversations (
      conversation_id TEXT PRIMARY KEY,
      service_url TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE IF NOT EXISTS teams_processed_activities (
      activity_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )
  `)
}

export function upsertConversation(ref: ConversationReference): void {
  getDb()
    .prepare(
      `INSERT INTO teams_conversations (conversation_id, service_url, bot_id, user_id, tenant_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         service_url = excluded.service_url,
         bot_id = excluded.bot_id,
         user_id = excluded.user_id,
         tenant_id = excluded.tenant_id,
         updated_at = excluded.updated_at`
    )
    .run(ref.conversationId, ref.serviceUrl, ref.botId, ref.userId, ref.tenantId ?? null, now())
}

export function getConversation(conversationId: string): ConversationReference | null {
  const row = getDb()
    .prepare('SELECT conversation_id, service_url, bot_id, user_id, tenant_id FROM teams_conversations WHERE conversation_id = ?')
    .get(conversationId) as
    | { conversation_id: string; service_url: string; bot_id: string; user_id: string; tenant_id: string | null }
    | undefined
  if (!row) return null
  const ref: ConversationReference = {
    conversationId: row.conversation_id,
    serviceUrl: row.service_url,
    botId: row.bot_id,
    userId: row.user_id,
  }
  if (row.tenant_id) ref.tenantId = row.tenant_id
  return ref
}

export function hasProcessedActivity(activityId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM teams_processed_activities WHERE activity_id = ?').get(activityId)
}

export function markActivityProcessed(activityId: string): void {
  const d = getDb()
  d.prepare('INSERT OR IGNORE INTO teams_processed_activities (activity_id, processed_at) VALUES (?, ?)').run(activityId, now())
  d.prepare('DELETE FROM teams_processed_activities WHERE processed_at < ?').run(now() - 7 * 86400)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/teams-conversations.test.ts && npm run typecheck`
Expected: 3 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/conversations.ts tests/teams-conversations.test.ts
git commit -m "Teams: conversation reference store and activity dedupe tables"
```

---

### Task 5: Inbound JWT validation

**Files:**
- Create: `src/platform/teams/auth.ts`
- Test: `tests/teams-auth.test.ts`

**Interfaces:**
- Produces:

```ts
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export interface InboundValidatorOptions {
  appId: string
  fetchImpl?: FetchLike          // default: globalThis.fetch
  now?: () => Date               // default: () => new Date()
  openIdConfigUrl?: string       // default: BOT_FRAMEWORK_OPENID_URL
}
export const BOT_FRAMEWORK_OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'
export class InboundTokenValidator {
  constructor(opts: InboundValidatorOptions)
  /** true when the Authorization header carries a valid Bot Framework token for this app. Never throws. */
  validate(authorizationHeader: string | undefined): Promise<boolean>
}
```

Behaviour: fetch the OpenID config once (cache), fetch its `jwks_uri` (cache), verify with `jose.jwtVerify` using `issuer`, `audience = appId`, `clockTolerance: 60`, `currentDate: now()`. On `JWKSNoMatchingKey`, refetch the JWKS exactly once and retry. Any failure → `false`.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-auth.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { InboundTokenValidator, BOT_FRAMEWORK_ISSUER } from '../src/platform/teams/auth.js'

// jose v6 has no KeyLike export; take the type from generateKeyPair itself.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const APP_ID = '11111111-2222-3333-4444-555555555555'
const OPENID = 'https://login.example/openid'
const JWKS = 'https://login.example/keys'

let privateKey: PrivateKey
let publicJwk: Record<string, unknown>
let rotatedPrivate: PrivateKey
let rotatedJwk: Record<string, unknown>

beforeAll(async () => {
  const a = await generateKeyPair('RS256')
  privateKey = a.privateKey
  publicJwk = { ...(await exportJWK(a.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }
  const b = await generateKeyPair('RS256')
  rotatedPrivate = b.privateKey
  rotatedJwk = { ...(await exportJWK(b.publicKey)), kid: 'key-2', alg: 'RS256', use: 'sig' }
})

function fakeFetch(keys: () => Record<string, unknown>[], counter: { jwks: number }) {
  return async (url: string): Promise<Response> => {
    if (url === OPENID) return new Response(JSON.stringify({ jwks_uri: JWKS }), { status: 200 })
    if (url === JWKS) {
      counter.jwks++
      return new Response(JSON.stringify({ keys: keys() }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
}

async function sign(key: PrivateKey, kid: string, claims: { iss?: string; aud?: string; expSeconds?: number }) {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT({ serviceurl: 'https://smba.trafficmanager.net/amer/' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(claims.iss ?? BOT_FRAMEWORK_ISSUER)
    .setAudience(claims.aud ?? APP_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (claims.expSeconds ?? 300))
    .sign(key)
}

describe('InboundTokenValidator', () => {
  it('accepts a token signed by a published key for this app', async () => {
    const counter = { jwks: 0 }
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], counter), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    expect(counter.jwks).toBe(1) // cached
  })

  it('rejects a missing or malformed header', async () => {
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(undefined)).toBe(false)
    expect(await v.validate('Basic abc')).toBe(false)
    expect(await v.validate('Bearer not.a.jwt')).toBe(false)
  })

  it('rejects the wrong issuer, the wrong audience, and an expired token', async () => {
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { iss: 'https://evil.example' })}`)).toBe(false)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { aud: 'some-other-app' })}`)).toBe(false)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { expSeconds: -120 })}`)).toBe(false)
  })

  it('refetches the key set once when it sees an unknown kid (key rotation)', async () => {
    let published = [publicJwk]
    const counter = { jwks: 0 }
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => published, counter), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    published = [publicJwk, rotatedJwk]
    expect(await v.validate(`Bearer ${await sign(rotatedPrivate, 'key-2', {})}`)).toBe(true)
    expect(counter.jwks).toBe(2)
    // unknown kid that never appears: one refetch, then reject
    const stranger = await generateKeyPair('RS256')
    expect(await v.validate(`Bearer ${await sign(stranger.privateKey, 'key-9', {})}`)).toBe(false)
    expect(counter.jwks).toBe(3)
  })

  it('rejects a token signed with a key that is not published', async () => {
    const stranger = await generateKeyPair('RS256')
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(stranger.privateKey, 'key-1', {})}`)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-auth.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the validator**

Create `src/platform/teams/auth.ts`:

```ts
/**
 * Bot Framework authentication, both directions.
 *
 * Inbound: Microsoft signs each POST with a JWT issued by
 * api.botframework.com for our app id. We verify signature, issuer,
 * audience, and expiry against the JWKS the OpenID configuration points at.
 *
 * Outbound (Task 6): client-credentials token for the Bot Connector REST API.
 *
 * Network access is through an injected fetch so tests stay offline.
 */
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet } from 'jose'
import { logger } from '../../logger.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const BOT_FRAMEWORK_OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'

export interface InboundValidatorOptions {
  appId: string
  fetchImpl?: FetchLike
  now?: () => Date
  openIdConfigUrl?: string
}

export class InboundTokenValidator {
  private readonly appId: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => Date
  private readonly openIdConfigUrl: string
  private jwksUri: string | null = null
  private keySet: ReturnType<typeof createLocalJWKSet> | null = null

  constructor(opts: InboundValidatorOptions) {
    this.appId = opts.appId
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => new Date())
    this.openIdConfigUrl = opts.openIdConfigUrl ?? BOT_FRAMEWORK_OPENID_URL
  }

  async validate(authorizationHeader: string | undefined): Promise<boolean> {
    const token = authorizationHeader?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (!token) return false
    try {
      await this.verify(token, await this.keys(false))
      return true
    } catch (err) {
      if (err instanceof joseErrors.JWKSNoMatchingKey) {
        // Key rotation: fetch the set once more, then give up.
        try {
          await this.verify(token, await this.keys(true))
          return true
        } catch {
          return false
        }
      }
      return false
    }
  }

  private async verify(token: string, keySet: ReturnType<typeof createLocalJWKSet>): Promise<void> {
    await jwtVerify(token, keySet, {
      issuer: BOT_FRAMEWORK_ISSUER,
      audience: this.appId,
      clockTolerance: 60,
      currentDate: this.now(),
    })
  }

  private async keys(refresh: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.keySet && !refresh) return this.keySet
    if (!this.jwksUri) {
      const resp = await this.fetchImpl(this.openIdConfigUrl)
      if (!resp.ok) throw new Error(`OpenID configuration fetch failed: ${resp.status}`)
      const cfg = (await resp.json()) as { jwks_uri?: string }
      if (!cfg.jwks_uri) throw new Error('OpenID configuration has no jwks_uri')
      this.jwksUri = cfg.jwks_uri
    }
    const resp = await this.fetchImpl(this.jwksUri)
    if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`)
    const jwks = (await resp.json()) as JSONWebKeySet
    this.keySet = createLocalJWKSet(jwks)
    logger.debug({ keys: jwks.keys.length, refresh }, 'Teams: Bot Framework signing keys loaded')
    return this.keySet
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/teams-auth.test.ts && npm run typecheck`
Expected: 5 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/auth.ts tests/teams-auth.test.ts
git commit -m "Teams: inbound Bot Framework JWT validation with jose"
```

---

### Task 6: Outbound token provider

**Files:**
- Modify: `src/platform/teams/auth.ts` (append)
- Test: `tests/teams-auth.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export interface OutboundTokenOptions {
  appId: string
  appSecret: string
  tenantId?: string
  fetchImpl?: FetchLike
  now?: () => number            // epoch ms; default Date.now
}
export class OutboundTokenProvider {
  constructor(opts: OutboundTokenOptions)
  token(): Promise<string>      // cached until < 300 s from expiry
  invalidate(): void            // drop the cache (after a 401)
  static tokenUrl(tenantId?: string): string
}
```

Token URL: `https://login.microsoftonline.com/${tenantId ?? 'botframework.com'}/oauth2/v2.0/token`. Body (form-encoded): `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=https://api.botframework.com/.default`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/teams-auth.test.ts`:

```ts
import { OutboundTokenProvider } from '../src/platform/teams/auth.js'

describe('OutboundTokenProvider', () => {
  function tokenServer(counter: { calls: number }, expiresIn = 3600) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      counter.calls++
      expect(url).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token')
      expect(init?.method).toBe('POST')
      const body = String(init?.body)
      expect(body).toContain('grant_type=client_credentials')
      expect(body).toContain(`client_id=${APP_ID}`)
      expect(body).toContain('client_secret=s3cret')
      expect(body).toContain(encodeURIComponent('https://api.botframework.com/.default'))
      return new Response(JSON.stringify({ access_token: `tok-${counter.calls}`, expires_in: expiresIn }), { status: 200 })
    }
  }

  it('fetches once and caches', async () => {
    const counter = { calls: 0 }
    const p = new OutboundTokenProvider({ appId: APP_ID, appSecret: 's3cret', fetchImpl: tokenServer(counter) })
    expect(await p.token()).toBe('tok-1')
    expect(await p.token()).toBe('tok-1')
    expect(counter.calls).toBe(1)
  })

  it('refreshes when under five minutes from expiry, and after invalidate()', async () => {
    const counter = { calls: 0 }
    let clock = 1_000_000
    const p = new OutboundTokenProvider({ appId: APP_ID, appSecret: 's3cret', fetchImpl: tokenServer(counter, 600), now: () => clock })
    expect(await p.token()).toBe('tok-1')
    clock += 200_000 // 200 s in: still fresh (600 - 200 = 400 s > 300 s)
    expect(await p.token()).toBe('tok-1')
    clock += 150_000 // 350 s in: 250 s left < 300 s → refresh
    expect(await p.token()).toBe('tok-2')
    p.invalidate()
    expect(await p.token()).toBe('tok-3')
  })

  it('uses the tenant endpoint for single-tenant registrations', () => {
    expect(OutboundTokenProvider.tokenUrl('tenant-1')).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
    expect(OutboundTokenProvider.tokenUrl()).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token')
  })

  it('throws with the status, never the secret, when the token endpoint refuses', async () => {
    const p = new OutboundTokenProvider({
      appId: APP_ID,
      appSecret: 's3cret',
      fetchImpl: async () => new Response('{"error":"invalid_client"}', { status: 401 }),
    })
    await expect(p.token()).rejects.toThrow(/401/)
    await expect(p.token()).rejects.not.toThrow(/s3cret/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/teams-auth.test.ts`
Expected: FAIL, `OutboundTokenProvider` is not exported.

- [ ] **Step 3: Implement the provider**

Append to `src/platform/teams/auth.ts`:

```ts
export interface OutboundTokenOptions {
  appId: string
  appSecret: string
  tenantId?: string
  fetchImpl?: FetchLike
  now?: () => number
}

const REFRESH_MARGIN_MS = 300_000

export class OutboundTokenProvider {
  private readonly opts: OutboundTokenOptions
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private cached: { token: string; expiresAt: number } | null = null
  private inflight: Promise<string> | null = null

  constructor(opts: OutboundTokenOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => Date.now())
  }

  static tokenUrl(tenantId?: string): string {
    return `https://login.microsoftonline.com/${tenantId ?? 'botframework.com'}/oauth2/v2.0/token`
  }

  invalidate(): void {
    this.cached = null
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.cached.token
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.appId,
      client_secret: this.opts.appSecret,
      scope: 'https://api.botframework.com/.default',
    })
    const resp = await this.fetchImpl(OutboundTokenProvider.tokenUrl(this.opts.tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!resp.ok) {
      // Body may describe the failure; it never contains our secret.
      const detail = (await resp.text()).slice(0, 200)
      throw new Error(`Bot Framework token request failed: ${resp.status} ${detail}`)
    }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('Bot Framework token response had no access_token')
    this.cached = { token: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 }
    return this.cached.token
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/teams-auth.test.ts && npm run typecheck`
Expected: 9 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/auth.ts tests/teams-auth.test.ts
git commit -m "Teams: outbound client-credentials token provider with refresh margin"
```

---

### Task 7: Bot Connector REST client with retry policy

**Files:**
- Create: `src/platform/teams/connector.ts`
- Test: `tests/teams-connector.test.ts`

**Interfaces:**
- Consumes: `OutboundTokenProvider` (`token()`, `invalidate()`), `FetchLike`, `ConversationReference`, `OutboundActivity`.
- Produces:

```ts
export class ConnectorError extends Error { constructor(public readonly status: number, message: string) }
export interface ConnectorOptions { tokens: OutboundTokenProvider; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> }
export class BotConnector {
  constructor(opts: ConnectorOptions)
  sendActivity(ref: ConversationReference, activity: OutboundActivity): Promise<string>   // returns new activity id
  updateActivity(ref: ConversationReference, activityId: string, activity: OutboundActivity): Promise<void>
  deleteActivity(ref: ConversationReference, activityId: string): Promise<void>
  sendTyping(ref: ConversationReference): Promise<void>
}
```

URL: `${serviceUrl without trailing slash}/v3/conversations/${encodeURIComponent(conversationId)}/activities[/${encodeURIComponent(activityId)}]`. Every outbound activity also carries `from: { id: ref.botId }`, `recipient: { id: ref.userId }`, `conversation: { id: ref.conversationId }`.

Retry policy, applied once per request: `401` → `tokens.invalidate()` and retry once; `429` → wait `Retry-After` seconds (default 1) and retry once; `5xx` → wait 1 s and retry once; any other non-2xx → throw `ConnectorError`.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-connector.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BotConnector, ConnectorError } from '../src/platform/teams/connector.js'
import { OutboundTokenProvider } from '../src/platform/teams/auth.js'
import { buildTextActivity } from '../src/platform/teams/activities.js'

const REF = { conversationId: 'a:1conv', serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: '28:bot', userId: 'aad-1' }

function tokens(counter: { tokenCalls: number }) {
  return new OutboundTokenProvider({
    appId: 'app',
    appSecret: 's',
    fetchImpl: async () => {
      counter.tokenCalls++
      return new Response(JSON.stringify({ access_token: `tok-${counter.tokenCalls}`, expires_in: 3600 }), { status: 200 })
    },
  })
}

type Call = { url: string; method: string; auth: string; body: unknown }

function connector(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>, calls: Call[], counter = { tokenCalls: 0 }) {
  const sleeps: number[] = []
  const c = new BotConnector({
    tokens: tokens(counter),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: String((init?.headers as Record<string, string>)?.Authorization), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const next = responses.shift() ?? { status: 500 }
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers })
    },
  })
  return { c, sleeps, counter }
}

describe('BotConnector', () => {
  it('posts an activity with the conversation reference filled in and returns the new id', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 201, body: { id: 'new-1' } }], calls)
    const id = await c.sendActivity(REF, buildTextActivity('hi'))
    expect(id).toBe('new-1')
    expect(calls[0].url).toBe('https://smba.trafficmanager.net/amer/v3/conversations/a%3A1conv/activities')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].auth).toBe('Bearer tok-1')
    expect(calls[0].body).toMatchObject({ type: 'message', text: 'hi', from: { id: '28:bot' }, recipient: { id: 'aad-1' }, conversation: { id: 'a:1conv' } })
  })

  it('PUTs updates and DELETEs deletions at the activity url', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 200, body: { id: 'x' } }, { status: 200 }], calls)
    await c.updateActivity(REF, 'act-9', buildTextActivity('edited'))
    await c.deleteActivity(REF, 'act-9')
    expect(calls[0].url).toBe('https://smba.trafficmanager.net/amer/v3/conversations/a%3A1conv/activities/act-9')
    expect(calls[0].method).toBe('PUT')
    expect(calls[1].method).toBe('DELETE')
  })

  it('sends a typing activity', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 200, body: {} }], calls)
    await c.sendTyping(REF)
    expect(calls[0].body).toMatchObject({ type: 'typing' })
  })

  it('refreshes the token and retries once on 401', async () => {
    const calls: Call[] = []
    const { c, counter } = connector([{ status: 401 }, { status: 201, body: { id: 'ok' } }], calls)
    expect(await c.sendActivity(REF, buildTextActivity('hi'))).toBe('ok')
    expect(counter.tokenCalls).toBe(2)
    expect(calls[1].auth).toBe('Bearer tok-2')
  })

  it('honours Retry-After once on 429', async () => {
    const calls: Call[] = []
    const { c, sleeps } = connector([{ status: 429, headers: { 'Retry-After': '3' } }, { status: 201, body: { id: 'ok' } }], calls)
    expect(await c.sendActivity(REF, buildTextActivity('hi'))).toBe('ok')
    expect(sleeps).toEqual([3000])
  })

  it('retries once after a second on 5xx, then throws', async () => {
    const calls: Call[] = []
    const { c, sleeps } = connector([{ status: 503 }, { status: 503 }], calls)
    await expect(c.sendActivity(REF, buildTextActivity('hi'))).rejects.toBeInstanceOf(ConnectorError)
    expect(sleeps).toEqual([1000])
    expect(calls).toHaveLength(2)
  })

  it('throws immediately on other client errors', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 400, body: { error: { message: 'bad' } } }], calls)
    await expect(c.sendActivity(REF, buildTextActivity('hi'))).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-connector.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the connector**

Create `src/platform/teams/connector.ts`:

```ts
/**
 * Thin Bot Connector REST client. One retry per failure class; anything
 * else surfaces as ConnectorError so the bot logs it and moves on.
 */
import { logger } from '../../logger.js'
import type { FetchLike, OutboundTokenProvider } from './auth.js'
import type { ConversationReference, OutboundActivity } from './types.js'

export class ConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export interface ConnectorOptions {
  tokens: OutboundTokenProvider
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export class BotConnector {
  private readonly tokens: OutboundTokenProvider
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ConnectorOptions) {
    this.tokens = opts.tokens
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async sendActivity(ref: ConversationReference, activity: OutboundActivity): Promise<string> {
    const json = await this.request('POST', activitiesUrl(ref), withReference(ref, activity))
    return (json as { id?: string })?.id ?? ''
  }

  async updateActivity(ref: ConversationReference, activityId: string, activity: OutboundActivity): Promise<void> {
    await this.request('PUT', activitiesUrl(ref, activityId), withReference(ref, activity))
  }

  async deleteActivity(ref: ConversationReference, activityId: string): Promise<void> {
    await this.request('DELETE', activitiesUrl(ref, activityId))
  }

  async sendTyping(ref: ConversationReference): Promise<void> {
    await this.request('POST', activitiesUrl(ref), withReference(ref, { type: 'typing' }))
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    let retried = { auth: false, throttle: false, server: false }
    for (;;) {
      const resp = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${await this.tokens.token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (resp.ok) {
        const text = await resp.text()
        return text ? JSON.parse(text) : undefined
      }
      if (resp.status === 401 && !retried.auth) {
        retried = { ...retried, auth: true }
        this.tokens.invalidate()
        continue
      }
      if (resp.status === 429 && !retried.throttle) {
        retried = { ...retried, throttle: true }
        const after = Number(resp.headers.get('Retry-After') ?? '1')
        await this.sleep((Number.isFinite(after) && after > 0 ? after : 1) * 1000)
        continue
      }
      if (resp.status >= 500 && !retried.server) {
        retried = { ...retried, server: true }
        await this.sleep(1000)
        continue
      }
      const detail = (await resp.text()).slice(0, 300)
      logger.warn({ status: resp.status, method, detail }, 'Teams: connector call failed')
      throw new ConnectorError(resp.status, `Bot Connector ${method} failed: ${resp.status} ${detail}`)
    }
  }
}

function activitiesUrl(ref: ConversationReference, activityId?: string): string {
  const base = `${ref.serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`
  return activityId ? `${base}/${encodeURIComponent(activityId)}` : base
}

function withReference(ref: ConversationReference, activity: OutboundActivity): Record<string, unknown> {
  return {
    ...activity,
    from: { id: ref.botId },
    recipient: { id: ref.userId },
    conversation: { id: ref.conversationId },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/teams-connector.test.ts && npm run typecheck`
Expected: 7 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/connector.ts tests/teams-connector.test.ts
git commit -m "Teams: Bot Connector REST client with one-retry policy"
```

---

### Task 8: Generic upload download helper

**Files:**
- Modify: `src/media.ts` (append)
- Test: `tests/teams-media.test.ts`

**Interfaces:**
- Produces: `export async function downloadToUploads(url: string, filename: string, headers?: Record<string, string>, fetchImpl?: FetchLike): Promise<string>` — saves to `UPLOADS_DIR` as `${Date.now()}_${sanitised base}${ext}`, returns the absolute path. Throws on non-2xx.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-media.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { downloadToUploads, UPLOADS_DIR } from '../src/media.js'

describe('downloadToUploads', () => {
  it('saves the body under the uploads dir with a sanitised, timestamped name', async () => {
    const seen: Array<{ url: string; headers: unknown }> = []
    const path = await downloadToUploads(
      'https://files.example/contract.pdf?sig=abc',
      'my contract (final).pdf',
      { Authorization: 'Bearer t' },
      async (url, init) => {
        seen.push({ url, headers: init?.headers })
        return new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 })
      }
    )
    expect(path.startsWith(UPLOADS_DIR)).toBe(true)
    expect(basename(path)).toMatch(/^\d+_my-contract--final-\.pdf$/)
    expect(readFileSync(path, 'utf-8')).toBe('%PDF-1.4 fake')
    expect(seen[0]).toEqual({ url: 'https://files.example/contract.pdf?sig=abc', headers: { Authorization: 'Bearer t' } })
    rmSync(path)
    expect(existsSync(path)).toBe(false)
  })

  it('throws on a non-2xx response and writes nothing', async () => {
    await expect(
      downloadToUploads('https://files.example/x.png', 'x.png', undefined, async () => new Response('nope', { status: 403 }))
    ).rejects.toThrow(/403/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-media.test.ts`
Expected: FAIL, `downloadToUploads` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/media.ts`:

```ts
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Download any URL into the uploads dir. Used by adapters whose files come
 * with a plain (or bearer-authenticated) URL rather than a Telegram file id.
 */
export async function downloadToUploads(
  url: string,
  filename: string,
  headers?: Record<string, string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<string> {
  const resp = await fetchImpl(url, { headers })
  if (!resp.ok) throw new Error(`Download failed (${resp.status}) for ${url}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  const ext = extname(filename)
  const base = sanitizeFilename(basename(filename, ext))
  const destPath = resolve(UPLOADS_DIR, `${Date.now()}_${base}${ext}`)
  writeFileSync(destPath, buffer)
  return destPath
}
```

(`extname`, `basename`, `resolve`, `writeFileSync`, `sanitizeFilename`, and `UPLOADS_DIR` already exist in `src/media.ts`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/teams-media.test.ts && npm run typecheck`
Expected: 2 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/media.ts tests/teams-media.test.ts
git commit -m "media: generic downloadToUploads for URL-based attachments"
```

---

### Task 9: TeamsAdapter, inbound side

**Files:**
- Create: `src/platform/teams/adapter.ts`
- Test: `tests/teams-adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 1-8: `registerHttpRoute`, `mapInbound`, `referenceFrom`, `initTeamsTables`, `upsertConversation`, `getConversation`, `hasProcessedActivity`, `markActivityProcessed`, `InboundTokenValidator`, `OutboundTokenProvider`, `BotConnector`, `downloadToUploads`.
- Produces:

```ts
export interface TeamsAdapterOptions extends TeamsCredentials {
  validator?: Pick<InboundTokenValidator, 'validate'>
  connector?: Pick<BotConnector, 'sendActivity' | 'updateActivity' | 'deleteActivity' | 'sendTyping'>
  tokens?: OutboundTokenProvider
  download?: typeof downloadToUploads
  registerRoute?: typeof registerHttpRoute
  now?: () => number
}
export class TeamsAdapter implements PlatformAdapter {
  constructor(opts: TeamsAdapterOptions)
  /** Exposed for tests and the integration test: the full inbound pipeline minus HTTP. */
  processActivity(activity: Activity): Promise<void>
  /** The HTTP handler registered at POST /api/teams/messages. */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>
  // plus the PlatformAdapter members; outbound ones arrive in Task 10
}
export const TEAMS_WEBHOOK_PATH = '/api/teams/messages'
```

Inbound behaviour:
1. `handleRequest`: read body up to 1 MB (413 beyond), `await validator.validate(req.headers.authorization)` → 401 empty body on failure (log at most once per minute, with a count of suppressed failures), parse JSON (400 on failure), respond `200` with empty body, then `void processActivity(activity)` wrapped in a catch that logs `{ err, activityId }`.
2. `processActivity`: call `activityHandler` (watchdog hook); if `activity.id` and `hasProcessedActivity(id)` → return; `markActivityProcessed(id)`; `referenceFrom` → `upsertConversation`; `mapInbound(activity, botId)` where `botId = activity.recipient?.id ?? '28:' + appId`; dispatch:
   - `message` → `messageHandler(message)`
   - `attachment` → `download(url, name, needsAuth ? { Authorization: 'Bearer ' + await tokens.token() } : undefined)` → `messageHandler({ ...base, filePath })`
   - `bot-added` → `messageHandler({ chatId, userId, text: '/chatid', type: 'text' })` so the user sees the id they need for `ALLOWED_CHAT_ID`
   - `ignore` → debug log

- [ ] **Step 1: Write the failing test**

Create `tests/teams-adapter.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { Readable } from 'node:stream'

// Own SQLite store for this file (see teams-conversations.test.ts).
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-adapter`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import { TeamsAdapter, TEAMS_WEBHOOK_PATH } from '../src/platform/teams/adapter.js'
import type { Activity } from '../src/platform/teams/types.js'
import type { IncomingMessage } from '../src/platform/types.js'
import { getConversation } from '../src/platform/teams/conversations.js'

const APP_ID = '11111111-2222-3333-4444-555555555555'
const BOT_ID = `28:${APP_ID}`

type Sent = { kind: 'send' | 'update' | 'delete' | 'typing'; conversationId: string; activityId?: string; activity?: unknown }

export function fakeConnector(sent: Sent[], nextId = { n: 0 }) {
  return {
    async sendActivity(ref: { conversationId: string }, activity: unknown) {
      sent.push({ kind: 'send', conversationId: ref.conversationId, activity })
      nextId.n++
      return `sent-${nextId.n}`
    },
    async updateActivity(ref: { conversationId: string }, activityId: string, activity: unknown) {
      sent.push({ kind: 'update', conversationId: ref.conversationId, activityId, activity })
    },
    async deleteActivity(ref: { conversationId: string }, activityId: string) {
      sent.push({ kind: 'delete', conversationId: ref.conversationId, activityId })
    },
    async sendTyping(ref: { conversationId: string }) {
      sent.push({ kind: 'typing', conversationId: ref.conversationId })
    },
  }
}

export function inbound(overrides: Partial<Activity>): Activity {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
    from: { id: '29:1abc', aadObjectId: 'aad-marc' },
    recipient: { id: BOT_ID },
    conversation: { id: 'a:1conv', tenantId: 't1' },
    ...overrides,
  }
}

function makeAdapter(sent: Sent[], extra: Partial<ConstructorParameters<typeof TeamsAdapter>[0]> = {}) {
  const routes: Array<{ method: string; path: string }> = []
  const adapter = new TeamsAdapter({
    appId: APP_ID,
    appSecret: 'secret',
    validator: { validate: async (h) => h === 'Bearer good' },
    connector: fakeConnector(sent),
    registerRoute: (method, path) => {
      routes.push({ method, path })
      return () => routes.pop()
    },
    ...extra,
  })
  return { adapter, routes }
}

describe('TeamsAdapter inbound', () => {
  let sent: Sent[]
  let received: IncomingMessage[]

  beforeEach(() => {
    sent = []
    received = []
  })

  it('registers the webhook on start and unregisters on stop', async () => {
    const { adapter, routes } = makeAdapter(sent)
    await adapter.start()
    expect(routes).toEqual([{ method: 'POST', path: TEAMS_WEBHOOK_PATH }])
    await adapter.stop()
    expect(routes).toEqual([])
  })

  it('stores the conversation reference and hands a text message to the bot', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ id: 'act-1', text: 'hello' }))
    expect(received).toEqual([{ chatId: 'a:1conv', userId: 'aad-marc', text: 'hello', type: 'text', messageId: 'act-1', updateId: 'act-1' }])
    expect(getConversation('a:1conv')).toMatchObject({ serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: BOT_ID, userId: 'aad-marc', tenantId: 't1' })
  })

  it('processes a duplicate activity id only once', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ id: 'act-dup', text: 'one' }))
    await adapter.processActivity(inbound({ id: 'act-dup', text: 'one again' }))
    expect(received).toHaveLength(1)
  })

  it('downloads an attachment, with the bot token only when the url needs it', async () => {
    const downloads: Array<{ url: string; name: string; headers?: Record<string, string> }> = []
    const { adapter } = makeAdapter(sent, {
      download: async (url, name, headers) => {
        downloads.push({ url, name, headers })
        return `/tmp/uploads/${name}`
      },
      tokens: { token: async () => 'bot-token', invalidate: () => {} } as never,
    })
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(
      inbound({
        text: 'see attached',
        attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'a.pdf', content: { downloadUrl: 'https://f/a.pdf' } }],
      })
    )
    await adapter.processActivity(inbound({ attachments: [{ contentType: 'image/png', contentUrl: 'https://smba/att/1' }] }))
    expect(downloads[0]).toEqual({ url: 'https://f/a.pdf', name: 'a.pdf', headers: undefined })
    expect(downloads[1].headers).toEqual({ Authorization: 'Bearer bot-token' })
    expect(received[0]).toMatchObject({ type: 'document', filePath: '/tmp/uploads/a.pdf', fileName: 'a.pdf', caption: 'see attached' })
    expect(received[1]).toMatchObject({ type: 'photo', filePath: expect.stringMatching(/\.png$/) })
  })

  it('turns the bot being added into a /chatid so the owner learns the id to allow', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ type: 'conversationUpdate', membersAdded: [{ id: BOT_ID }] }))
    expect(received[0]).toMatchObject({ chatId: 'a:1conv', text: '/chatid', type: 'text' })
  })

  it('calls the activity hook on every inbound activity', async () => {
    const { adapter } = makeAdapter(sent)
    let ticks = 0
    adapter.onActivity(() => ticks++)
    adapter.onMessage(async () => {})
    await adapter.processActivity(inbound({ type: 'invoke' }))
    await adapter.processActivity(inbound({ text: 'x' }))
    expect(ticks).toBe(2)
  })
})

describe('TeamsAdapter.handleRequest', () => {
  function request(body: string, auth?: string) {
    const req = Readable.from([Buffer.from(body)]) as unknown as import('node:http').IncomingMessage
    ;(req as { headers: Record<string, string> }).headers = auth ? { authorization: auth } : {}
    const out: { status?: number; body: string } = { body: '' }
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out.status = status
        this.headersSent = true
        return this
      },
      end(chunk?: string) {
        if (chunk) out.body += chunk
      },
    } as unknown as import('node:http').ServerResponse
    return { req, res, out }
  }

  it('answers 401 with an empty body when the token is bad', async () => {
    const { adapter } = makeAdapter([])
    const { req, res, out } = request('{}', 'Bearer bad')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(401)
    expect(out.body).toBe('')
  })

  it('answers 400 for malformed JSON', async () => {
    const { adapter } = makeAdapter([])
    const { req, res, out } = request('{not json', 'Bearer good')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(400)
  })

  it('answers 200 before the bot has finished processing', async () => {
    const { adapter } = makeAdapter([])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let handled = false
    adapter.onMessage(async () => {
      await gate
      handled = true
    })
    const { req, res, out } = request(JSON.stringify(inbound({ id: 'act-slow', text: 'slow' })), 'Bearer good')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(200)
    expect(handled).toBe(false)
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(handled).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-adapter.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the adapter (inbound side; outbound methods are stubs that throw until Task 10)**

Create `src/platform/teams/adapter.ts`:

```ts
/**
 * Microsoft Teams platform adapter (1:1 personal chat).
 *
 * Inbound: Microsoft POSTs activities to /api/teams/messages on the app's
 * own HTTP server (Caddy proxies exactly that path from 443). We verify the
 * Bot Framework JWT, answer 200 right away, and process asynchronously.
 * Outbound: Bot Connector REST calls using the conversation reference stored
 * on the last inbound activity, so scheduled/proactive sends work.
 *
 * Every collaborator is injectable so the unit tests run without a network,
 * a database directory, or a listening socket.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http'
import { registerHttpRoute } from '../../http-server.js'
import { logger } from '../../logger.js'
import { downloadToUploads } from '../../media.js'
import type { PlatformAdapter, IncomingMessage, SendOptions } from '../types.js'
import { mapInbound, referenceFrom } from './activities.js'
import { InboundTokenValidator, OutboundTokenProvider } from './auth.js'
import { BotConnector } from './connector.js'
import {
  getConversation,
  hasProcessedActivity,
  initTeamsTables,
  markActivityProcessed,
  upsertConversation,
} from './conversations.js'
import type { Activity, ConversationReference, TeamsCredentials } from './types.js'

export const TEAMS_WEBHOOK_PATH = '/api/teams/messages'
const MAX_BODY_BYTES = 1_000_000
const AUTH_LOG_INTERVAL_MS = 60_000

export interface TeamsAdapterOptions extends TeamsCredentials {
  validator?: Pick<InboundTokenValidator, 'validate'>
  connector?: Pick<BotConnector, 'sendActivity' | 'updateActivity' | 'deleteActivity' | 'sendTyping'>
  tokens?: OutboundTokenProvider
  download?: typeof downloadToUploads
  registerRoute?: typeof registerHttpRoute
  now?: () => number
}

export class TeamsAdapter implements PlatformAdapter {
  readonly name = 'teams' as const
  readonly maxMessageLength = 8000
  readonly supportsEdit = true
  readonly supportsButtons = true

  private readonly appId: string
  private readonly validator: Pick<InboundTokenValidator, 'validate'>
  private readonly connector: Pick<BotConnector, 'sendActivity' | 'updateActivity' | 'deleteActivity' | 'sendTyping'>
  private readonly tokens: OutboundTokenProvider
  private readonly download: typeof downloadToUploads
  private readonly registerRoute: typeof registerHttpRoute
  private readonly now: () => number
  private unregister: (() => void) | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private activityHandler: (() => void) | null = null
  private authFailures = { lastLoggedAt: 0, suppressed: 0 }

  constructor(opts: TeamsAdapterOptions) {
    this.appId = opts.appId
    this.now = opts.now ?? (() => Date.now())
    this.tokens = opts.tokens ?? new OutboundTokenProvider({ appId: opts.appId, appSecret: opts.appSecret, tenantId: opts.tenantId })
    this.validator = opts.validator ?? new InboundTokenValidator({ appId: opts.appId })
    this.connector = opts.connector ?? new BotConnector({ tokens: this.tokens })
    this.download = opts.download ?? downloadToUploads
    this.registerRoute = opts.registerRoute ?? registerHttpRoute
    // Tables exist from construction so processActivity works in tests that
    // never call start(); CREATE IF NOT EXISTS makes this idempotent.
    initTeamsTables()
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.unregister = this.registerRoute('POST', TEAMS_WEBHOOK_PATH, (req, res) => this.handleRequest(req, res))
    logger.info({ path: TEAMS_WEBHOOK_PATH }, 'Teams adapter started (webhook registered)')
  }

  async stop(): Promise<void> {
    this.unregister?.()
    this.unregister = null
    this.tokens.invalidate()
  }

  // --- Events ---

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onActivity(handler: () => void): void {
    this.activityHandler = handler
  }

  // --- Inbound ---

  async handleRequest(req: HttpRequest, res: ServerResponse): Promise<void> {
    let body: string
    try {
      body = await readBodyLimited(req, MAX_BODY_BYTES)
    } catch {
      res.writeHead(413)
      res.end()
      return
    }
    if (!(await this.validator.validate(req.headers.authorization))) {
      this.logAuthFailure()
      res.writeHead(401)
      res.end()
      return
    }
    let activity: Activity
    try {
      activity = JSON.parse(body) as Activity
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    res.writeHead(200)
    res.end()
    void this.processActivity(activity).catch((err) => {
      logger.error({ err, activityId: activity.id, type: activity.type }, 'Teams: failed to process activity')
    })
  }

  async processActivity(activity: Activity): Promise<void> {
    this.activityHandler?.()
    if (activity.id) {
      if (hasProcessedActivity(activity.id)) {
        logger.debug({ activityId: activity.id }, 'Teams: duplicate activity ignored')
        return
      }
      markActivityProcessed(activity.id)
    }
    const ref = referenceFrom(activity)
    if (ref) upsertConversation(ref)

    const botId = activity.recipient?.id ?? `28:${this.appId}`
    const mapped = mapInbound(activity, botId)
    switch (mapped.kind) {
      case 'message':
        await this.messageHandler?.(mapped.message)
        return
      case 'attachment': {
        const headers = mapped.download.needsAuth ? { Authorization: `Bearer ${await this.tokens.token()}` } : undefined
        const filePath = await this.download(mapped.download.url, mapped.download.name, headers)
        await this.messageHandler?.({ ...mapped.base, filePath })
        return
      }
      case 'bot-added':
        if (ref) await this.messageHandler?.({ chatId: ref.conversationId, userId: ref.userId, text: '/chatid', type: 'text' })
        return
      case 'ignore':
        logger.debug({ reason: mapped.reason, type: activity.type }, 'Teams: activity ignored')
        return
    }
  }

  private logAuthFailure(): void {
    const t = this.now()
    if (t - this.authFailures.lastLoggedAt >= AUTH_LOG_INTERVAL_MS) {
      logger.warn({ suppressedSinceLast: this.authFailures.suppressed }, 'Teams: rejected request with invalid Bot Framework token')
      this.authFailures = { lastLoggedAt: t, suppressed: 0 }
    } else {
      this.authFailures.suppressed++
    }
  }

  protected reference(chatId: string): ConversationReference {
    const ref = getConversation(chatId)
    if (!ref) throw new Error(`Teams: no conversation reference for ${chatId}; the user has to message the bot first`)
    return ref
  }

  // --- Outbound (implemented in Task 10) ---

  async sendMessage(_chatId: string, _text: string, _options?: SendOptions): Promise<string> {
    throw new Error('not implemented')
  }
  async editMessage(_chatId: string, _messageId: string, _text: string, _options?: SendOptions): Promise<void> {
    throw new Error('not implemented')
  }
  async sendTyping(_chatId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async sendFile(_chatId: string, _filePath: string, _type: 'voice' | 'document'): Promise<void> {
    throw new Error('not implemented')
  }
  async answerCallback(_callbackId: string, _text?: string): Promise<void> {}
  async clearButtons(_chatId: string, _messageId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async deleteMessage(_chatId: string, _messageId: string): Promise<boolean> {
    return false
  }
  formatText(markdown: string): string {
    return markdown
  }
  splitMessage(text: string): string[] {
    return [text]
  }
}

function readBodyLimited(req: HttpRequest, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/teams-adapter.test.ts && npm run typecheck`
Expected: 9 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/adapter.ts tests/teams-adapter.test.ts
git commit -m "Teams: adapter inbound pipeline (webhook, JWT gate, dedupe, mapping, downloads)"
```

---

### Task 10: TeamsAdapter, outbound side

**Files:**
- Modify: `src/platform/teams/adapter.ts` (replace the Task 9 stubs)
- Test: `tests/teams-adapter.test.ts` (append)

**Interfaces:**
- Consumes: `buildTextActivity`, `buildCardActivity`, `buildClearedCardActivity`, `formatForTeams` from `./activities.js`; `connector`.
- Produces the remaining `PlatformAdapter` members:
  - `sendMessage(chatId, text, options)`: card when `options?.buttons?.length`, text otherwise; remembers `{ activityId → text }` for cards so `clearButtons` can replace them; returns the activity id.
  - `editMessage(chatId, messageId, text)`: throttled per conversation to one PUT per second; an edit arriving inside the window is queued and the **latest** queued text is sent when the window closes (earlier queued edits are dropped). Returns immediately for queued edits.
  - `sendTyping(chatId)`.
  - `clearButtons(chatId, messageId)`: PUT the remembered text as a plain message; if nothing is remembered (process restarted since the card), no-op with a debug log.
  - `sendFile(chatId, filePath, type)`: sends the note `Saved on the assistant's machine as <basename>. Sending files into Teams is not supported yet.`
  - `deleteMessage`: `false`. `answerCallback`: no-op.
  - `formatText` = `formatForTeams`; `splitMessage` = paragraph/line/space split at 8000 (same algorithm as Telegram's `splitMessageImpl`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/teams-adapter.test.ts`:

```ts
import { upsertConversation } from '../src/platform/teams/conversations.js'

describe('TeamsAdapter outbound', () => {
  const REF = { conversationId: 'a:out', serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: BOT_ID, userId: 'aad-marc' }
  let sent: Sent[]

  beforeEach(() => {
    sent = []
    upsertConversation(REF)
  })

  it('sends markdown text and returns the activity id', async () => {
    const { adapter } = makeAdapter(sent)
    const id = await adapter.sendMessage('a:out', 'hi **there**')
    expect(id).toBe('sent-1')
    expect(sent[0]).toMatchObject({ kind: 'send', conversationId: 'a:out', activity: { type: 'message', text: 'hi **there**', textFormat: 'markdown' } })
  })

  it('sends a card when buttons are requested, and clears it by replacing with plain text', async () => {
    const { adapter } = makeAdapter(sent)
    const id = await adapter.sendMessage('a:out', 'Send this?', { buttons: ['Send', 'Discard'] })
    expect((sent[0].activity as { attachments: unknown[] }).attachments).toHaveLength(1)
    await adapter.clearButtons('a:out', id)
    expect(sent[1]).toMatchObject({ kind: 'update', activityId: id, activity: { type: 'message', text: 'Send this?' } })
  })

  it('is a no-op when asked to clear buttons on a card it does not remember', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.clearButtons('a:out', 'forgotten')
    expect(sent).toEqual([])
  })

  it('throws a clear error when no conversation reference exists yet', async () => {
    const { adapter } = makeAdapter(sent)
    await expect(adapter.sendMessage('a:never', 'x')).rejects.toThrow(/message the bot first/)
  })

  it('sends typing', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.sendTyping('a:out')
    expect(sent[0]).toMatchObject({ kind: 'typing', conversationId: 'a:out' })
  })

  it('throttles edits to one per second per conversation and always lands the latest text', async () => {
    let clock = 10_000
    const { adapter } = makeAdapter(sent, { now: () => clock })
    await adapter.editMessage('a:out', 'm1', 'v1')
    expect(sent).toHaveLength(1)
    clock += 200
    await adapter.editMessage('a:out', 'm1', 'v2')
    clock += 200
    await adapter.editMessage('a:out', 'm1', 'v3')
    expect(sent).toHaveLength(1) // v2 and v3 queued, v2 dropped
    await new Promise((r) => setTimeout(r, 950)) // timer fires at 1000 - 200 = 800 ms real time
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ kind: 'update', activityId: 'm1', activity: { text: 'v3' } })
  })

  it('explains instead of sending files, and refuses to delete user messages', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.sendFile('a:out', '/tmp/x/report.pdf', 'document')
    expect((sent[0].activity as { text: string }).text).toMatch(/report\.pdf/)
    expect(await adapter.deleteMessage('a:out', 'm1')).toBe(false)
  })

  it('formats and splits', () => {
    const { adapter } = makeAdapter(sent)
    expect(adapter.formatText('# T\n<b>x</b>')).toBe('**T**\n**x**')
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const chunks = adapter.splitMessage(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8000)
    expect(chunks.join('\n')).toBe(long)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/teams-adapter.test.ts`
Expected: the new block fails with "not implemented".

- [ ] **Step 3: Implement the outbound side**

In `src/platform/teams/adapter.ts`, extend the imports:

```ts
import { basename } from 'node:path'
import { buildCardActivity, buildClearedCardActivity, buildTextActivity, formatForTeams, mapInbound, referenceFrom } from './activities.js'
```

(replace the existing `import { mapInbound, referenceFrom } from './activities.js'` line.)

Add these fields to the class, next to `authFailures`:

```ts
  private cardTexts = new Map<string, string>()
  private edits = new Map<string, { lastSentAt: number; pending?: { activityId: string; text: string }; timer?: NodeJS.Timeout }>()
```

Add the constant next to `AUTH_LOG_INTERVAL_MS`:

```ts
const EDIT_INTERVAL_MS = 1000
```

Replace everything from the `// --- Outbound (implemented in Task 10) ---` comment to the end of the class with:

```ts
  // --- Outbound ---

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string> {
    const ref = this.reference(chatId)
    const buttons = options?.buttons?.filter((b) => b.trim()) ?? []
    const activity = buttons.length ? buildCardActivity(text, buttons) : buildTextActivity(text)
    const id = await this.connector.sendActivity(ref, activity)
    if (buttons.length && id) this.cardTexts.set(id, text)
    return id
  }

  /**
   * Teams throttles bots well below Telegram's edit rate. One PUT per second
   * per conversation; edits inside the window are coalesced and the latest
   * text goes out when the window closes.
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const ref = this.reference(chatId)
    const state = this.edits.get(chatId) ?? { lastSentAt: 0 }
    this.edits.set(chatId, state)
    const elapsed = this.now() - state.lastSentAt
    if (elapsed >= EDIT_INTERVAL_MS && !state.timer) {
      state.lastSentAt = this.now()
      await this.connector.updateActivity(ref, messageId, buildTextActivity(text))
      return
    }
    state.pending = { activityId: messageId, text }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        const pending = state.pending
        state.pending = undefined
        if (!pending) return
        state.lastSentAt = this.now()
        this.connector.updateActivity(ref, pending.activityId, buildTextActivity(pending.text)).catch((err) => {
          logger.warn({ err, chatId }, 'Teams: coalesced edit failed')
        })
      }, Math.max(0, EDIT_INTERVAL_MS - elapsed))
      state.timer.unref?.()
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.connector.sendTyping(this.reference(chatId))
  }

  async sendFile(chatId: string, filePath: string, _type: 'voice' | 'document'): Promise<void> {
    await this.sendMessage(
      chatId,
      `Saved on the assistant's machine as ${basename(filePath)}. Sending files into Teams is not supported yet.`
    )
  }

  async answerCallback(_callbackId: string, _text?: string): Promise<void> {
    // messageBack clicks arrive as ordinary messages; nothing to acknowledge.
  }

  async clearButtons(chatId: string, messageId: string): Promise<void> {
    const text = this.cardTexts.get(messageId)
    if (text === undefined) {
      logger.debug({ messageId }, 'Teams: no remembered card to clear (restarted since it was sent?)')
      return
    }
    await this.connector.updateActivity(this.reference(chatId), messageId, buildClearedCardActivity(text))
    this.cardTexts.delete(messageId)
  }

  async deleteMessage(_chatId: string, _messageId: string): Promise<boolean> {
    // Bots cannot delete a user's message in Teams; the caller tells the user.
    return false
  }

  formatText(markdown: string): string {
    return formatForTeams(markdown)
  }

  splitMessage(text: string): string[] {
    const limit = this.maxMessageLength
    if (text.length <= limit) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', limit)
      if (splitAt === -1 || splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit)
      if (splitAt === -1 || splitAt < limit * 0.5) splitAt = limit
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).replace(/^[ \n]/, '')
    }
    return chunks
  }
}
```

Keep the `readBodyLimited` function after the class as it was.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/teams-adapter.test.ts && npm run typecheck`
Expected: 17 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/adapter.ts tests/teams-adapter.test.ts
git commit -m "Teams: adapter outbound side (text, cards, throttled edits, typing, clears)"
```

---

### Task 11: Platform wiring and setup wizard

**Files:**
- Modify: `src/platform/index.ts:14-24` (detect) and `:53-54` (create)
- Modify: `src/setup/plan.ts:82-87` (`PLATFORM_ENV.Teams`)
- Modify: `scripts/setup.ts:146-152` (prompts) and `:166-168` (env substitution) and `:270` (`needsBotCredentials`)
- Test: `tests/teams-wiring.test.ts`, `tests/setup-plan.test.ts` (append if it exists; otherwise the assertion goes in `tests/teams-wiring.test.ts`)

**Interfaces:**
- `detectPlatform()` returns `'teams'` when `TEAMS_APP_ID` and `TEAMS_APP_SECRET` are both set and no explicit `PLATFORM`, checked after Slack and before Telegram.
- `createAdapter()` case `'teams'` constructs `new TeamsAdapter({ appId, appSecret, tenantId })`, throwing `TEAMS_APP_ID and TEAMS_APP_SECRET must both be set in .env` when either is missing.
- `PLATFORM_ENV.Teams` becomes `['TEAMS_APP_ID=', 'TEAMS_APP_SECRET=', 'TEAMS_TENANT_ID=', 'ALLOWED_CHAT_ID=']`.

- [ ] **Step 1: Write the failing tests**

Create `tests/teams-wiring.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'

const envState: { env: Record<string, string> } = { env: {} }
vi.mock('../src/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, readEnvFile: () => envState.env }
})

import { detectPlatform, createAdapter } from '../src/platform/index.js'
import { buildEnvContent } from '../src/setup/plan.js'

afterEach(() => {
  envState.env = {}
})

describe('Teams platform wiring', () => {
  it('auto-detects teams from its credentials, after slack, before telegram', () => {
    envState.env = { TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's', TELEGRAM_BOT_TOKEN: 't' }
    expect(detectPlatform()).toBe('teams')
    envState.env = { TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's', SLACK_BOT_TOKEN: 'b', SLACK_APP_TOKEN: 'x' }
    expect(detectPlatform()).toBe('slack')
    envState.env = { TEAMS_APP_ID: 'a' }
    expect(detectPlatform()).toBe('telegram')
  })

  it('creates a TeamsAdapter when credentials are present and explains when they are not', async () => {
    envState.env = { PLATFORM: 'teams', TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's' }
    const adapter = await createAdapter()
    expect(adapter.name).toBe('teams')
    envState.env = { PLATFORM: 'teams', TEAMS_APP_ID: 'a' }
    await expect(createAdapter()).rejects.toThrow(/TEAMS_APP_ID and TEAMS_APP_SECRET/)
  })

  it('writes the four Teams keys into a fresh .env', () => {
    const env = buildEnvContent({
      ownerName: 'Marc', assistantName: 'Nami', timezone: 'America/Toronto', city: 'Toronto',
      platform: 'Teams', engine: 'later', personalityVibe: 'Direct', ownerBio: 'x',
      emailProvider: 'Skip for now', gmailAddress: '', gmailAddress2: '', outlookAddress: '', outlookAddress2: '',
      emailSignature: '', latitude: '0', longitude: '0', tempUnit: 'celsius',
      keys: {}, skills: { webResearch: false, apollo: false, wordsmith: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    } as never)
    for (const k of ['TEAMS_APP_ID=', 'TEAMS_APP_SECRET=', 'TEAMS_TENANT_ID=', 'ALLOWED_CHAT_ID=']) expect(env).toContain(k)
  })
})
```

If the `Answers` type in `src/setup/wizard.ts` has fields this literal lacks, add them with empty-string/false values; the `as never` cast keeps the test compiling while the shape evolves, and `buildEnvContent` only reads `platform`, `timezone`, `keys`, `skills`, and the email fields.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/teams-wiring.test.ts`
Expected: FAIL on detection (`telegram` instead of `teams`), creation ("not yet implemented"), and the missing `ALLOWED_CHAT_ID=` key.

- [ ] **Step 3: Wire the platform**

In `src/platform/index.ts`, change the auto-detect block to:

```ts
  // Auto-detect from available tokens
  if (env['SLACK_BOT_TOKEN'] && env['SLACK_APP_TOKEN']) return 'slack'
  if (env['TEAMS_APP_ID'] && env['TEAMS_APP_SECRET']) return 'teams'
  if (env['TELEGRAM_BOT_TOKEN']) return 'telegram'
```

Replace the `case 'teams':` block with:

```ts
    case 'teams': {
      const appId = env['TEAMS_APP_ID']
      const appSecret = env['TEAMS_APP_SECRET']
      if (!appId || !appSecret) {
        throw new Error('TEAMS_APP_ID and TEAMS_APP_SECRET must both be set in .env')
      }
      const { TeamsAdapter } = await import('./teams/adapter.js')
      return new TeamsAdapter({ appId, appSecret, tenantId: env['TEAMS_TENANT_ID'] || undefined })
    }
```

In `src/setup/plan.ts`, change the Teams line of `PLATFORM_ENV` to:

```ts
  Teams: ['TEAMS_APP_ID=', 'TEAMS_APP_SECRET=', 'TEAMS_TENANT_ID=', 'ALLOWED_CHAT_ID='],
```

In `scripts/setup.ts`, after the Telegram prompt block, add:

```ts
  let teamsAppId = ''
  let teamsAppSecret = ''
  let teamsTenantId = ''
  if (answers.platform === 'Teams') {
    prompter.say('Register the bot first (docs/HOSTED-VPS.md > Teams, or scripts/teams-register.sh). Blank = fill in later.')
    teamsAppId = await prompter.ask('Teams app (client) ID', '')
    teamsAppSecret = await prompter.ask('Teams app secret', '')
    teamsTenantId = await prompter.ask('Tenant ID (blank for a multi-tenant registration)', '')
    chatId = await prompter.ask('Your Teams chat ID (send anything to the bot later; it replies with /chatid if unknown)', '')
  }
```

In the env-writing block, after the two Telegram `replace` lines, add:

```ts
    if (teamsAppId) env = env.replace('TEAMS_APP_ID=', `TEAMS_APP_ID=${teamsAppId}`)
    if (teamsAppSecret) env = env.replace('TEAMS_APP_SECRET=', `TEAMS_APP_SECRET=${teamsAppSecret}`)
    if (teamsTenantId) env = env.replace('TEAMS_TENANT_ID=', `TEAMS_TENANT_ID=${teamsTenantId}`)
```

Change the `needsBotCredentials` expression to:

```ts
      needsBotCredentials:
        answers.platform === 'Teams' ? !teamsAppId || !teamsAppSecret || !chatId : !botToken || !chatId,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/teams-wiring.test.ts tests/setup*.test.ts && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/platform/index.ts src/setup/plan.ts scripts/setup.ts tests/teams-wiring.test.ts
git commit -m "Teams: platform detection, adapter construction, setup wizard prompts"
```

---

### Task 12: Integration test through the real HTTP server

**Files:**
- Test: `tests/teams-integration.test.ts`

**Interfaces:**
- Consumes: everything above. Uses the real `startHttpServer(port)`, the real `TeamsAdapter` with a real `InboundTokenValidator` fed a test JWKS via `fetchImpl`, and a fake Bot Connector server (`node:http`) as `serviceUrl`.

- [ ] **Step 1: Write the test**

Create `tests/teams-integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

// Own SQLite store for this file (see teams-conversations.test.ts).
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-integration`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

import { startHttpServer, stopHttpServer } from '../src/http-server.js'
import { TeamsAdapter } from '../src/platform/teams/adapter.js'
import { InboundTokenValidator, OutboundTokenProvider, BOT_FRAMEWORK_ISSUER } from '../src/platform/teams/auth.js'
import { BotConnector } from '../src/platform/teams/connector.js'
import type { IncomingMessage } from '../src/platform/types.js'

const APP_ID = '11111111-2222-3333-4444-555555555555'
const APP_PORT = 3800 + Math.floor(Math.random() * 100)

let privateKey: PrivateKey
let jwks: { keys: Record<string, unknown>[] }
let connectorServer: Server
let connectorUrl: string
const connectorCalls: Array<{ method: string; url: string; body: unknown }> = []

beforeAll(async () => {
  const kp = await generateKeyPair('RS256')
  privateKey = kp.privateKey
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }

  connectorServer = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      connectorCalls.push({ method: req.method ?? '', url: req.url ?? '', body: data ? JSON.parse(data) : undefined })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: `reply-${connectorCalls.length}` }))
    })
  })
  await new Promise<void>((r) => connectorServer.listen(0, '127.0.0.1', () => r()))
  const addr = connectorServer.address() as { port: number }
  connectorUrl = `http://127.0.0.1:${addr.port}/`
})

afterAll(async () => {
  await stopHttpServer()
  await new Promise<void>((r) => connectorServer.close(() => r()))
})

async function signed(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(BOT_FRAMEWORK_ISSUER)
    .setAudience(APP_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(privateKey)
}

describe('Teams end to end (HTTP in, connector out)', () => {
  it('accepts a signed activity, answers 200 first, and replies through the connector', async () => {
    const metaFetch = async (url: string): Promise<Response> =>
      url.endsWith('/openid')
        ? new Response(JSON.stringify({ jwks_uri: 'https://login.example/keys' }), { status: 200 })
        : new Response(JSON.stringify(jwks), { status: 200 })
    const tokens = new OutboundTokenProvider({
      appId: APP_ID,
      appSecret: 's',
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'bot-tok', expires_in: 3600 }), { status: 200 }),
    })
    const adapter = new TeamsAdapter({
      appId: APP_ID,
      appSecret: 's',
      validator: new InboundTokenValidator({ appId: APP_ID, fetchImpl: metaFetch, openIdConfigUrl: 'https://login.example/openid' }),
      tokens,
      connector: new BotConnector({ tokens }), // real fetch, against the local fake connector
    })
    const received: IncomingMessage[] = []
    adapter.onMessage(async (m) => {
      received.push(m)
      await adapter.sendTyping(m.chatId)
      await adapter.sendMessage(m.chatId, `echo: ${m.text}`)
    })
    await adapter.start()
    startHttpServer(APP_PORT)

    const activity = {
      type: 'message',
      id: 'e2e-1',
      text: 'ping',
      serviceUrl: connectorUrl,
      channelId: 'msteams',
      from: { id: '29:u', aadObjectId: 'aad-u' },
      recipient: { id: `28:${APP_ID}` },
      conversation: { id: 'a:e2e' },
    }
    const t0 = Date.now()
    const resp = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signed()}` },
      body: JSON.stringify(activity),
    })
    expect(resp.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(2000)

    await new Promise((r) => setTimeout(r, 200))
    expect(received).toHaveLength(1)
    expect(connectorCalls.map((c) => (c.body as { type: string }).type)).toEqual(['typing', 'message'])
    expect(connectorCalls[1].url).toBe('/v3/conversations/a%3Ae2e/activities')
    expect((connectorCalls[1].body as { text: string }).text).toBe('echo: ping')

    const dup = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signed()}` },
      body: JSON.stringify(activity),
    })
    expect(dup.status).toBe(200)
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toHaveLength(1)

    const bad = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ ...activity, id: 'e2e-2' }),
    })
    expect(bad.status).toBe(401)
    expect(received).toHaveLength(1)
    await adapter.stop()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/teams-integration.test.ts`
Expected: 1 passed. If it fails, the failure points at a seam bug in Tasks 1, 7, or 9; fix there, re-run that task's tests, then this one.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/teams-integration.test.ts
git commit -m "Teams: end-to-end test through the HTTP server and a fake Bot Connector"
```

---

### Task 13: `enable-teams.sh` on the box, and the runbook section

**Files:**
- Create: `scripts/hosted/enable-teams.sh`
- Modify: `docs/HOSTED-VPS.md` (security posture bullet list near line 14; new section before "## Updates, snapshots, backups")
- Test: `tests/teams-hosted-scripts.test.ts`

**Interfaces:**
- `scripts/hosted/enable-teams.sh <hostname>`: run as root on an Ubuntu 24.04 box provisioned by the cloud-init kit. Installs Caddy, writes `/etc/caddy/Caddyfile` proxying only `/api/teams/*` to `127.0.0.1:3030`, opens ufw 80/443, enables Caddy, prints the messaging endpoint. Idempotent.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-hosted-scripts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENABLE = join(ROOT, 'scripts', 'hosted', 'enable-teams.sh')
const REGISTER = join(ROOT, 'scripts', 'teams-register.sh')

describe('enable-teams.sh', () => {
  const text = () => readFileSync(ENABLE, 'utf-8')

  it('exists, is valid bash, and refuses to run without a hostname', () => {
    expect(existsSync(ENABLE)).toBe(true)
    execFileSync('bash', ['-n', ENABLE])
    expect(text()).toMatch(/set -euo pipefail/)
    expect(text()).toMatch(/Usage: .*enable-teams\.sh <hostname>/)
  })

  it('proxies only the Teams webhook path and opens only 80 and 443', () => {
    const t = text()
    expect(t).toContain('handle /api/teams/* {')
    expect(t).toContain('reverse_proxy 127.0.0.1:3030')
    expect(t).toContain('respond 404')
    expect(t).toMatch(/ufw allow 80\/tcp/)
    expect(t).toMatch(/ufw allow 443\/tcp/)
    expect(t).not.toMatch(/ufw allow 3030/)
    expect(t).toContain('/api/teams/messages')
  })
})

describe('teams-register.sh', () => {
  it('exists, is valid bash, never takes a secret on argv, and sets the messaging endpoint', () => {
    expect(existsSync(REGISTER)).toBe(true)
    execFileSync('bash', ['-n', REGISTER])
    const t = readFileSync(REGISTER, 'utf-8')
    expect(t).toMatch(/set -euo pipefail/)
    expect(t).toContain('az ad app create')
    expect(t).toContain('az bot create')
    expect(t).toContain('az bot msteams create')
    expect(t).toContain('/api/teams/messages')
    expect(t).not.toMatch(/--password|--secret\s+\$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-hosted-scripts.test.ts`
Expected: FAIL, files do not exist. (The `teams-register.sh` block keeps failing until Task 14; that is expected.)

- [ ] **Step 3: Write the script**

Create `scripts/hosted/enable-teams.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# Expose the Teams webhook on a hosted Havn box.
#
# Run as root, once, after the server exists and cloud-init has finished:
#   sudo bash /home/havn/havn/scripts/hosted/enable-teams.sh 5-161-197-79.sslip.io
#
# What it does, and nothing else:
#   - installs Caddy (Ubuntu 24.04 universe) for automatic Let's Encrypt TLS
#   - proxies ONLY https://<hostname>/api/teams/* to the app on 127.0.0.1:3030;
#     every other path answers 404, so the cockpit/voice surfaces stay private
#   - opens ufw 80/tcp (ACME HTTP-01 challenge) and 443/tcp; 3030 stays closed
#   - prints the messaging endpoint to paste into the Azure Bot registration
#
# sslip.io turns an IP into a resolvable name (1-2-3-4.sslip.io) so there is no
# DNS to manage; an owned subdomain works the same way.
set -euo pipefail

HOSTNAME_ARG="${1:-}"
if [[ -z "$HOSTNAME_ARG" ]]; then
  echo "Usage: enable-teams.sh <hostname>   (e.g. 5-161-197-79.sslip.io)" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
if ! [[ "$HOSTNAME_ARG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Not a valid hostname: $HOSTNAME_ARG" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<CADDY
# Havn: Teams webhook only. Written by scripts/hosted/enable-teams.sh.
${HOSTNAME_ARG} {
	handle /api/teams/* {
		reverse_proxy 127.0.0.1:3030
	}
	handle {
		respond 404
	}
}
CADDY

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null

systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

echo "Teams webhook exposed."
echo "  Messaging endpoint: https://${HOSTNAME_ARG}/api/teams/messages"
echo "  Caddy will obtain the certificate on first request; give it a minute."
echo "  Check: curl -si https://${HOSTNAME_ARG}/api/teams/messages | head -1   (expect 401 from the app, 404 elsewhere)"
```

Run: `chmod +x scripts/hosted/enable-teams.sh`

- [ ] **Step 4: Add the runbook section**

In `docs/HOSTED-VPS.md`, in the "Security posture" list, after the bullet that begins `- **The app's local HTTP port stays closed.**`, add:

```markdown
- **Teams is the one exception to "nothing inbound."** Microsoft delivers
  Teams messages by HTTPS POST, so a Teams install runs Caddy on 443 (and 80
  for the certificate challenge) proxying exactly one path,
  `/api/teams/*`, to the app. Every request on it must carry a Bot Framework
  token signed for this bot's app id; everything else on 443 is a 404. See
  "Teams instead of Telegram" below.
```

Before the `## Updates, snapshots, backups` heading, add:

```markdown
## Teams instead of Telegram

One Azure Bot per install, like one BotFather bot per install. Do this after
the box is provisioned and `npm run setup` has run (choose Teams there, leave
the credentials blank).

1. **Expose the webhook.** On the box, as root:

   ```bash
   sudo bash /home/havn/havn/scripts/hosted/enable-teams.sh <ip-with-dashes>.sslip.io
   ```

   Use the box's public IP with dots replaced by dashes (`5.161.197.79` →
   `5-161-197-79.sslip.io`), or a subdomain you control that points at the IP.
   It prints the messaging endpoint.

2. **Register the bot.** On your machine, signed in to `az` with an account
   that can create app registrations and Azure Bot resources:

   ```bash
   scripts/teams-register.sh <name> <hostname>              # multi-tenant
   scripts/teams-register.sh <name> <hostname> --tenant <id>  # single-tenant, the firm's own
   ```

   It prints three lines for the box's `.env`: `TEAMS_APP_ID`,
   `TEAMS_APP_SECRET`, `TEAMS_TENANT_ID`. Paste them in (or use `/secret set`
   for the secret once the bot is up), then `sudo systemctl restart havn`.
   The secret expires in 24 months; note the date next to the box in your
   records, as with the Claude token.

3. **Build the Teams app package.** On your machine:

   ```bash
   npm run teams-manifest -- --app-id <TEAMS_APP_ID> --name "<assistant name>"
   ```

   Writes `deploy/rendered/<name>-teams.zip`.

4. **Install it in Teams.** The user opens Teams → Apps → Manage your apps →
   Upload an app → Upload a custom app, picks the zip, and opens the chat.
   If the tenant blocks custom uploads, their Teams admin publishes the same
   zip to the org catalog (Teams admin center → Teams apps → Manage apps →
   Upload new app) and the user installs it from there.

5. **Claim the chat.** The first message the bot receives makes it reply with
   the chat id (it treats being added as `/chatid`). Put that id in
   `ALLOWED_CHAT_ID` in `.env` and restart the service.

What works: text with Markdown, typing indicator, streaming replies,
approval buttons, files and images sent to the assistant. What does not, yet:
voice notes, the assistant sending files back (it says where it saved them),
group chats and channels.
```

- [ ] **Step 5: Run the enable-teams part of the test**

Run: `npx vitest run tests/teams-hosted-scripts.test.ts -t enable-teams`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/hosted/enable-teams.sh docs/HOSTED-VPS.md tests/teams-hosted-scripts.test.ts
git commit -m "Hosted: enable-teams.sh puts Caddy in front of the Teams webhook; runbook section"
```

---

### Task 14: `teams-register.sh` (Azure registration)

**Files:**
- Create: `scripts/teams-register.sh`
- Test: `tests/teams-hosted-scripts.test.ts` (the `teams-register.sh` block from Task 13)

**Interfaces:**
- `scripts/teams-register.sh <name> <hostname> [--tenant <tenantId>] [--resource-group havn-bots] [--location global] [--rotate-secret]`. Prints `TEAMS_APP_ID=…`, `TEAMS_APP_SECRET=…` (only when minted), `TEAMS_TENANT_ID=…` (only with `--tenant`). Idempotent by display name `Havn - <name>` and bot name `havn-<name>`.

- [ ] **Step 1: Write the script**

Create `scripts/teams-register.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# Register one Azure Bot + Entra app for one Havn install, and enable the
# Teams channel. Needs: az CLI, signed in (az login) as someone who can create
# app registrations and Azure Bot resources in the subscription az is set to.
#
#   scripts/teams-register.sh <name> <hostname> [--tenant <id>] [--resource-group havn-bots]
#                             [--location global] [--rotate-secret]
#
# Multi-tenant by default (any Microsoft 365 tenant can install the app).
# --tenant makes it single-tenant, for a firm that registers in its own tenant.
# Idempotent: re-running finds the existing app and bot and prints the ids
# again; the secret is minted only the first time or with --rotate-secret.
# The secret is printed once, to stdout, and never passed on a command line.
set -euo pipefail

NAME="${1:-}"; HOSTNAME_ARG="${2:-}"
if [[ -z "$NAME" || -z "$HOSTNAME_ARG" ]]; then
  echo "Usage: teams-register.sh <name> <hostname> [--tenant <id>] [--resource-group <rg>] [--location <loc>] [--rotate-secret]" >&2
  exit 1
fi
shift 2
TENANT=""; RG="havn-bots"; LOCATION="global"; ROTATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --resource-group) RG="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    --rotate-secret) ROTATE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v az >/dev/null || { echo "az CLI not found" >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "Not signed in: run az login" >&2; exit 1; }

DISPLAY_NAME="Havn - ${NAME}"
BOT_NAME="havn-${NAME}"
ENDPOINT="https://${HOSTNAME_ARG}/api/teams/messages"
if [[ -n "$TENANT" ]]; then AUDIENCE="AzureADMyOrg"; APP_TYPE="SingleTenant"; else AUDIENCE="AzureADMultipleOrgs"; APP_TYPE="MultiTenant"; fi

# 1. App registration (find or create)
APP_ID="$(az ad app list --display-name "$DISPLAY_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(az ad app create --display-name "$DISPLAY_NAME" --sign-in-audience "$AUDIENCE" --query appId -o tsv)"
  echo "Created app registration $DISPLAY_NAME ($APP_ID)" >&2
  NEW_APP=1
else
  echo "Found app registration $DISPLAY_NAME ($APP_ID)" >&2
  NEW_APP=0
fi

# 2. Client secret: first run, or on request. 24 months.
SECRET=""
if [[ "$NEW_APP" -eq 1 || "$ROTATE" -eq 1 ]]; then
  SECRET="$(az ad app credential reset --id "$APP_ID" --years 2 --display-name "havn-${NAME}-$(date +%Y%m%d)" --query password -o tsv)"
  echo "Minted a client secret (expires in 24 months)" >&2
fi

# 3. Resource group + Azure Bot (F0) pointing at the box
az group show -n "$RG" >/dev/null 2>&1 || az group create -n "$RG" -l "${LOCATION/global/eastus}" -o none
if az bot show -n "$BOT_NAME" -g "$RG" >/dev/null 2>&1; then
  az bot update -n "$BOT_NAME" -g "$RG" --endpoint "$ENDPOINT" -o none
  echo "Updated bot $BOT_NAME endpoint -> $ENDPOINT" >&2
else
  CREATE_ARGS=(--resource-group "$RG" --name "$BOT_NAME" --app-type "$APP_TYPE" --appid "$APP_ID" --endpoint "$ENDPOINT" --sku F0 --location "$LOCATION")
  if [[ -n "$TENANT" ]]; then CREATE_ARGS+=(--tenant-id "$TENANT"); fi
  az bot create "${CREATE_ARGS[@]}" -o none
  echo "Created bot $BOT_NAME -> $ENDPOINT" >&2
fi

# 4. Teams channel
az bot msteams create -n "$BOT_NAME" -g "$RG" -o none >/dev/null 2>&1 || true
echo "Teams channel enabled" >&2

# 5. Values for .env (stdout only)
echo "TEAMS_APP_ID=${APP_ID}"
if [[ -n "$SECRET" ]]; then echo "TEAMS_APP_SECRET=${SECRET}"; else echo "# TEAMS_APP_SECRET unchanged (use --rotate-secret to mint a new one)"; fi
if [[ -n "$TENANT" ]]; then echo "TEAMS_TENANT_ID=${TENANT}"; fi
```

Run: `chmod +x scripts/teams-register.sh`

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/teams-hosted-scripts.test.ts`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add scripts/teams-register.sh
git commit -m "Teams: az registration script (app, secret, Azure Bot, Teams channel)"
```

---

### Task 15: Teams app package generator

**Files:**
- Create: `deploy/teams/manifest.json.template`
- Create: `scripts/teams-manifest.ts`
- Create: `src/deploy/teams-package.ts` (pure: manifest rendering, PNG icons, zip bytes)
- Modify: `package.json` (script `teams-manifest`)
- Test: `tests/teams-package.test.ts`

**Interfaces:**
- `src/deploy/teams-package.ts`:

```ts
export interface TeamsPackageSpec { appId: string; name: string; developerName?: string; websiteUrl?: string }
export function validateTeamsPackageSpec(spec: TeamsPackageSpec): string[]      // problems, [] when fine
export function renderManifest(template: string, spec: TeamsPackageSpec): string // JSON text
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer
export function buildTeamsPackage(template: string, spec: TeamsPackageSpec): Buffer   // zip: manifest.json, color.png, outline.png
```

- `npm run teams-manifest -- --app-id <guid> --name "<assistant>" [--developer "ELS Partners"] [--website https://els-partners.com] [--out path.zip]` writes `deploy/rendered/<slug>-teams.zip`.

The zip is written with the `stored` (no compression) method so no dependency is needed: local file headers + central directory + end record, CRC-32 per entry.

- [ ] **Step 1: Write the failing test**

Create `tests/teams-package.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { renderManifest, solidPng, buildTeamsPackage, validateTeamsPackageSpec } from '../src/deploy/teams-package.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = readFileSync(join(ROOT, 'deploy', 'teams', 'manifest.json.template'), 'utf-8')
const SPEC = { appId: '11111111-2222-3333-4444-555555555555', name: 'Nami' }

describe('validateTeamsPackageSpec', () => {
  it('wants a GUID app id and a name', () => {
    expect(validateTeamsPackageSpec(SPEC)).toEqual([])
    expect(validateTeamsPackageSpec({ appId: 'nope', name: 'Nami' }).join()).toMatch(/appId/)
    expect(validateTeamsPackageSpec({ appId: SPEC.appId, name: '' }).join()).toMatch(/name/)
    expect(validateTeamsPackageSpec({ appId: SPEC.appId, name: 'x'.repeat(31) }).join()).toMatch(/30/)
  })
})

describe('renderManifest', () => {
  it('produces a personal-scope bot manifest with the app id in both places', () => {
    const m = JSON.parse(renderManifest(TEMPLATE, SPEC))
    expect(m.manifestVersion).toBe('1.16')
    expect(m.id).toBe(SPEC.appId)
    expect(m.bots[0].botId).toBe(SPEC.appId)
    expect(m.bots[0].scopes).toEqual(['personal'])
    expect(m.bots[0].supportsFiles).toBe(true)
    expect(m.name.short).toBe('Nami')
    expect(m.icons).toEqual({ color: 'color.png', outline: 'outline.png' })
    expect(m.validDomains).toEqual([])
    expect(JSON.stringify(m)).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })
})

describe('solidPng', () => {
  it('writes a decodable PNG of the requested size', () => {
    const png = solidPng(4, 2, [31, 41, 55, 255])
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(4) // width
    expect(png.readUInt32BE(20)).toBe(2) // height
    const idatLen = png.readUInt32BE(33)
    const idat = png.subarray(41, 41 + idatLen)
    const raw = inflateSync(idat)
    expect(raw.length).toBe(2 * (1 + 4 * 4)) // filter byte + RGBA per row
    expect([...raw.subarray(1, 5)]).toEqual([31, 41, 55, 255])
  })
})

describe('buildTeamsPackage', () => {
  it('zips manifest.json, color.png, and outline.png as stored entries', () => {
    const zip = buildTeamsPackage(TEMPLATE, SPEC)
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const text = zip.toString('latin1')
    for (const name of ['manifest.json', 'color.png', 'outline.png']) expect(text).toContain(name)
    // end-of-central-directory record says 3 entries
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(zip.readUInt16LE(eocd + 10)).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/teams-package.test.ts`
Expected: FAIL, template and module missing.

- [ ] **Step 3: Create the manifest template**

Create `deploy/teams/manifest.json.template`:

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "{{APP_ID}}",
  "packageName": "com.elspartners.havn.{{SLUG}}",
  "developer": {
    "name": "{{DEVELOPER_NAME}}",
    "websiteUrl": "{{WEBSITE_URL}}",
    "privacyUrl": "{{WEBSITE_URL}}",
    "termsOfUseUrl": "{{WEBSITE_URL}}"
  },
  "name": {
    "short": "{{NAME}}",
    "full": "{{NAME}} (Havn assistant)"
  },
  "description": {
    "short": "Your personal AI assistant",
    "full": "{{NAME}} is your personal AI assistant, hosted for you by {{DEVELOPER_NAME}}. Chat with it here like you would with a colleague."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "accentColor": "#1F2937",
  "bots": [
    {
      "botId": "{{APP_ID}}",
      "scopes": ["personal"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

- [ ] **Step 4: Implement the package builder**

Create `src/deploy/teams-package.ts`:

```ts
/**
 * Teams app package: manifest.json + two icons, zipped. Pure functions so the
 * shape is testable; scripts/teams-manifest.ts does the argv and file I/O.
 * The zip is written by hand (stored entries) to avoid a dependency.
 */
import { deflateSync } from 'node:zlib'

export interface TeamsPackageSpec {
  appId: string
  name: string
  developerName?: string
  websiteUrl?: string
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateTeamsPackageSpec(spec: TeamsPackageSpec): string[] {
  const problems: string[] = []
  if (!GUID.test(spec.appId ?? '')) problems.push('appId must be the app (client) ID GUID from the registration')
  const name = (spec.name ?? '').trim()
  if (!name) problems.push('name is required')
  else if (name.length > 30) problems.push('name must be 30 characters or fewer (Teams short-name limit)')
  return problems
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'assistant'
}

export function renderManifest(template: string, spec: TeamsPackageSpec): string {
  const vars: Record<string, string> = {
    APP_ID: spec.appId.toLowerCase(),
    NAME: spec.name.trim(),
    SLUG: slugify(spec.name),
    DEVELOPER_NAME: spec.developerName?.trim() || 'ELS Partners',
    WEBSITE_URL: spec.websiteUrl?.trim() || 'https://www.els-partners.com',
  }
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in vars ? JSON.stringify(vars[key]).slice(1, -1) : m))
  const leftover = text.match(/\{\{[A-Z_]+\}\}/g)
  if (leftover) throw new Error(`manifest template still contains placeholders: ${[...new Set(leftover)].join(', ')}`)
  JSON.parse(text) // must be valid JSON
  return text
}

// --- PNG ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

/** A single-colour RGBA PNG. Enough for Teams' required icons. */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Outline icon: transparent background with a white square inset (Teams wants white-on-transparent). */
export function outlinePng(size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const inset = Math.floor(size / 8)
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      const on = x >= inset && x < size - inset && y >= inset && y < size - inset
      row.set(on ? [255, 255, 255, 255] : [0, 0, 0, 0], 1 + x * 4)
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// --- ZIP (stored entries) ---

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function zipStored(entries: Array<{ name: string; data: Buffer }>, when = new Date()): Buffer {
  const { time, date } = dosDateTime(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, e.data)
    centrals.push(central, name)
    offset += local.length + name.length + e.data.length
  }
  const centralStart = offset
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, eocd])
}

export function buildTeamsPackage(template: string, spec: TeamsPackageSpec): Buffer {
  const problems = validateTeamsPackageSpec(spec)
  if (problems.length) throw new Error(problems.join('; '))
  return zipStored([
    { name: 'manifest.json', data: Buffer.from(renderManifest(template, spec), 'utf-8') },
    { name: 'color.png', data: solidPng(192, 192, [31, 41, 55, 255]) },
    { name: 'outline.png', data: outlinePng(32) },
  ])
}
```

- [ ] **Step 5: Create the CLI and the npm script**

Create `scripts/teams-manifest.ts`:

```ts
/**
 * Render a Teams app package for one install.
 *
 *   npm run teams-manifest -- --app-id <guid> --name "Nami" [--developer "ELS Partners"]
 *                              [--website https://www.els-partners.com] [--out deploy/rendered/nami-teams.zip]
 *
 * Upload the zip in Teams: Apps → Manage your apps → Upload an app → Upload a
 * custom app (or have the tenant admin publish it to the org catalog).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'
import { buildTeamsPackage, slugify, validateTeamsPackageSpec, type TeamsPackageSpec } from '../src/deploy/teams-package.js'

const USAGE = 'Usage: npm run teams-manifest -- --app-id <guid> --name "<assistant name>" [--developer <name>] [--website <url>] [--out <path.zip>]'

function parseArgs(argv: string[]): TeamsPackageSpec & { out?: string } {
  const opts: TeamsPackageSpec & { out?: string } = { appId: '', name: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`)
      return v
    }
    if (arg === '--app-id') opts.appId = next()
    else if (arg === '--name') opts.name = next()
    else if (arg === '--developer') opts.developerName = next()
    else if (arg === '--website') opts.websiteUrl = next()
    else if (arg === '--out') opts.out = next()
    else if (arg === '--help' || arg === '-h') throw new Error(USAGE)
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
  }
  return opts
}

function main(): void {
  let opts: ReturnType<typeof parseArgs>
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  }
  const problems = validateTeamsPackageSpec(opts)
  if (problems.length) {
    for (const p of problems) console.error(`- ${p}`)
    console.error(USAGE)
    process.exit(1)
  }
  const template = readFileSync(resolve(PROJECT_ROOT, 'deploy', 'teams', 'manifest.json.template'), 'utf-8')
  const zip = buildTeamsPackage(template, opts)
  const outFile = resolve(PROJECT_ROOT, opts.out ?? `deploy/rendered/${slugify(opts.name)}-teams.zip`)
  mkdirSync(resolve(outFile, '..'), { recursive: true })
  writeFileSync(outFile, zip)
  console.log(`Wrote ${outFile} (${zip.length} bytes).`)
  console.log('Install it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.')
}

main()
```

In `package.json` `scripts`, after `"make-cloud-init"`, add:

```json
    "teams-manifest": "tsx scripts/teams-manifest.ts",
```

- [ ] **Step 6: Run the tests, then render a real package**

Run: `npx vitest run tests/teams-package.test.ts && npm run typecheck && npm run teams-manifest -- --app-id 11111111-2222-3333-4444-555555555555 --name Nami && unzip -l deploy/rendered/nami-teams.zip && rm deploy/rendered/nami-teams.zip`
Expected: 5 passed; typecheck clean; `unzip -l` lists `manifest.json`, `color.png`, `outline.png`.

- [ ] **Step 7: Commit**

```bash
git add deploy/teams/manifest.json.template src/deploy/teams-package.ts scripts/teams-manifest.ts package.json tests/teams-package.test.ts
git commit -m "Teams: app package generator (manifest, icons, zip) with no new dependencies"
```

---

### Task 16: Docs, env example, changelog

**Files:**
- Modify: `docs/SETUP-GUIDE.md` (the "### Teams Setup" section, around line 63)
- Modify: `.env.example` (platform credentials block)
- Modify: `CHANGELOG.md` (Unreleased)
- Test: none beyond a grep; docs-only.

- [ ] **Step 1: Rewrite the setup-guide Teams section**

Replace the whole `### Teams Setup (via Power Automate or Azure Bot Service)` section in `docs/SETUP-GUIDE.md` with:

```markdown
### Teams Setup
Teams delivers messages by HTTPS, so the assistant needs a public address.
On a hosted box this is `scripts/hosted/enable-teams.sh` (Caddy on 443);
the full walk-through is in `docs/HOSTED-VPS.md > Teams instead of Telegram`.
A laptop install would need a tunnel and is not supported for Teams yet.

1. Register the bot: `scripts/teams-register.sh <name> <hostname>` (needs the
   Azure CLI, signed in). It prints `TEAMS_APP_ID`, `TEAMS_APP_SECRET` and,
   for single-tenant registrations, `TEAMS_TENANT_ID`.
2. Add them to `.env` (or paste the secret with `/secret set TEAMS_APP_SECRET`).
3. Build the app package: `npm run teams-manifest -- --app-id <id> --name "<assistant>"`.
4. Upload `deploy/rendered/<name>-teams.zip` in Teams: Apps → Manage your apps → Upload a custom app.
5. Send the bot anything; it answers with your chat id. Put it in
   `ALLOWED_CHAT_ID` and restart.
```

- [ ] **Step 2: Update `.env.example`**

In the platform-credentials block of `.env.example`, next to the Telegram and Slack keys, add:

```
# Microsoft Teams (see docs/HOSTED-VPS.md > Teams instead of Telegram)
#TEAMS_APP_ID=
#TEAMS_APP_SECRET=
#TEAMS_TENANT_ID=        # only for a single-tenant registration
```

- [ ] **Step 3: Changelog**

In `CHANGELOG.md` under `## Unreleased`, add as the first bullet:

```markdown
- **New: Microsoft Teams as a chat surface.** Choose Teams in setup, register one Azure Bot per install with `scripts/teams-register.sh`, expose the webhook on a hosted box with `scripts/hosted/enable-teams.sh` (Caddy, one path, Bot Framework tokens checked on every request), and upload the app package `npm run teams-manifest` builds. Text with Markdown, typing, streaming replies, approval buttons as Adaptive Cards, and files sent to the assistant all work in 1:1 chat. Not yet: voice notes, sending files back, channels, laptop installs.
```

- [ ] **Step 4: Verify and commit**

Run: `grep -n "Power Automate" docs/SETUP-GUIDE.md; npx vitest run; npm run typecheck`
Expected: no `Power Automate` match; suite green; typecheck clean.

```bash
git add docs/SETUP-GUIDE.md .env.example CHANGELOG.md
git commit -m "Docs: Teams setup, env example, changelog"
```

---

### Task 17: Live validation on havn-test (card #100)

**Files:** none in the repo. This is the manual exit criterion; record results as a comment on Kanban cards #104 and #100.

- [ ] **Step 1: Expose the webhook on the box**

```bash
ssh havn@178.156.205.93 'cd ~/havn && git pull --ff-only origin main && npm ci --no-audit --no-fund && npm run build'
ssh havn@178.156.205.93 'sudo node ~/havn/dist/scripts/hosted/enable-teams.js 178-156-205-93.sslip.io'
curl -si https://178-156-205-93.sslip.io/api/teams/messages -X POST | head -1   # expect HTTP/2 401 once the cert is issued
curl -si https://178-156-205-93.sslip.io/api/cockpit/usage | head -1            # expect 404
```

- [ ] **Step 2: Register under Marc's tenant and package the app**

```bash
az login
npm run teams-register -- test 178-156-205-93.sslip.io      # prints TEAMS_APP_ID / TEAMS_APP_SECRET
npm run teams-manifest -- --app-id <TEAMS_APP_ID> --name Nami
```

Put the two values in the box's `.env` (secret via stdin, never argv), comment out `TELEGRAM_BOT_TOKEN`, add `PLATFORM=teams`, then `sudo systemctl restart havn`. Confirm `journalctl -u havn -n 5` shows `Teams adapter started (webhook registered)`.

- [ ] **Step 3: Install in Teams and claim the chat**

Upload `deploy/rendered/nami-teams.zip` in Marc's Teams (Apps → Manage your apps → Upload a custom app). Open the chat; the bot replies with the chat id. Set `ALLOWED_CHAT_ID` to it, restart the service.

- [ ] **Step 4: Exercise the checklist, ticking each**

- [ ] Plain text in, Markdown reply rendered (bold, list, code)
- [ ] Typing indicator visible while the agent works
- [ ] Streaming preview edits the same message rather than posting new ones
- [ ] An approval flow (`[[buttons: Send | Edit | Discard]]`) shows a card; clicking lands the choice and the card turns into plain text
- [ ] A dropped PDF reaches the assistant (`workspace/uploads/` on the box, and the reply references it)
- [ ] A pasted image reaches the assistant
- [ ] `/secret set OPENAI_API_KEY` round trip; the bot tells you to delete your message
- [ ] A scheduled task (`/schedule create "say hi" "<cron for now+2min>" --once`) delivers proactively
- [ ] `sudo systemctl restart havn` mid-conversation; next message still works (reference survived)
- [ ] `npm run teams-register -- test 178-156-205-93.sslip.io --rotate-secret`, update `.env`, restart; messages still flow
- [ ] `logs/service.log` shows no `invalid Bot Framework token` lines from legitimate traffic

- [ ] **Step 5: Record and restore**

Comment the results on Kanban #104 and #100 (`python3 skills/kanbanzone/scripts/kz.py comment --board 6n2RsmK1 --id <n> --text "..."` from the ClaudeClaw repo). Decide whether havn-test stays on Teams or returns to Telegram (restore `TELEGRAM_BOT_TOKEN`, remove `PLATFORM=teams`, restart). Update `brain/project_hosted_havn.md` with the Teams box facts (hostname, bot name, secret expiry date).
