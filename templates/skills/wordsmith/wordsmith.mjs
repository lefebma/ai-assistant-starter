#!/usr/bin/env node
// wordsmith.mjs — call the Gemini API and emit prose for written-content
// tasks. Cross-platform, zero dependencies (global fetch).
//
// Usage:
//   node wordsmith.mjs <model> <task>
//   echo "<source text>" | node wordsmith.mjs <model> <task>
//
// Models: gemini-2.5-pro (default quality) | gemini-2.5-flash (fast rewrites)
// Optional env: WORDSMITH_VOICE (system instruction), WORDSMITH_CONTEXT
// (situational context), GOOGLE_API_KEY (overrides .env lookup).
//
// Voice samples: drops-in *.md files under voice-samples/ (except README.md)
// are appended to the voice block automatically.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [model, task] = process.argv.slice(2)
if (!model || !task) {
  console.error('Usage: node wordsmith.mjs <model> <task>')
  console.error('Models: gemini-2.5-pro | gemini-2.5-flash')
  process.exit(2)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..', '..')

// Resolve API key: env var wins, else .env in project root.
let apiKey = process.env.GOOGLE_API_KEY ?? ''
if (!apiKey) {
  try {
    const envText = readFileSync(join(projectRoot, '.env'), 'utf-8')
    const line = envText.split('\n').find((l) => l.startsWith('GOOGLE_API_KEY='))
    if (line) apiKey = line.slice('GOOGLE_API_KEY='.length).trim().replace(/^"(.*)"$/, '$1')
  } catch { /* no .env */ }
}
if (!apiKey) {
  console.error(`Error: GOOGLE_API_KEY not set and not found in ${projectRoot}/.env`)
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

const payload = {
  ...(voice.trim() ? { system_instruction: { parts: [{ text: voice }] } } : {}),
  contents: [{ role: 'user', parts: [{ text: userText }] }],
  generationConfig: { temperature: 0.7 },
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 60_000)
let res
try {
  res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }
  )
} catch (err) {
  console.error(`Error: Gemini request failed: ${String(err)}`)
  process.exit(1)
} finally {
  clearTimeout(timer)
}

const response = await res.json().catch(() => null)
if (!res.ok) {
  console.error(`Error: Gemini API returned HTTP ${res.status}`)
  if (response) console.error(JSON.stringify(response, null, 2))
  process.exit(1)
}

const content = (response?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
if (!content) {
  console.error('Error: empty response from Gemini')
  console.error(JSON.stringify(response, null, 2))
  process.exit(1)
}

console.log(content)
