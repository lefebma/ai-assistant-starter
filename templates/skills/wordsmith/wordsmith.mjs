#!/usr/bin/env node
// wordsmith.mjs — emit prose for written-content tasks using whatever LLM
// provider the install is configured with. Cross-platform, zero dependencies
// (global fetch). No separate API key: it reuses the provider keys already
// in .env (anthropic | openai | google | azure).
//
// Usage:
//   node wordsmith.mjs <tier-or-model> <task>
//   echo "<source text>" | node wordsmith.mjs <tier-or-model> <task>
//
// First argument:
//   quality — the provider's strong prose model (default choice)
//   fast    — the provider's fast model for quick rewrites
//   anything else is passed through as an explicit model id (for azure,
//   that means the tenant's deployment name)
//
// Provider resolution, in order:
//   1. WORDSMITH_PROVIDER (explicit override)
//   2. AI_PROVIDER from .env, when its API key is present
//   3. the first of anthropic/openai/google/azure whose key is present
//
// Optional env: WORDSMITH_MODEL (model override), WORDSMITH_VOICE (system
// instruction), WORDSMITH_CONTEXT (situational context). Azure also reads
// AZURE_RESOURCE_NAME / AI_BASE_URL / AZURE_API_VERSION like the runtime.
//
// Voice samples: drop-in *.md files under voice-samples/ (except README.md)
// are appended to the voice block automatically.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_API_KEY',
}
const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'azure']
const TIER_MODELS = {
  anthropic: { quality: 'claude-sonnet-5', fast: 'claude-haiku-4-5' },
  openai: { quality: 'gpt-5.4', fast: 'gpt-5.4-mini' },
  google: { quality: 'gemini-2.5-pro', fast: 'gemini-2.5-flash' },
  // azure has no tier defaults: model ids are tenant deployment names.
}

/** Parse KEY=value lines from .env text; quotes stripped, comments ignored. */
export function parseDotEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1')
  }
  return out
}

/**
 * Pick provider + model + credentials from a merged env object.
 * Throws with an actionable message when nothing usable is configured.
 */
export function resolveTarget(env, tierOrModel) {
  const key = (p) => env[KEY_ENV[p]] || ''

  let provider = env.WORDSMITH_PROVIDER || ''
  if (provider && !KEY_ENV[provider]) {
    throw new Error(`Unknown WORDSMITH_PROVIDER '${provider}'. Available: ${PROVIDER_ORDER.join(', ')}.`)
  }
  if (!provider && env.AI_PROVIDER && KEY_ENV[env.AI_PROVIDER] && key(env.AI_PROVIDER)) {
    provider = env.AI_PROVIDER
  }
  if (!provider) provider = PROVIDER_ORDER.find((p) => key(p)) || ''
  if (!provider) {
    throw new Error(
      `No usable provider key found. Wordsmith reuses the install's provider keys; set one of ${Object.values(KEY_ENV).join(', ')} in .env.`
    )
  }
  if (!key(provider)) {
    throw new Error(`Provider '${provider}' selected but ${KEY_ENV[provider]} is not set in .env.`)
  }

  const isTier = tierOrModel === 'quality' || tierOrModel === 'fast'
  let model = !isTier ? tierOrModel : env.WORDSMITH_MODEL || TIER_MODELS[provider]?.[tierOrModel] || ''
  if (!model && provider === 'azure') {
    // Deployment names are per-tenant; reuse the runtime's deployment.
    model = env.AI_MODEL || ''
    if (!model) {
      throw new Error(
        `Azure needs a deployment name: pass it as the first argument, or set WORDSMITH_MODEL or AI_MODEL in .env.`
      )
    }
  }
  if (!model) throw new Error(`No model resolved for provider '${provider}'.`)

  const target = { provider, model, apiKey: key(provider) }
  if (provider === 'azure') {
    target.baseURL = env.AI_BASE_URL || ''
    target.resourceName = env.AZURE_RESOURCE_NAME || ''
    target.apiVersion = env.AZURE_API_VERSION || '2024-10-21'
    if (!target.baseURL && !target.resourceName) {
      throw new Error(`Azure needs AZURE_RESOURCE_NAME (or AI_BASE_URL) in .env.`)
    }
  }
  return target
}

