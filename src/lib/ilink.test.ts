import { describe, it, expect } from 'vitest'
import { assertIlinkOk, isRetryableSendError, ilinkGetUpdates } from './ilink'

describe('assertIlinkOk', () => {
  it('passes when response has no errcode', () => {
    expect(() => assertIlinkOk('sendmessage', '{}')).not.toThrow()
    expect(() => assertIlinkOk('sendmessage', '{"ok": true}')).not.toThrow()
  })

  it('passes when errcode is 0', () => {
    expect(() => assertIlinkOk('sendmessage', '{"errcode":0}')).not.toThrow()
    expect(() => assertIlinkOk('sendmessage', '{"ret":0,"errcode":0}')).not.toThrow()
  })

  it('throws when errcode is non-zero', () => {
    expect(() => assertIlinkOk('sendmessage', '{"errcode":-14,"errmsg":"session expired"}')).toThrow(/errcode=-14/)
    expect(() => assertIlinkOk('sendmessage', '{"errcode":-1,"errmsg":"bad token"}')).toThrow(/errcode=-1/)
  })

  it('falls back to ret when errcode missing', () => {
    expect(() => assertIlinkOk('sendmessage', '{"ret":-14,"errmsg":"session expired"}')).toThrow(/errcode=-14/)
  })

  it('tolerates non-JSON bodies (treats as success)', () => {
    expect(() => assertIlinkOk('sendmessage', 'OK')).not.toThrow()
    expect(() => assertIlinkOk('sendmessage', '')).not.toThrow()
  })

  it('includes endpoint in thrown message', () => {
    expect(() => assertIlinkOk('sendtyping', '{"errcode":-1}')).toThrow(/ilink\/sendtyping/)
  })

  it('includes errmsg when present', () => {
    expect(() => assertIlinkOk('sendmessage', '{"errcode":-14,"errmsg":"session expired"}'))
      .toThrow(/session expired/)
  })

  it('tolerates missing errmsg with "no errmsg"', () => {
    expect(() => assertIlinkOk('sendmessage', '{"errcode":-14}')).toThrow(/no errmsg/)
  })
})

it('ilinkGetUpdates passes a custom timeoutMs through to the abort cap', async () => {
  let seenSignalAbortedFast = false
  const orig = globalThis.fetch
  // Fake fetch that never resolves until aborted; record how quickly abort fires.
  globalThis.fetch = ((_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      const start = Date.now()
      init.signal.addEventListener('abort', () => {
        seenSignalAbortedFast = Date.now() - start < 1000
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })) as any
  try {
    const resp = await ilinkGetUpdates('https://x.test', 'tok', '', 200)
    expect(resp).toEqual({ ret: 0, msgs: [], get_updates_buf: '' })
    expect(seenSignalAbortedFast).toBe(true)
  } finally {
    globalThis.fetch = orig
  }
})

describe('isRetryableSendError', () => {
  it('retries on AbortError (timeout)', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isRetryableSendError(err)).toBe(true)
  })

  it('retries on HTTP 5xx', () => {
    expect(isRetryableSendError(new Error('ilink/bot/sendmessage 502: bad gateway'))).toBe(true)
    expect(isRetryableSendError(new Error('ilink/bot/sendmessage 500: internal error'))).toBe(true)
  })

  it('does NOT retry on HTTP 4xx', () => {
    expect(isRetryableSendError(new Error('ilink/bot/sendmessage 400: bad request'))).toBe(false)
    expect(isRetryableSendError(new Error('ilink/bot/sendmessage 403: forbidden'))).toBe(false)
  })

  it('does NOT retry on session expired (errcode=-14)', () => {
    expect(isRetryableSendError(new Error('ilink/sendmessage errcode=-14: session expired'))).toBe(false)
  })

  it('does NOT retry on auth error (errcode=-6)', () => {
    expect(isRetryableSendError(new Error('ilink/sendmessage errcode=-6: bad auth'))).toBe(false)
  })

  it('retries on unknown errcode (treats as transient)', () => {
    expect(isRetryableSendError(new Error('ilink/sendmessage errcode=-99: unknown'))).toBe(true)
  })

  it('does NOT retry on plain string errors (no pattern match)', () => {
    expect(isRetryableSendError(new Error('random network glitch'))).toBe(false)
  })
})
