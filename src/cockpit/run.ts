import { IncomingMessage, ServerResponse } from 'node:http'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { runAgent } from '../agent.js'
import { getSession, setSession } from '../db.js'
import { findSkill } from './registry.js'
import { appendActivity } from './activity.js'

const LAST_RUN_PATH = resolve(homedir(), 'clawd/dashboard-data/last-run.json')
const COCKPIT_CHAT_KEY = 'cockpit-user'
const TELEGRAM_CHAT_KEY_FALLBACK = process.env['ALLOWED_CHAT_ID'] ?? process.env['PRIMARY_CHAT_ID'] ?? ''

type RunState = {
  runId: string
  skillId: string
  startedAt: number
  res: ServerResponse
  cancelled: boolean
}

let activeRun: RunState | null = null

function sse(res: ServerResponse, data: any): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function persistLastRun(payload: any): void {
  try {
    mkdirSync(dirname(LAST_RUN_PATH), { recursive: true })
    writeFileSync(LAST_RUN_PATH, JSON.stringify(payload, null, 2))
  } catch (err) {
    logger.warn({ err }, 'cockpit: failed to persist last-run')
  }
}

export async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const skillId = String(body?.skillId ?? '')
  const input = typeof body?.input === 'string' ? body.input : null

  const skill = findSkill(skillId)
  if (!skill) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown_skill', skillId }))
    return
  }

  if (skill.input?.required && !input) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'input_required' }))
    return
  }

  if (activeRun) {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: 'run_in_progress',
      activeRunId: activeRun.runId,
      activeSkillId: activeRun.skillId,
    }))
    return
  }

  const runId = randomUUID()
  const chatKey = skill.shareWithTelegram && TELEGRAM_CHAT_KEY_FALLBACK
    ? TELEGRAM_CHAT_KEY_FALLBACK
    : COCKPIT_CHAT_KEY

  // Build the prompt: surface tag + filled template
  const filled = input ? skill.prompt.replace(/\{input\}/g, input) : skill.prompt
  const tagged = `[surface:cockpit skill:${skill.id}]\n\n${filled}`

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const state: RunState = { runId, skillId: skill.id, startedAt: Date.now(), res, cancelled: false }
  activeRun = state

  sse(res, { type: 'start', runId, skillId: skill.id, label: skill.label, startedAt: state.startedAt })

  appendActivity({
    kind: 'cockpit',
    skillId: skill.id,
    runId,
    summary: `${skill.label} — started`,
  })

  // Heartbeat to keep the connection alive while the agent thinks
  const heartbeat = setInterval(() => {
    if (state.cancelled) return
    res.write(`: heartbeat\n\n`)
  }, 15_000)

  try {
    const sessionId = getSession(chatKey) ?? undefined
    const onPartial = (accumulated: string) => {
      if (state.cancelled) return
      sse(res, { type: 'delta', text: accumulated })
    }

    const { text, newSessionId } = await runAgent(tagged, sessionId, undefined, onPartial)

    if (newSessionId) setSession(chatKey, newSessionId)

    if (state.cancelled) {
      logger.info({ runId, skillId: skill.id }, 'cockpit: run cancelled by user')
    } else {
      const final = text ?? '(no response)'
      const elapsedMs = Date.now() - state.startedAt
      sse(res, { type: 'done', runId, text: final, elapsedMs, newSessionId })
      persistLastRun({
        runId,
        skillId: skill.id,
        label: skill.label,
        startedAt: state.startedAt,
        finishedAt: Date.now(),
        elapsedMs,
        text: final,
      })
      appendActivity({
        kind: 'cockpit',
        skillId: skill.id,
        runId,
        summary: `${skill.label} — done in ${(elapsedMs / 1000).toFixed(1)}s`,
      })
    }
  } catch (err: any) {
    logger.error({ err, runId, skillId: skill.id }, 'cockpit: run failed')
    if (!state.cancelled) {
      sse(res, { type: 'error', runId, message: err?.message ?? 'agent failed' })
      appendActivity({
        kind: 'cockpit',
        skillId: skill.id,
        runId,
        summary: `${skill.label} — error: ${err?.message ?? 'unknown'}`,
      })
    }
  } finally {
    clearInterval(heartbeat)
    if (activeRun?.runId === runId) activeRun = null
    try { res.end() } catch { /* already closed */ }
  }
}

export function handleCancel(req: IncomingMessage, res: ServerResponse): void {
  void req
  if (!activeRun) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'no_active_run' }))
    return
  }
  activeRun.cancelled = true
  const runId = activeRun.runId
  appendActivity({
    kind: 'cockpit',
    skillId: activeRun.skillId,
    runId,
    summary: `cancelled by user (agent may continue in background)`,
  })
  try { sse(activeRun.res, { type: 'cancelled', runId }) } catch { /* */ }
  try { activeRun.res.end() } catch { /* */ }
  activeRun = null
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, runId }))
}

export function readLastRun(): any | null {
  if (!existsSync(LAST_RUN_PATH)) return null
  try { return JSON.parse(readFileSync(LAST_RUN_PATH, 'utf8')) }
  catch { return null }
}

export function getActiveRun(): { runId: string; skillId: string; startedAt: number } | null {
  if (!activeRun) return null
  return { runId: activeRun.runId, skillId: activeRun.skillId, startedAt: activeRun.startedAt }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      if (!data) return resolvePromise({})
      try { resolvePromise(JSON.parse(data)) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}
