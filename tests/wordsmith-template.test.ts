/**
 * tests/wordsmith-template.test.ts
 *
 * The wordsmith skill template is always installed (no opt-in, no separate
 * API key), so its provider resolution has to work for every install shape:
 * whatever AI_PROVIDER the runtime uses, any other provider whose key is
 * present, and a clear error when no key exists at all.
 *
 * The template is exercised as a real CLI via execFile with
 * WORDSMITH_DRY_RUN=1 (prints the resolved call, key redacted, no network).
 * Importing the .mjs into vitest's module graph broke the Windows runner
 * with transform-level SyntaxErrors, so the suite stays out of that path
 * entirely; child processes behave the same on every platform. The skill
 * folder is copied to a tmpdir first so the script's project-root .env
 * lookup can never pick up a developer's real keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let workDir: string
let script: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wordsmith-test-'))
  const dest = join(workDir, 'skills', 'wordsmith')
  cpSync(join(process.cwd(), 'templates', 'skills', 'wordsmith'), dest, { recursive: true })
  script = join(dest, 'wordsmith.mjs')
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

type RunResult = { code: number; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      // PATH etc. stay; provider keys are passed explicitly per case.
      { env: { ...process.env, WORDSMITH_DRY_RUN: '1', ...env } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
    // The script reads stdin to EOF when it isn't a TTY; close the pipe so
    // it never waits on us.
    child.stdin?.end()
  })
}

const NO_KEYS = {
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  GOOGLE_API_KEY: '',
  AZURE_API_KEY: '',
  AI_PROVIDER: '',
  AI_MODEL: '',
  WORDSMITH_PROVIDER: '',
  WORDSMITH_MODEL: '',
  AZURE_RESOURCE_NAME: '',
  AI_BASE_URL: '',
}

async function dryRun(args: string[], env: Record<string, string>) {
  const r = await run(args, { ...NO_KEYS, ...env })
  expect(r.code, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}

describe('wordsmith provider resolution (dry-run CLI)', () => {
  it('uses AI_PROVIDER when its key is present, quality tier maps per provider', async () => {
    const out = await dryRun(['quality', 'write'], { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })
    expect(out.provider).toBe('openai')
    expect(out.model).toBe('gpt-5.4')
    expect(out.url).toContain('api.openai.com/v1/chat/completions')
  })

  it('falls past AI_PROVIDER when its key is missing, to the first available key', async () => {
    const out = await dryRun(['fast', 'write'], { AI_PROVIDER: 'openai', GOOGLE_API_KEY: 'g' })
    expect(out.provider).toBe('google')
    expect(out.model).toBe('gemini-2.5-flash')
  })

  it('prefers WORDSMITH_PROVIDER over everything', async () => {
    const out = await dryRun(['quality', 'write'], {
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'o',
      ANTHROPIC_API_KEY: 'a',
      WORDSMITH_PROVIDER: 'anthropic',
    })
    expect(out.provider).toBe('anthropic')
    expect(out.model).toBe('claude-sonnet-5')
    expect(out.temperature).toBe(0.7)
  })

  it('honors WORDSMITH_MODEL over tier defaults', async () => {
    const out = await dryRun(['quality', 'write'], {
      ANTHROPIC_API_KEY: 'a',
      WORDSMITH_MODEL: 'claude-opus-5',
    })
    expect(out.model).toBe('claude-opus-5')
  })

  it('passes an explicit model id through untouched', async () => {
    const out = await dryRun(['gemini-2.5-flash-lite', 'write'], { GOOGLE_API_KEY: 'g' })
    expect(out.model).toBe('gemini-2.5-flash-lite')
  })

  it('redacts the API key from the reported google URL', async () => {
    const out = await dryRun(['quality', 'write'], { GOOGLE_API_KEY: 'sekret-key-123' })
    expect(out.url).toContain('key=REDACTED')
    expect(out.url).not.toContain('sekret-key-123')
  })

  it('omits temperature on openai (gpt-5 family rejects non-default values)', async () => {
    const out = await dryRun(['quality', 'write'], { OPENAI_API_KEY: 'k' })
    expect(out.temperature).toBeNull()
  })

  it('azure reuses AI_MODEL as the deployment and builds the resource URL', async () => {
    const out = await dryRun(['quality', 'write'], {
      AZURE_API_KEY: 'z',
      AZURE_RESOURCE_NAME: 'contoso',
      AI_MODEL: 'gpt-5-4-mini',
    })
    expect(out.provider).toBe('azure')
    expect(out.model).toBe('gpt-5-4-mini')
    expect(out.url).toBe(
      'https://contoso.openai.azure.com/openai/deployments/gpt-5-4-mini/chat/completions?api-version=2024-10-21'
    )
    expect(out.temperature).toBeNull()
  })

  it('azure honors AI_BASE_URL over the resource name (sovereign clouds)', async () => {
    const out = await dryRun(['dep', 'write'], {
      AZURE_API_KEY: 'z',
      AI_BASE_URL: 'https://gov.example.us',
    })
    expect(out.url).toContain('https://gov.example.us/openai/deployments/dep/chat/completions')
  })

  it('reports a system prompt when WORDSMITH_VOICE is set', async () => {
    const out = await dryRun(['quality', 'write'], {
      ANTHROPIC_API_KEY: 'a',
      WORDSMITH_VOICE: 'be direct',
    })
    expect(out.system).toBe(true)
  })
})

describe('wordsmith error paths (dry-run CLI)', () => {
  it('exits 2 with usage when arguments are missing', async () => {
    const r = await run([], NO_KEYS)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Usage:')
  })

  it('errors listing every key env when nothing is configured', async () => {
    const r = await run(['quality', 'write'], NO_KEYS)
    expect(r.code).toBe(1)
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_API_KEY']) {
      expect(r.stderr).toContain(k)
    }
  })

  it('azure without any deployment name gives an actionable error', async () => {
    const r = await run(['quality', 'write'], {
      ...NO_KEYS,
      AZURE_API_KEY: 'z',
      AZURE_RESOURCE_NAME: 'contoso',
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/deployment name/)
  })

  it('azure without resource name or base URL names AZURE_RESOURCE_NAME', async () => {
    const r = await run(['dep', 'write'], { ...NO_KEYS, AZURE_API_KEY: 'z' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('AZURE_RESOURCE_NAME')
  })

  it('rejects an unknown WORDSMITH_PROVIDER by name', async () => {
    const r = await run(['quality', 'write'], {
      ...NO_KEYS,
      WORDSMITH_PROVIDER: 'cohere',
      GOOGLE_API_KEY: 'g',
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('cohere')
  })
})

describe('wordsmith no longer tells the assistant it is a Gemini skill', () => {
  // The manifest is the part the ContextEngine injects when the skill matches,
  // so a stale line there is not a documentation problem: it is an instruction.
  // It went on naming Gemini and demanding GOOGLE_API_KEY for two releases
  // after the skill became provider-agnostic.
  const read = (f: string) => readFileSync(join(process.cwd(), 'templates', 'skills', 'wordsmith', f), 'utf-8')

  it('does not name one provider as the writer', () => {
    const manifest = JSON.parse(read('manifest.json'))
    expect(manifest.description).not.toMatch(/gemini/i)
    expect(manifest.context).not.toMatch(/gemini/i)
  })

  it('does not present any single provider key as a requirement', () => {
    const manifest = JSON.parse(read('manifest.json'))
    // Naming the keys it can reuse is fine; "<KEY> in .env" as a prerequisite
    // is what was wrong, because the skill has no key of its own.
    expect(manifest.context).not.toMatch(/(Gemini|Google) API key/i)
  })

  it('says what happens on an install with no provider key at all', () => {
    // A subscription-only install cannot call anything. Silence here is how
    // the assistant ends up reporting a normal condition as a failure.
    expect(read('SKILL.md')).toMatch(/subscription-only/i)
  })
})
