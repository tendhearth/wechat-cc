/**
 * boot 顺序钉子(spec 2026-09-27-bootstrap-split,Review Focus #1;架构终态 A2 起 bootstrap 是一组模块)。
 * 模块表的顺序 = 开机顺序 = 关机的倒序,也就是 supervisor 收养的那一组的名字序列。多一块、少一块、换位都在这里红。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { SubsystemSupervisor } from '../subsystems'
import { buildBootstrap } from './index'

function ilinkStub() {
  return {
    sendMessage: vi.fn(), sendFile: vi.fn(), editMessage: vi.fn(), broadcast: vi.fn(), sharePage: vi.fn(), resurfacePage: vi.fn(), setUserName: vi.fn(),
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    voice: {} as any,
    companion: {
      enable: vi.fn(), disable: vi.fn(), snooze: vi.fn(), personaSwitch: vi.fn(), triggerAdd: vi.fn(), triggerRemove: vi.fn(), triggerPause: vi.fn(),
      status: () => ({ enabled: false, timezone: 'Asia/Shanghai', per_project_persona: {}, personas_available: [], triggers: [], snooze_until: null, pushes_last_24h: 0, runs_last_24h: 0 }),
    },
    askUser: vi.fn(),
  }
}

describe('buildBootstrap boot order', () => {
  it('模块序列 == boot-base → knowledge → boot-core → self-restart → idle-sweep → social → mailbox-poller → a2a-server → pairing → yi → bootstrap', async () => {
    const sup = new SubsystemSupervisor(() => {})
    const boot = await buildBootstrap({
      supervisor: sup,
      db: openTestDb(),
      stateDir: mkdtempSync(join(tmpdir(), 'boot-order-')),
      ilink: ilinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: join(tmpdir(), 'token') },
    })
    try {
      const names = sup.statuses().map(s => s.name)
      expect(names).toEqual(['boot-base', 'knowledge', 'boot-core', 'self-restart', 'idle-sweep', 'social', 'mailbox-poller', 'a2a-server', 'pairing', 'yi', 'bootstrap'])
      // 测试环境什么都没配:可选的几样都是 off,不是 degraded(没配 ≠ 坏了)
      expect(sup.statuses().filter(s => s.state === 'degraded')).toEqual([])
    } finally {
      await boot.sessionManager.shutdown()
      boot.knowledge?.store.close()
      await boot.a2aServer?.stop()
    }
  }, 20_000)
})
