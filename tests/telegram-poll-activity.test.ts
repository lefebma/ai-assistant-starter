import { describe, it, expect, vi } from 'vitest'
import { createPollActivityTransformer } from '../src/platform/telegram.js'

/**
 * The polling watchdog restarts the process when activity stops. These tests
 * pin what counts as activity: a completed getUpdates round trip and nothing
 * else. Get this wrong in either direction and the box either restarts itself
 * on a quiet afternoon or sits wedged behind a duplicate poller.
 */
const call = async (
  transformer: ReturnType<typeof createPollActivityTransformer>,
  method: string,
  response: unknown
) => {
  const prev = vi.fn(async () => response) as never
  const res = await (transformer as never as (
    p: unknown,
    m: string,
    payload: unknown,
    signal?: AbortSignal
  ) => Promise<unknown>)(prev, method, {}, undefined)
  return { res, prev: prev as unknown as ReturnType<typeof vi.fn> }
}

describe('createPollActivityTransformer', () => {
  it('reports activity for a successful getUpdates that returned no updates', async () => {
    const onActivity = vi.fn()
    const t = createPollActivityTransformer(onActivity)
    await call(t, 'getUpdates', { ok: true, result: [] })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it('reports activity for a successful getUpdates that carried updates', async () => {
    const onActivity = vi.fn()
    const t = createPollActivityTransformer(onActivity)
    await call(t, 'getUpdates', { ok: true, result: [{ update_id: 1 }] })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it('stays silent when getUpdates fails, so the watchdog can catch a duplicate poller', async () => {
    const onActivity = vi.fn()
    const t = createPollActivityTransformer(onActivity)
    await call(t, 'getUpdates', {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('stays silent when the poll throws, and lets the error through', async () => {
    const onActivity = vi.fn()
    const t = createPollActivityTransformer(onActivity)
    const prev = vi.fn(async () => {
      throw new Error('network down')
    }) as never
    await expect(
      (t as never as (p: unknown, m: string, payload: unknown) => Promise<unknown>)(prev, 'getUpdates', {})
    ).rejects.toThrow('network down')
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('ignores outbound calls, so a sending-but-not-polling bot still trips the watchdog', async () => {
    const onActivity = vi.fn()
    const t = createPollActivityTransformer(onActivity)
    await call(t, 'sendMessage', { ok: true, result: { message_id: 7 } })
    await call(t, 'sendChatAction', { ok: true, result: true })
    await call(t, 'getMe', { ok: true, result: { id: 1 } })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('passes the API response straight through', async () => {
    const t = createPollActivityTransformer(() => {})
    const response = { ok: true, result: [{ update_id: 99 }] }
    const { res, prev } = await call(t, 'getUpdates', response)
    expect(res).toBe(response)
    expect(prev).toHaveBeenCalledTimes(1)
  })
})
