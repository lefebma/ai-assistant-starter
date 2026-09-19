/**
 * Every skill template ships enabled.
 *
 * Setup copies a template only when the owner chose it, so a template marked
 * "enabled": false is a skill the owner asked for that never loads. Outlook
 * shipped that way for its whole life: pick Outlook at setup, and the skill
 * sat on disk invisible until someone thought to send /skill enable outlook.
 * Disabling belongs to the owner, at runtime, not to the template.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'skills')

const manifests = readdirSync(TEMPLATES)
  .map((name) => join(TEMPLATES, name, 'manifest.json'))
  .filter((p) => existsSync(p))

describe('skill templates', () => {
  it('finds the templates it is checking', () => {
    expect(manifests.length).toBeGreaterThan(5)
  })

  it.each(manifests.map((p) => [p.split('/').slice(-2, -1)[0], p]))('%s ships enabled', (_name, path) => {
    const manifest = JSON.parse(readFileSync(path as string, 'utf-8')) as { enabled?: boolean }
    expect(manifest.enabled).not.toBe(false)
  })
})
