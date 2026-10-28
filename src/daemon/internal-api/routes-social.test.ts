// src/daemon/internal-api/routes-social.test.ts
//
// 社交关着也要能用的那几条(这里是总开关)。心愿 / 介绍的路由归社交模块,测试在 src/features/social/routes.test.ts。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socialRoutes } from './routes-social'
import type { InternalApiDeps } from './types'


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
