import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRoutes } from './routes'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'

function routesWith(deps: unknown) {
  return makeRoutes({ deps: deps as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
}

function stateDirWith(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'routes-model-'))
  saveAgentConfig(dir, { ...loadAgentConfig(dir), ...config } as never)
  return dir
}

// 「切到 opus 5」—— 主人在哪个对话里说,改的就得是那个对话所用 provider 的
// 模型。老路由只认全局默认 provider:在 /api 对话里说「换模型」,改的是
// claude 的字段,读回还理直气壮地说 ok。
describe('/v1/model — per-provider', () => {
  it('GET ?provider= reports THAT provider\'s model, not the global default\'s', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8', openaiModel: 'DeepSeek', agyModel: 'gemini-3.7-flash-high' })
    try {
      const r = routesWith({ stateDir: dir })
      expect((await r['GET /v1/model']!(new URLSearchParams(), undefined)).body).toEqual({ provider: 'claude', model: 'claude-opus-4-8' })
      expect((await r['GET /v1/model']!(new URLSearchParams('provider=openai'), undefined)).body).toEqual({ provider: 'openai', model: 'DeepSeek' })
      expect((await r['GET /v1/model']!(new URLSearchParams('provider=agy'), undefined)).body).toEqual({ provider: 'agy', model: 'gemini-3.7-flash-high' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('POST with provider writes that provider\'s own field and leaves the global default untouched', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8', openaiModel: 'DeepSeek' })
    try {
      const r = routesWith({ stateDir: dir })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'Qwen3.8-Instruct', provider: 'openai' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: true, provider: 'openai', model: 'Qwen3.8-Instruct' })
      const cfg = loadAgentConfig(dir)
      expect(cfg.openaiModel).toBe('Qwen3.8-Instruct')
      expect(cfg.model).toBe('claude-opus-4-8')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('POST without provider keeps the legacy behavior (global default provider)', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8' })
    try {
      const r = routesWith({ stateDir: dir })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'claude-opus-5' })
      expect(res.body).toMatchObject({ ok: true, provider: 'claude', model: 'claude-opus-5' })
      expect(loadAgentConfig(dir).model).toBe('claude-opus-5')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // 主人说「切到 opus5」,期待的是**下一句**就跑在 opus5 上。但 session 缓存键
  // 是 (provider, alias, chat),老 session 不释放就一直用旧模型 —— 「改了但
  // 没生效」比「没改」更糟。写完顺手把该 provider 的活 session 全放掉。
  it('POST releases every live session of that provider so the next turn respawns on the new model', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8' })
    try {
      const released: unknown[] = []
      const sessions = [
        { alias: '_default', providerId: 'claude', chatId: 'A', lastUsedAt: 0 },
        { alias: '_default', providerId: 'claude', chatId: 'B', lastUsedAt: 0 },
        { alias: '_default', providerId: 'agy', chatId: 'C', lastUsedAt: 0 },
      ]
      const r = routesWith({
        stateDir: dir,
        listSessions: () => sessions,
        releaseSession: vi.fn(async (k: unknown) => { released.push(k) }),
      })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'claude-opus-5', provider: 'claude' })
      expect(res.body).toMatchObject({ ok: true, released: 2 })
      expect(released).toEqual([
        { alias: '_default', providerId: 'claude', chatId: 'A' },
        { alias: '_default', providerId: 'claude', chatId: 'B' },
      ])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // 光放掉活 session 不够:下一次 spawn 会 resume 回存档里的会话,而续接的会话
  // 沿用它开张时的模型(ACP session/load 不带模型)⇒ 换模型在续接的对话上是空操作。
  it('POST also drops that provider\'s resume rows so the next spawn cold-starts and pins the new model', async () => {
    const dir = stateDirWith({ provider: 'cursor', cursorModel: 'composer-1' })
    try {
      const forgetProviderSessions = vi.fn(() => 3)
      const r = routesWith({ stateDir: dir, listSessions: () => [], releaseSession: vi.fn(async () => {}), forgetProviderSessions })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'composer-2', provider: 'cursor' })
      expect(forgetProviderSessions).toHaveBeenCalledWith('cursor')
      expect(res.body).toMatchObject({ ok: true, provider: 'cursor', forgotten: 3 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a throwing / unwired resume-archive dropper never fails the model switch', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8' })
    try {
      const r = routesWith({ stateDir: dir, forgetProviderSessions: () => { throw new Error('db gone') } })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'claude-opus-5', provider: 'claude' })
      expect(res.body).toMatchObject({ ok: true, forgotten: 0 })
      const unwired = routesWith({ stateDir: dir })
      expect((await unwired['POST /v1/model']!(new URLSearchParams(), { model: 'claude-opus-5', provider: 'claude' })).body).toMatchObject({ ok: true, forgotten: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('still rejects bare family aliases (no digit) — `opus` would 404 every turn', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8' })
    try {
      const r = routesWith({ stateDir: dir })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'opus', provider: 'claude' })
      expect(res.status).toBe(400)
      expect(loadAgentConfig(dir).model).toBe('claude-opus-4-8')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an unknown provider id instead of silently writing `model`', async () => {
    const dir = stateDirWith({ provider: 'claude', model: 'claude-opus-4-8' })
    try {
      const r = routesWith({ stateDir: dir })
      const res = await r['POST /v1/model']!(new URLSearchParams(), { model: 'x-1', provider: 'bogus' })
      expect(res.status).toBe(400)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('POST /v1/conversation/set-mode — provider_switch path', () => {
  it('forwards solo+model to the coordinator and stays silent when quiet=true', async () => {
    const setMode = vi.fn()
    const sendReply = vi.fn(async () => ({}))
    const r = routesWith({ conversation: { setMode }, ilink: { sendReply } })
    const res = await r['POST /v1/conversation/set-mode']!(new URLSearchParams(), { chatId: 'c1', mode: { kind: 'solo', provider: 'openai', model: 'DeepSeek' }, quiet: true })
    expect(res.status).toBe(200)
    expect(setMode).toHaveBeenCalledWith('c1', { kind: 'solo', provider: 'openai', model: 'DeepSeek' })
    expect(sendReply).not.toHaveBeenCalled()
  })
  it('still sends the console-style confirmation when not quiet', async () => {
    const sendReply = vi.fn(async () => ({}))
    const r = routesWith({ conversation: { setMode: vi.fn() }, ilink: { sendReply } })
    await r['POST /v1/conversation/set-mode']!(new URLSearchParams(), { chatId: 'c1', mode: { kind: 'solo', provider: 'claude' } })
    expect(sendReply).toHaveBeenCalledTimes(1)
  })
  it('surfaces the coordinator\'s unknown-provider rejection as 400', async () => {
    const r = routesWith({ conversation: { setMode: () => { throw new Error('unknown provider: bogus') } } })
    const res = await r['POST /v1/conversation/set-mode']!(new URLSearchParams(), { chatId: 'c1', mode: { kind: 'solo', provider: 'bogus' }, quiet: true })
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/selftest/converse', () => {
  it('503s until bootstrap wires selftestConverse', async () => {
    const r = routesWith({})
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: 'ping' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'selftest_not_wired' })
  })

  it('400s on a malformed providerId', async () => {
    const r = routesWith({ selftestConverse: vi.fn() })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'Claude!', text: 'ping' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_request' })
  })

  it('400s on empty text', async () => {
    const r = routesWith({ selftestConverse: vi.fn() })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: '' })
    expect(res.status).toBe(400)
  })

  it('400s on text over 4000 chars', async () => {
    const r = routesWith({ selftestConverse: vi.fn() })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  it('400s on a resumeSessionId over 500 chars', async () => {
    const r = routesWith({ selftestConverse: vi.fn() })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: 'ping', resumeSessionId: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  it('passes through a 200 result verbatim, forwarding providerId/text/resumeSessionId', async () => {
    const fakeResult = { ok: true, providerId: 'claude', sessionId: 's1', texts: ['pong 42'], toolCalls: ['wechat/ping'], durationMs: 12 }
    const selftestConverse = vi.fn(async () => fakeResult)
    const r = routesWith({ selftestConverse })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: 'ping', resumeSessionId: 'old' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(fakeResult)
    expect(selftestConverse).toHaveBeenCalledWith({ providerId: 'claude', text: 'ping', resumeSessionId: 'old' })
  })

  it('passes through an ok:false result as a normal 200 (the failure lives in the body)', async () => {
    const fakeResult = { ok: false, providerId: 'claude', sessionId: null, texts: [], toolCalls: [], error: 'unavailable_provider', durationMs: 1 }
    const r = routesWith({ selftestConverse: vi.fn(async () => fakeResult) })
    const res = await r['POST /v1/selftest/converse']!(new URLSearchParams(), { providerId: 'claude', text: 'ping' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(fakeResult)
  })
})
