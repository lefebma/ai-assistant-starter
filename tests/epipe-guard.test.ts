/**
 * tests/epipe-guard.test.ts
 *
 * The guard survives exactly one uncaught error, the async EPIPE the Claude
 * SDK throws writing to a CLI it just killed on cancel, and keeps Node's
 * default exit for everything else.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { isBrokenChildPipe, installEpipeGuard } from '../src/infra/epipe-guard.js'

describe('isBrokenChildPipe', () => {
  it('matches an EPIPE from a write', () => {
    expect(isBrokenChildPipe(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }))).toBe(true)
  })

  it('does not match other errors', () => {
    expect(isBrokenChildPipe(new Error('real bug'))).toBe(false)
    expect(isBrokenChildPipe(Object.assign(new Error('x'), { code: 'EPIPE', syscall: 'read' }))).toBe(false)
    expect(isBrokenChildPipe(Object.assign(new Error('x'), { code: 'ECONNRESET', syscall: 'write' }))).toBe(false)
    expect(isBrokenChildPipe(undefined)).toBe(false)
  })
})

describe('installEpipeGuard', () => {
  const before = process.listeners('uncaughtException')
  afterEach(() => {
    for (const l of process.listeners('uncaughtException')) {
      if (!before.includes(l)) process.removeListener('uncaughtException', l)
    }
  })

  it('swallows a broken child pipe and exits on anything else', () => {
    const exit = vi.fn()
    installEpipeGuard(exit)
    const handler = process.listeners('uncaughtException').find((l) => !before.includes(l))!
    handler(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }), 'uncaughtException')
    expect(exit).not.toHaveBeenCalled()
    handler(new Error('real bug'), 'uncaughtException')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
