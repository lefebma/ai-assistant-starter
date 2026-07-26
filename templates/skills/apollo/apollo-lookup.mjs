#!/usr/bin/env node
// Apollo.io lookup — cross-platform, zero dependencies (global fetch).
// Usage: node apollo-lookup.mjs [company|person|domain] [query]
//
// Reads API key from ~/.apollo-api-key (one-line file) or APOLLO_API_KEY
// env var (overrides the file).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE_URL = 'https://api.apollo.io/v1'
const [type, query] = process.argv.slice(2)

function apiKey() {
  if (process.env.APOLLO_API_KEY) return process.env.APOLLO_API_KEY
  try {
    const key = readFileSync(join(homedir(), '.apollo-api-key'), 'utf-8').trim()
    if (key) return key
  } catch { /* fall through */ }
  console.error('error: APOLLO_API_KEY not set and ~/.apollo-api-key not found')
  process.exit(2)
}

if (!type || !query) {
  console.error(`Usage: node apollo-lookup.mjs [company|person|domain] [query]

Examples:
  node apollo-lookup.mjs company 'Acme Inc'
  node apollo-lookup.mjs person 'Jane Doe'
  node apollo-lookup.mjs domain 'example.com'`)
  process.exit(1)
}

const ENDPOINTS = {
  company: { path: '/mixed_companies/search', body: { q_organization_name: query, page: 1, per_page: 5 } },
  person: { path: '/mixed_people/search', body: { q_person_name: query, page: 1, per_page: 5 } },
  domain: { path: '/organizations/enrich', body: { domain: query } },
}

const endpoint = ENDPOINTS[type]
if (!endpoint) {
  console.error(`Unknown type: ${type}\nUse: company, person, or domain`)
  process.exit(1)
}

const res = await fetch(`${BASE_URL}${endpoint.path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey() },
  body: JSON.stringify(endpoint.body),
})
const json = await res.json().catch(() => null)
if (!res.ok) {
  console.error(`error: Apollo API returned HTTP ${res.status}`)
  if (json) console.error(JSON.stringify(json, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(json, null, 2))
