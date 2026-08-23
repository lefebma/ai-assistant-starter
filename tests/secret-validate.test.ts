/**
 * tests/secret-validate.test.ts
 *
 * Live key validation for /secret set: before a captured key is written to
 * the vault, it gets one cheap authenticated call against its provider. The
 * mapping that matters: 2xx → ok, 401/403 → invalid (don't save a key the
 * provider rejects), anything else (including network failure) → unverified
 * (save it, warn — a provider outage must not lock the client out of saving
 * a good key). Fetch is injected; no test touches the network.
 */
import { describe, expect, it } from 'vitest'
import { createValidator } from '../src/secrets/validate.js'

type FetchCall = { url: string; headers: Record<string, string> }

function fakeFetch(status: number, calls: FetchCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response('{}', { status })
  }) as typeof fetch
}

describe('createValidator', () => {
  it('accepts a key the provider accepts', async () => {
    const validate = createValidator(fakeFetch(200))
    expect((await validate('OPENAI_API_KEY', 'sk-good')).status).toBe('ok')
  })

  it('rejects a key the provider rejects with 401', async () => {
    const validate = createValidator(fakeFetch(401))
    expect((await validate('OPENAI_API_KEY', 'sk-bad')).status).toBe('invalid')
  })

  it('rejects on 403 too', async () => {
    const validate = createValidator(fakeFetch(403))
    expect((await validate('ANTHROPIC_API_KEY', 'sk-ant-bad')).status).toBe('invalid')
  })

  it('treats a provider 5xx as unverified, not invalid', async () => {
    const validate = createValidator(fakeFetch(503))
    expect((await validate('OPENAI_API_KEY', 'sk-maybe')).status).toBe('unverified')
  })

  it('treats a network failure as unverified', async () => {
    const validate = createValidator((async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    expect((await validate('OPENAI_API_KEY', 'sk-maybe')).status).toBe('unverified')
  })

  it('sends the OpenAI key as a bearer token to the models endpoint', async () => {
    const calls: FetchCall[] = []
    await createValidator(fakeFetch(200, calls))('OPENAI_API_KEY', 'sk-test')
    expect(calls[0].url).toContain('api.openai.com')
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-test')
  })

  it('sends the Anthropic key in x-api-key with a version header', async () => {
    const calls: FetchCall[] = []
    await createValidator(fakeFetch(200, calls))('ANTHROPIC_API_KEY', 'sk-ant-test')
    expect(calls[0].url).toContain('api.anthropic.com')
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-test')
    expect(calls[0].headers['anthropic-version']).toBeTruthy()
  })

  it('validates a Telegram bot token via getMe', async () => {
    const calls: FetchCall[] = []
    await createValidator(fakeFetch(200, calls))('TELEGRAM_BOT_TOKEN', '99:AAtoken')
    expect(calls[0].url).toContain('api.telegram.org/bot99:AAtoken/getMe')
  })

  it('sends the ElevenLabs key in xi-api-key', async () => {
    const calls: FetchCall[] = []
    await createValidator(fakeFetch(200, calls))('ELEVENLABS_API_KEY', 'el-test')
    expect(calls[0].url).toContain('api.elevenlabs.io')
    expect(calls[0].headers['xi-api-key']).toBe('el-test')
  })

  it('passes the Google key as a query parameter', async () => {
    const calls: FetchCall[] = []
    await createValidator(fakeFetch(200, calls))('GOOGLE_API_KEY', 'AIza-test')
    expect(calls[0].url).toContain('generativelanguage.googleapis.com')
    expect(calls[0].url).toContain('key=AIza-test')
  })

  it('a Google 400 with API_KEY_INVALID counts as invalid', async () => {
    const badKey = (async () =>
      new Response(JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }), {
        status: 400,
      })) as unknown as typeof fetch
    expect((await createValidator(badKey)('GOOGLE_API_KEY', 'nope')).status).toBe('invalid')
  })

  it('returns unverified for a name with no validator', async () => {
    let called = false
    const validate = createValidator((async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch)
    const res = await validate('HTTP_BEARER_TOKEN', 'whatever')
    expect(res.status).toBe('unverified')
    expect(called).toBe(false)
  })
})