/** Build {url, headers, body} for one non-streaming chat call. */
export function buildRequest(target, voice, userText) {
  const { provider, model, apiKey } = target
  if (provider === 'google') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        ...(voice.trim() ? { system_instruction: { parts: [{ text: voice }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.7 },
      },
    }
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 8192,
        temperature: 0.7,
        ...(voice.trim() ? { system: voice } : {}),
        messages: [{ role: 'user', content: userText }],
      },
    }
  }
  // openai + azure share the Chat Completions shape. Temperature is omitted:
  // gpt-5-family reasoning models reject non-default temperature values.
  const messages = [
    ...(voice.trim() ? [{ role: 'system', content: voice }] : []),
    { role: 'user', content: userText },
  ]
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: { model, messages },
    }
  }
  const base = target.baseURL || `https://${target.resourceName}.openai.azure.com`
  return {
    url: `${base}/openai/deployments/${model}/chat/completions?api-version=${target.apiVersion}`,
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: { model, messages },
  }
}

/** Pull the prose out of a provider response object. */
export function extractText(provider, response) {
  if (provider === 'google') {
    return (response?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  }
  if (provider === 'anthropic') {
    return (response?.content ?? []).map((p) => p.text ?? '').join('')
  }
  return response?.choices?.[0]?.message?.content ?? ''
}

async function main() {
  const [tierOrModel, task] = process.argv.slice(2)
  if (!tierOrModel || !task) {
    console.error('Usage: node wordsmith.mjs <quality|fast|model-id> <task>')
    process.exit(2)
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(scriptDir, '..', '..')

  // .env first, real environment wins on conflicts.
  let dotenv = {}
  try {
    dotenv = parseDotEnv(readFileSync(join(projectRoot, '.env'), 'utf-8'))
  } catch { /* no .env */ }
  const env = { ...dotenv }
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v

  let target
  try {
    target = resolveTarget(env, tierOrModel)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }

  // Auto-load voice samples (real writing examples); README.md is docs, not a sample.
  let voice = process.env.WORDSMITH_VOICE ?? ''
  const samplesDir = join(scriptDir, 'voice-samples')
  if (existsSync(samplesDir)) {
    const samples = readdirSync(samplesDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => `\n\n--- Voice sample: ${f} ---\n${readFileSync(join(samplesDir, f), 'utf-8')}`)
      .join('')
    if (samples) {
      voice += `\n\nConcrete voice samples (real writing in this person's voice — mirror these patterns, vocabulary, sentence rhythm, and stance):${samples}`
    }
  }

  // Piped stdin, if any, is source text to operate on.
  let source = ''
  if (!process.stdin.isTTY) {
    source = readFileSync(0, 'utf-8')
  }

  let userText = ''
  if (process.env.WORDSMITH_CONTEXT) userText += `Context:\n${process.env.WORDSMITH_CONTEXT}\n\n`
  if (source) userText += `Source text:\n${source}\n\n`
  userText += `Task:\n${task}`

  const req = buildRequest(target, voice, userText)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  let res
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    })
  } catch (err) {
    console.error(`Error: ${target.provider} request failed: ${String(err)}`)
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }

  const response = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(`Error: ${target.provider} API returned HTTP ${res.status}`)
    if (response) console.error(JSON.stringify(response, null, 2))
    process.exit(1)
  }

  const content = extractText(target.provider, response)
  if (!content) {
    console.error(`Error: empty response from ${target.provider}`)
    console.error(JSON.stringify(response, null, 2))
    process.exit(1)
  }

  console.log(content)
}

// Run only when invoked directly; importable for tests without side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
