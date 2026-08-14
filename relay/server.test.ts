import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { makeRelayServer } from './server'

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const addr = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const sign = (m: string) => edSign(null, Buffer.from(m, 'utf8'),
    createPrivateKey({ key: Buffer.from(privDer, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url')
  return { addr, sign }
}
const NOW = 1_700_000_000_000
function post(path: string, body: unknown): Request {
  return new Request(`http://relay${path}`, { method: 'POST', body: JSON.stringify(body) })
}

describe('relay/server', () => {
  it('drop → fetch(signed) → ack round-trip; relay never parses the envelope', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const id = identity()
    // envelope is a deliberately NON-JSON opaque string — proves content-blindness.
    const drop = await srv.fetchHandler(post('/drop', { to: id.addr, envelope: '<<opaque-bytes>>' }), '1.1.1.1')
    expect(drop.status).toBe(200)
    const fReq = post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: id.sign(`fetch:${id.addr}:${NOW}`) })
    const fRes = await srv.fetchHandler(fReq, '1.1.1.1')
    const page = await fRes.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
    expect(page.items[0]!.envelope).toBe('<<opaque-bytes>>')
    const aReq = post('/ack', { mailbox: id.addr, up_to_cursor: page.next_cursor, ts: NOW, sig: id.sign(`ack:${id.addr}:${page.next_cursor}:${NOW}`) })
    expect((await srv.fetchHandler(aReq, '1.1.1.1')).status).toBe(200)
    const after = await (await srv.fetchHandler(post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: id.sign(`fetch:${id.addr}:${NOW}`) }), '1.1.1.1')).json() as { items: unknown[] }
    expect(after.items).toEqual([])
  })

  it('fetch/ack with a bad signature → 401', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const id = identity()
    const res = await srv.fetchHandler(post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: 'bad' }), '1.1.1.1')
    expect(res.status).toBe(401)
  })

  it('drop over the size cap → 400; drop is open (no signature required)', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW, maxEnvelopeBytes: 8 })
    const res = await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'way-too-long-envelope' }), '1.1.1.1')
    expect(res.status).toBe(400)
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'ok' }), '1.1.1.1')).status).toBe(200)
  })

  it('rate-limit refuses drops over capacity per source-IP → 429', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW, rate: { capacity: 1, refillPerSec: 0 } })
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'a' }), '9.9.9.9')).status).toBe(200)
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'b' }), '9.9.9.9')).status).toBe(429)
  })
})
