/**
 * tests/eval-tasks.test.ts
 *
 * Phase 4 certification: the golden-task catalog and its selector. This does
 * NOT run the tasks against a model (that costs tokens and is the cert pass's
 * job); it enforces structural integrity — unique names, valid category/tier,
 * the 30-task certification floor — and the tier/category/name selection logic
 * the CLI drives.
 */
import { describe, expect, it } from 'vitest'
import { TASKS, selectTasks } from '../src/eval/tasks.js'
import type { Category, Tier } from '../src/eval/types.js'

const CATEGORIES: Category[] = [
  'persona', 'datetime', 'shell', 'file-read', 'file-write', 'file-edit',
  'multi-step', 'memory', 'instruction', 'error-recovery', 'retrieval',
]
const TIERS: Tier[] = ['smoke', 'full']

describe('task catalog integrity', () => {
  it('has unique task names', () => {
    const names = TASKS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('tags every task with a valid category and tier and function hooks', () => {
    for (const t of TASKS) {
      expect(CATEGORIES).toContain(t.category)
      expect(TIERS).toContain(t.tier)
      expect(typeof t.message).toBe('function')
      expect(typeof t.check).toBe('function')
    }
  })

  it('meets the 30-task certification floor', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(30)
  })

  it('keeps a non-empty smoke subset that is smaller than the full catalog', () => {
    const smoke = TASKS.filter(t => t.tier === 'smoke')
    expect(smoke.length).toBeGreaterThan(0)
    expect(smoke.length).toBeLessThan(TASKS.length)
  })
})

describe('selectTasks', () => {
  it('returns only smoke-tier tasks for tier=smoke', () => {
    const picked = selectTasks({ tier: 'smoke' })
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.every(t => t.tier === 'smoke')).toBe(true)
  })

  it('returns the whole catalog for tier=full', () => {
    expect(selectTasks({ tier: 'full' }).length).toBe(TASKS.length)
  })

  it('filters to a single task by name', () => {
    const picked = selectTasks({ name: 'identity' })
    expect(picked).toHaveLength(1)
    expect(picked[0].name).toBe('identity')
  })

  it('filters by category', () => {
    const picked = selectTasks({ category: 'shell' })
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.every(t => t.category === 'shell')).toBe(true)
  })
})
