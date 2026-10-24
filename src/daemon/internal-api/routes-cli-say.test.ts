/**
 * /v1/cli/say(terminal_say,2026-10-24)的门:走真的 internal-api(HTTP + 令牌登记 + 档位表),
 * 证明访客 / 非主人 / file 令牌一句话都送不进终端会话;只有主人那条聊天的 admin 会话令牌能。
 * terminalSay 是假的 —— 不碰任何真的终端窗口。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from './index'
import { makeMemoryFS } from '../memory/fs-api'
import { minTierFor } from './route-tiers'
import { REQUEST_SCHEMAS } from './schema'
import { WORKBENCH_ERRORS } from '@wechat-cc/protocol'

const OWNER = 'owner@im.wechat'
let stateDir: string
let api: InternalApi | null
let said: Array<[string, string]>

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cli-say-')); api = null; said = [] })
afterEach(async () => { if (api) await api.stop({ unlinkToken: true }).catch(() => {}); rmSync(stateDir, { recursive: true, force: true }) })

async function boot() {
  api = createInternalApi({ stateDir, daemonPid: 1, memory: makeMemoryFS({ rootDir: join(stateDir, 'memory') }) })
  const { port, tokenFilePath } = await api.start()
  api.provide({ terminalSay: {
    say: (code, text) => { said.push([code, text]); return { ok: true, ticket: 'a1b2c3d4e5f6', via: 'window', code, source: 'claude', project: 'cc', was_running: false, read_only: false, max_wait_ms: 570_000 } },
    wait: async (ticket) => ticket === 'a1b2c3d4e5f6'
      ? { ticket, code: 'abc123', source: 'claude', project: 'cc', via: 'window', state: 'replied', final: true, delivered: true, reply: '好', reply_truncated: false, error: null, elapsed_ms: 5, was_running: false, reply_verified: true, read_only: false, owner_notified: false, max_wait_ms: 570_000 }
      : null,
    isOwnerChat: (chatId) => chatId === OWNER,
  } })
  const post = (token: string) => fetch(`http://127.0.0.1:${port}/v1/cli/say`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abc123', text: '先停下' }),
  })
  const get = (token: string, ticket = 'a1b2c3d4e5f6') => fetch(`http://127.0.0.1:${port}/v1/cli/say?ticket=${ticket}&wait_ms=0`, { headers: { Authorization: `Bearer ${token}` } })
  return { api, post, get, fileToken: readFileSync(tokenFilePath, 'utf8').trim() }
}

describe('/v1/cli/say 的门', () => {
  it('访客会话令牌 ⇒ 403(档位),什么都没送', async () => {
    const h = await boot()
    const guest = h.api.mintSessionToken('guest', 'claude/a/stranger@im.wechat')
    expect((await h.post(guest)).status).toBe(403)
    expect((await h.get(guest)).status).toBe(403)
    // 访客冒用主人的 chatId 也一样:档位先挡
    const spoof = h.api.mintSessionToken('guest', `claude/a/${OWNER}`)
    expect((await h.post(spoof)).status).toBe(403)
    expect(said).toEqual([])
  })

  it('trusted 会话 / daemon file 令牌 ⇒ 403;admin 档但不是主人那条聊天 ⇒ 403 terminal_say_not_owner', async () => {
    const h = await boot()
    expect((await h.post(h.api.mintSessionToken('trusted', 'claude/a/friend@im.wechat'))).status).toBe(403)
    expect((await h.post(h.fileToken)).status).toBe(403)
    const otherAdmin = await h.post(h.api.mintSessionToken('admin', 'claude/a/coadmin@im.wechat'))
    expect(otherAdmin.status).toBe(403)
    expect(await otherAdmin.json()).toMatchObject({ error: 'terminal_say_not_owner' })
    expect(said).toEqual([])
  })

  it('主人那条聊天的 admin 会话 ⇒ 送出、拿票、能轮询', async () => {
    const h = await boot()
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const r = await h.post(owner)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, ticket: 'a1b2c3d4e5f6', via: 'window' })
    expect(said).toEqual([['abc123', '先停下']])
    const g = await h.get(owner)
    expect(await g.json()).toMatchObject({ ok: true, state: 'replied', reply: '好' })
    expect((await h.get(owner, 'ffffffffffff')).status).toBe(404)
  })

  it('长轮询的调用方断开 ⇒ 交给 wait 的 signal 中止(挂着的等待不能当成「还有人在等」)', async () => {
    const h = await boot()
    let seen: AbortSignal | undefined
    const aborted = new Promise<void>((resolve) => {
      h.api.provide({ terminalSay: {
        say: () => { throw new Error('unused') },
        wait: (_t, _ms, signal) => new Promise((res) => {
          seen = signal
          signal?.addEventListener('abort', () => { resolve(); res(null) }, { once: true })
        }),
        isOwnerChat: (c) => c === OWNER,
      } })
    })
    const owner = h.api.mintSessionToken('admin', `claude/a/${OWNER}`)
    const ac = new AbortController()
    const port = h.api.port()
    const req = fetch(`http://127.0.0.1:${port}/v1/cli/say?ticket=a1b2c3d4e5f6&wait_ms=20000`, { headers: { Authorization: `Bearer ${owner}` }, signal: ac.signal }).catch(() => null)
    for (let i = 0; i < 100 && !seen; i++) await new Promise(r => setTimeout(r, 10))
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    ac.abort()
    await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error('signal never aborted')), 3_000))])
    expect(seen!.aborted).toBe(true)
    await req
  })

  it('档位表 admin、不给 operator;schema;错误码都在一张表里', () => {
    expect(minTierFor('POST /v1/cli/say')).toBe('admin')
    expect(minTierFor('GET /v1/cli/say')).toBe('admin')
    const s = REQUEST_SCHEMAS['POST /v1/cli/say']!
    expect(s.safeParse({ code: 'abc123', text: 'x' }).success).toBe(true)
    expect(s.safeParse({ code: 'abc123', text: '' }).success).toBe(false)
    expect(s.safeParse({ code: 'abc123', text: 'x'.repeat(4001) }).success).toBe(false)
    expect(s.safeParse({ code: 'not-hex!', text: 'x' }).success).toBe(false)
    for (const c of ['terminal_say_not_owner', 'terminal_say_not_wired', 'terminal_say_unknown_session', 'terminal_say_ticket_unknown',
      'terminal_say_remote', 'terminal_say_ended', 'terminal_say_turn_open', 'terminal_say_pending']) expect(WORKBENCH_ERRORS[c], c).toBeDefined()
  })
})
