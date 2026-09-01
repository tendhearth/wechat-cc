// src/daemon/internal-api/routes-social.test.ts
//
// P4 派心愿 — the propose/confirm/cancel routes replacing the old one-shot
// POST /v1/social/seek (deleted in this pass). Mirrors routes-pair.test.ts's
// deps-stub shape: a bare `{ social }` object cast through, no real broker.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socialRoutes } from './routes-social'
import type { InternalApiDeps } from './types'

function deps(social?: any): InternalApiDeps {
  return { social } as unknown as InternalApiDeps
}

describe('socialRoutes — propose/confirm/cancel', () => {
  it('the old one-shot route is gone', () => {
    const routes = socialRoutes(deps())
    expect(routes['POST /v1/social/seek']).toBeUndefined()
  })

  describe('POST /v1/social/seek/propose', () => {
    it('calls broker.propose(topic, { city }) and returns 200 with the result verbatim', async () => {
      const propose = vi.fn(async () => ({ ok: true, intent_id: 'i1', redacted: '找摄影搭子' }))
      const routes = socialRoutes(deps({ broker: { propose } }))
      const r = await routes['POST /v1/social/seek/propose']!({} as any, { topic: '找摄影搭子', city: '深圳' })
      expect(propose).toHaveBeenCalledWith('找摄影搭子', { city: '深圳' })
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, intent_id: 'i1', redacted: '找摄影搭子' })
    })

    it('omits opts when no city given', async () => {
      const propose = vi.fn(async () => ({ ok: true, intent_id: 'i1', redacted: 'x' }))
      const routes = socialRoutes(deps({ broker: { propose } }))
      await routes['POST /v1/social/seek/propose']!({} as any, { topic: 'x' })
      expect(propose).toHaveBeenCalledWith('x', undefined)
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/propose']!({} as any, { topic: 'x' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })

  describe('POST /v1/social/seek/confirm', () => {
    it('calls broker.confirmSeek(id) and returns 200 with the result verbatim', async () => {
      const confirmSeek = vi.fn(async () => ({ ok: true, intent_id: 'i1' }))
      const routes = socialRoutes(deps({ broker: { confirmSeek } }))
      const r = await routes['POST /v1/social/seek/confirm']!({} as any, { id: 'i1' })
      expect(confirmSeek).toHaveBeenCalledWith('i1')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, intent_id: 'i1' })
    })

    it('400 missing_id on a missing/empty id', async () => {
      const confirmSeek = vi.fn()
      const routes = socialRoutes(deps({ broker: { confirmSeek } }))
      const missing = await routes['POST /v1/social/seek/confirm']!({} as any, {})
      expect(missing.status).toBe(400)
      expect(missing.body).toEqual({ error: 'missing_id' })
      const empty = await routes['POST /v1/social/seek/confirm']!({} as any, { id: '' })
      expect(empty.status).toBe(400)
      expect(confirmSeek).not.toHaveBeenCalled()
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/confirm']!({} as any, { id: 'i1' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })

  describe('POST /v1/social/seek/cancel', () => {
    it('calls broker.cancelSeek(id) and returns 200 with the result verbatim', async () => {
      const cancelSeek = vi.fn(async () => ({ ok: true }))
      const routes = socialRoutes(deps({ broker: { cancelSeek } }))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, { id: 'i1' })
      expect(cancelSeek).toHaveBeenCalledWith('i1')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true })
    })

    it('400 missing_id on a missing id', async () => {
      const cancelSeek = vi.fn()
      const routes = socialRoutes(deps({ broker: { cancelSeek } }))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, {})
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ error: 'missing_id' })
      expect(cancelSeek).not.toHaveBeenCalled()
    })

    it('503 when deps.social is undefined', async () => {
      const routes = socialRoutes(deps(undefined))
      const r = await routes['POST /v1/social/seek/cancel']!({} as any, { id: 'i1' })
      expect(r.status).toBe(503)
      expect(r.body).toEqual({ error: 'social_not_wired' })
    })
  })
})

// 2026-08-31 —— 社交总开关的 HTTP 面。此前桌面端三处入口在社交未启用时
// 只会说「先在命令行运行 wechat-cc social enable」:一个桌面产品把人踢回
// 终端,被朋友拉来试的人基本必然卡死在这一步(找朋友测试的头号障碍)。
//
// 这条路由【不能】依赖 deps.social —— 社交没开时那个字段根本不存在,而
// "没开"恰恰是唯一需要它的时候。它只读写 stateDir 上的 agent-config.json。
describe('POST /v1/social/enable —— 桌面端的社交总开关', () => {
  function stateDeps(stateDir: string): InternalApiDeps {
    return { stateDir } as unknown as InternalApiDeps
  }

  it('社交未接线时依然可用(这正是它存在的意义)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-enable-'))
    try {
      const routes = socialRoutes(stateDeps(dir))   // 注意:没有 social 字段
      const r = await routes['POST /v1/social/enable']!({} as any, { enabled: true })
      expect(r.status).toBe(200)
      expect((r.body as any).enabled).toBe(true)
      expect((r.body as any).restart_required).toBe(true)   // 配对引擎在 boot 时接线
      const raw = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
      expect(raw.social_enabled).toBe(true)
      expect(raw.mailbox_relays.length).toBeGreaterThan(0)  // 默认中继已填好
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('能关回去(总开关必须双向,否则用户被单向门锁住)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-disable-'))
    try {
      const routes = socialRoutes(stateDeps(dir))
      await routes['POST /v1/social/enable']!({} as any, { enabled: true })
      const r = await routes['POST /v1/social/enable']!({} as any, { enabled: false })
      expect((r.body as any).enabled).toBe(false)
      const raw = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
      expect(raw.social_enabled).toBe(false)
      expect(raw.social_disclosure_policy).toBeTruthy()   // 关闭不清空,再开不用重填
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('空 body 读作关闭,不 500(与同族 POST 路由一致的防御)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routes-social-nobody-'))
    try {
      const routes = socialRoutes(stateDeps(dir))
      const r = await routes['POST /v1/social/enable']!({} as any, null)
      expect(r.status).toBe(200)
      expect((r.body as any).enabled).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
