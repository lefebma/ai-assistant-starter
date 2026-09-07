import { describe, it, expect } from 'vitest'
import { ContextEngine } from '../src/memory/engine.js'
import type { ContextFragment, ContextProvider } from '../src/memory/providers/base.js'

function stub(name: string, priority: number, fragments: ContextFragment[]): ContextProvider {
  return { name, priority, enabled: true, retrieve: async () => fragments }
}

describe('standing context fragments', () => {
  it('renders standing fragments in their own block after the memory block', async () => {
    const engine = new ContextEngine()
    engine.register(stub('workspace', 45, [
      { source: 'workspace', content: 'SHARED WORKSPACE "havn" (partner).', relevance: 0.9, standing: true },
      { source: 'workspace', content: '[havn/gtm/STATE.md] phase: build', relevance: 0.7 },
      { source: 'workspace', content: 'SHARED WORKSPACE RULES: ask when unsure.', relevance: 0.9, standing: true },
    ]))
    engine.register(stub('episodic', 50, [{ source: 'episodic', content: 'we talked about pricing', relevance: 1 }]))

    const out = await engine.buildContext('chat', 'what is the workspace status')

    expect(out).toContain('</memory-context>')
    expect(out).toContain('<workspace-context>')
    expect(out).toContain('STANDING RULES AND SHARED CONTEXT (active now, not history):')
    // The standing block comes after the history block, so nothing tells the
    // model these rules are already-handled history.
    expect(out.indexOf('<workspace-context>')).toBeGreaterThan(out.indexOf('</memory-context>'))
    // STATE content stays in the history block.
    expect(out.slice(0, out.indexOf('<workspace-context>'))).toContain('[havn/gtm/STATE.md]')
    // Provider order, not score order.
    expect(out.indexOf('SHARED WORKSPACE "havn"')).toBeLessThan(out.indexOf('SHARED WORKSPACE RULES'))
  })

  it('exempts standing fragments from the token budget', async () => {
    const engine = new ContextEngine(10) // 40 chars of budget
    engine.register(stub('episodic', 50, [{ source: 'episodic', content: 'x'.repeat(500), relevance: 1 }]))
    engine.register(stub('workspace', 45, [
      { source: 'workspace', content: 'BANNER ' + 'y'.repeat(500), relevance: 0.9, standing: true },
    ]))

    const out = await engine.buildContext('chat', 'anything')
    expect(out).toContain('BANNER ' + 'y'.repeat(500))
    expect(out).not.toContain('x'.repeat(500))
  })

  it('emits only the standing block when there is no history to show', async () => {
    const engine = new ContextEngine()
    engine.register(stub('workspace', 45, [
      { source: 'workspace', content: 'BANNER', relevance: 0.9, standing: true },
    ]))
    const out = await engine.buildContext('chat', 'anything')
    expect(out).not.toContain('memory-context')
    expect(out).toContain('<workspace-context>')
  })
})
