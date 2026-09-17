/**
 * Shipped docs must not point at paths the install never creates.
 *
 * docs/ is in BUNDLE_PAYLOAD_PATHS, so every word of it reaches a client.
 * The setup guide used to say "Create custom agents for specialized work
 * (.claude/agents/)". That directory is in neither payload list in
 * src/update/plan.ts and setup never creates it, so the instruction pointed
 * at a path no client box has ever had. See card #144 and the decision record
 * in docs/specs/2026-09-16-agent-roster-decision.md.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { SOURCE_ENGINE_PATHS, BUNDLE_PAYLOAD_PATHS } from '../src/update/plan.js'

const root = resolve(__dirname, '..')
const shippedDocs = readdirSync(resolve(root, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, body: readFileSync(resolve(root, 'docs', f), 'utf-8') }))

/** Paths a client install actually receives. */
const delivered = new Set([...SOURCE_ENGINE_PATHS, ...BUNDLE_PAYLOAD_PATHS])

describe('shipped docs', () => {
  it('finds the guide, so this suite cannot pass by reading nothing', () => {
    expect(shippedDocs.map((d) => d.name)).toContain('SETUP-GUIDE.md')
    expect(shippedDocs.length).toBeGreaterThan(3)
  })

  it('confirms .claude is not delivered to a client box', () => {
    expect(delivered.has('.claude')).toBe(false)
  })

  it('never instructs a client to use .claude/agents/', () => {
    const offenders = shippedDocs
      .filter((d) => d.body.includes('.claude/agents'))
      .map((d) => d.name)
    expect(offenders).toEqual([])
  })
})
