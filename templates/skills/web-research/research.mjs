#!/usr/bin/env node
// research.mjs — call the Perplexity API and emit markdown with citations.
// Cross-platform, zero dependencies (global fetch).
//
// Usage: node research.mjs <model> <query>
//   Models: sonar-pro | sonar-reasoning-pro | sonar-deep-research
// Optional env: PPLX_CONTEXT — system message prepended to the query.
// Reads API key from ~/.perplexity-api-key. Markdown to stdout.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const [model, query] = process.argv.slice(2)
if (!model || !query) {
  console.error('Usage: node research.mjs <model> <query>')
  console.error('Models: sonar-pro | sonar-reasoning-pro | sonar-deep-research')
  process.exit(2)
}

const keyFile = join(homedir(), '.perplexity-api-key')
let key = ''
try {
  key = readFileSync(keyFile, 'utf-8').replace(/[\s\r\n]/g, '')
} catch {
  console.error(`Error: Perplexity API key not found at ${keyFile}`)
  process.exit(1)
}
if (!key) {
  console.error(`Error: ${keyFile} is empty`)
  process.exit(1)
}

const messages = process.env.PPLX_CONTEXT
  ? [{ role: 'system', content: process.env.PPLX_CONTEXT }, { role: 'user', content: query }]
  : [{ role: 'user', content: query }]

// Deep research can take several minutes; give it a generous timeout.
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 600_000)

let res
try {
  res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, return_citations: true }),
    signal: controller.signal,
  })
} catch (err) {
  console.error(`Error: Perplexity request failed: ${String(err)}`)
  process.exit(1)
} finally {
  clearTimeout(timer)
}

const response = await res.json().catch(() => null)
if (!res.ok) {
  console.error(`Error: Perplexity API returned HTTP ${res.status}`)
  if (response) console.error(JSON.stringify(response, null, 2))
  process.exit(1)
}

const content = response?.choices?.[0]?.message?.content ?? ''
if (!content) {
  console.error('Error: empty response content')
  console.error(JSON.stringify(response, null, 2))
  process.exit(1)
}

console.log(content)

const rawCitations = response.citations ?? response.search_results ?? []
if (rawCitations.length > 0) {
  console.log('\n## Sources')
  rawCitations.forEach((c, i) => {
    const url = typeof c === 'string' ? c : c?.url ?? JSON.stringify(c)
    console.log(`[${i + 1}] ${url}`)
  })
}
