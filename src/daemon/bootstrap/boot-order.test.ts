/**
 * boot 顺序钉子(spec 2026-09-27-bootstrap-split,Review Focus #1)。
 * 九块搬进 wire-*.ts 之后,index 里的调用点必须留在原位;可失败的块经 sup.start 拉起,
 * 它们的名字序列就是 boot 顺序的可观测形状。多一块、少一块、换位都在这里红。
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
  it('sup.start 的名字序列 == knowledge → self-restart → social → a2a-server → pairing → yi', async () => {
    const sup = new SubsystemSupervisor(() => {})
    const names: string[] = []
    const realStart = sup.start.bind(sup)
    sup.start = ((name: string, fn: any) => { names.push(name); return realStart(name, fn) }) as typeof sup.start
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
      expect(names).toEqual(['knowledge', 'self-restart', 'social', 'a2a-server', 'pairing', 'yi'])
      // 每个名字只 start 一次(同名二次 start 直接 throw,这里顺带钉住不重复)。
      expect(new Set(names).size).toBe(names.length)
    } finally {
      await boot.sessionManager.shutdown()
      boot.knowledge?.store.close()
      await boot.a2aServer?.stop()
    }
  }, 20_000)
})
