import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { InboundTokenValidator, BOT_FRAMEWORK_ISSUER } from '../src/platform/teams/auth.js'

// jose v6 has no KeyLike export; take the type from generateKeyPair itself.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const APP_ID = '11111111-2222-3333-4444-555555555555'
const OPENID = 'https://login.example/openid'
const JWKS = 'https://login.example/keys'

let privateKey: PrivateKey
let publicJwk: Record<string, unknown>
let rotatedPrivate: PrivateKey
let rotatedJwk: Record<string, unknown>

beforeAll(async () => {
  const a = await generateKeyPair('RS256')
  privateKey = a.privateKey
  publicJwk = { ...(await exportJWK(a.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }
  const b = await generateKeyPair('RS256')
  rotatedPrivate = b.privateKey
  rotatedJwk = { ...(await exportJWK(b.publicKey)), kid: 'key-2', alg: 'RS256', use: 'sig' }
})

function fakeFetch(keys: () => Record<string, unknown>[], counter: { jwks: number }) {
  return async (url: string): Promise<Response> => {
    if (url === OPENID) return new Response(JSON.stringify({ jwks_uri: JWKS }), { status: 200 })
    if (url === JWKS) {
      counter.jwks++
      return new Response(JSON.stringify({ keys: keys() }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
}

async function sign(key: PrivateKey, kid: string, claims: { iss?: string; aud?: string; expSeconds?: number }) {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT({ serviceurl: 'https://smba.trafficmanager.net/amer/' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(claims.iss ?? BOT_FRAMEWORK_ISSUER)
    .setAudience(claims.aud ?? APP_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (claims.expSeconds ?? 300))
    .sign(key)
}

describe('InboundTokenValidator', () => {
  it('accepts a token signed by a published key for this app', async () => {
    const counter = { jwks: 0 }
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], counter), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    expect(counter.jwks).toBe(1) // cached
  })

  it('rejects a missing or malformed header', async () => {
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(undefined)).toBe(false)
    expect(await v.validate('Basic abc')).toBe(false)
    expect(await v.validate('Bearer not.a.jwt')).toBe(false)
  })

  it('rejects the wrong issuer, the wrong audience, and an expired token', async () => {
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { iss: 'https://evil.example' })}`)).toBe(false)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { aud: 'some-other-app' })}`)).toBe(false)
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', { expSeconds: -120 })}`)).toBe(false)
  })

  it('refetches the key set once when it sees an unknown kid (key rotation)', async () => {
    let published = [publicJwk]
    const counter = { jwks: 0 }
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => published, counter), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(privateKey, 'key-1', {})}`)).toBe(true)
    published = [publicJwk, rotatedJwk]
    expect(await v.validate(`Bearer ${await sign(rotatedPrivate, 'key-2', {})}`)).toBe(true)
    expect(counter.jwks).toBe(2)
    // unknown kid that never appears: one refetch, then reject
    const stranger = await generateKeyPair('RS256')
    expect(await v.validate(`Bearer ${await sign(stranger.privateKey, 'key-9', {})}`)).toBe(false)
    expect(counter.jwks).toBe(3)
  })

  it('rejects a token signed with a key that is not published', async () => {
    const stranger = await generateKeyPair('RS256')
    const v = new InboundTokenValidator({ appId: APP_ID, fetchImpl: fakeFetch(() => [publicJwk], { jwks: 0 }), openIdConfigUrl: OPENID })
    expect(await v.validate(`Bearer ${await sign(stranger.privateKey, 'key-1', {})}`)).toBe(false)
  })
})
