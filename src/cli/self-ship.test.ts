import { describe, expect, it } from 'vitest'

import type { SelfDeployResult } from './self-deploy'
import type { SelftestReport } from './selftest'
import { SHIP_EXIT, runShip, waitForQuietMachine, type ShipDeps } from './self-ship'

const okDeploy = (over: Partial<SelfDeployResult> = {}): SelfDeployResult => ({ ok: true, exitCode: 0, steps: [], version: 'v-new', ...over })
const report = (kind: 'workbench' | 'chat', ok: boolean): SelftestReport => ({
  ok, kind, target: kind === 'workbench' ? 'claude' : 'claude', durationMs: 1,
  checks: [{ name: ok ? '回话' : '续接', ok }],
})

function harness(over: Partial<ShipDeps> & { loads?: number[]; selftestOk?: [boolean, boolean] } = {}) {
  const calls: string[] = []
  let t = 0
  let li = 0
  const loads = over.loads ?? [2]
  const deps: ShipDeps = {
    tree: () => ({ dirty: '', head: 'a'.repeat(40), devHead: 'a'.repeat(40) }),
    load: () => ({ load1: loads[Math.min(li++, loads.length - 1)]!, cpus: 18 }),
    guard: async () => ({ enabled: true, safe: true, detail: 'bx 保护中' }),
    build: async () => { calls.push('build'); return { ok: true, detail: '' } },
    deploy: async mode => { calls.push(mode); return okDeploy() },
    selftest: async () => {
      calls.push('selftest')
      const [w, c] = over.selftestOk ?? [true, true]
      return { workbench: report('workbench', w), chat: report('chat', c) }
    },
    sleep: async ms => { t += ms },
    now: () => t,
    log: () => {},
    ...over,
  }
  return { deps, calls }
}

describe('runShip', () => {
  it('闲着、守护安全 ⇒ 构建 → 部署 → 自检,退 0,并指向 self soak', async () => {
    const { deps, calls } = harness()
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.shipped)
    expect(calls).toEqual(['build', 'deploy', 'selftest'])
    expect(r.message).toContain('self soak')
    expect(r.version).toBe('v-new')
  })

  it('工作区脏 ⇒ 退 6,什么都没动(--allow-off-dev 也不放)', async () => {
    const { deps, calls } = harness({ tree: () => ({ dirty: ' M src/a.ts\n', head: 'a'.repeat(40), devHead: 'a'.repeat(40) }) })
    const r = await runShip(deps, { allowOffDev: true })
    expect(r.exitCode).toBe(SHIP_EXIT.tree_unfit)
    expect(r.message).toContain('src/a.ts')
    expect(calls).toEqual([])
  })

  it('HEAD 不是 origin/dev(或取不到)⇒ 退 6;--allow-off-dev 照装', async () => {
    for (const devHead of ['b'.repeat(40), null]) {
      const { deps, calls } = harness({ tree: () => ({ dirty: '', head: 'a'.repeat(40), devHead }) })
      const r = await runShip(deps)
      expect(r.exitCode).toBe(SHIP_EXIT.tree_unfit)
      expect(r.message).toContain('HEAD aaaaaaaa')
      expect(calls).toEqual([])
    }
    const off = harness({ tree: () => ({ dirty: '', head: 'a'.repeat(40), devHead: 'b'.repeat(40) }) })
    expect((await runShip(off.deps, { allowOffDev: true })).exitCode).toBe(SHIP_EXIT.shipped)
  })

  it('机器忙 ⇒ 退 3,什么都没动', async () => {
    const { deps, calls } = harness({ loads: [40] })
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.busy)
    expect(r.message).toContain('40.0 / 18 核')
    expect(calls).toEqual([])
  })

  it('忙,但 --wait-min 之内闲下来 ⇒ 照常部署', async () => {
    const { deps, calls } = harness({ loads: [40, 40, 3] })
    expect((await runShip(deps, { waitMin: 10 })).exitCode).toBe(SHIP_EXIT.shipped)
    expect(calls).toEqual(['build', 'deploy', 'selftest'])
  })

  it('守护读不到 / 开着但不安全 ⇒ 退 5,不构建不部署;关着(没开守护)⇒ 照常', async () => {
    for (const g of [null, { enabled: true, safe: false, detail: 'bx 断了' }]) {
      const { deps, calls } = harness({ guard: async () => g })
      expect((await runShip(deps)).exitCode).toBe(SHIP_EXIT.unguarded)
      expect(calls).toEqual([])
    }
    const off = harness({ guard: async () => ({ enabled: false, safe: false, detail: '' }) })
    expect((await runShip(off.deps)).exitCode).toBe(SHIP_EXIT.shipped)
  })

  it('构建红 ⇒ 退 4,不部署', async () => {
    const { deps, calls } = harness({ build: async () => ({ ok: false, detail: 'bun build 爆了' }) })
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.build_failed)
    expect(r.message).toContain('bun build 爆了')
    expect(calls).toEqual([])
  })

  it('--skip-build ⇒ 不构建', async () => {
    const { deps, calls } = harness()
    await runShip(deps, { skipBuild: true })
    expect(calls).toEqual(['deploy', 'selftest'])
  })

  it('self deploy 红(它自己回滚)⇒ 退 1,不跑自检', async () => {
    const { deps, calls } = harness()
    deps.deploy = async mode => { calls.push(mode); return okDeploy({ ok: false, exitCode: 1, rolledBack: true, steps: [{ name: 'health', ok: false, detail: '60s 没起来' }] }) }
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.deploy_failed)
    expect(r.message).toContain('已自动回滚')
    expect(r.message).toContain('60s 没起来')
    expect(calls).toEqual(['build', 'deploy'])
  })

  it('自检红 ⇒ 回滚,退 2,说是哪条红', async () => {
    const { deps, calls } = harness({ selftestOk: [true, false] })
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.selftest_red)
    expect(calls).toEqual(['build', 'deploy', 'selftest', 'rollback'])
    expect(r.message).toContain('chat(claude):续接')
    expect(r.message).toContain('已回滚')
  })

  it('自检红、回滚也没成 ⇒ 照实说机器上还是新版', async () => {
    const { deps } = harness({ selftestOk: [false, true] })
    deps.deploy = async mode => (mode === 'rollback' ? okDeploy({ ok: false, exitCode: 1, diagnostics: '.prev 不在' }) : okDeploy())
    const r = await runShip(deps)
    expect(r.exitCode).toBe(SHIP_EXIT.selftest_red)
    expect(r.message).toContain('回滚也没成')
    expect(r.message).toContain('.prev 不在')
  })
})

describe('waitForQuietMachine', () => {
  it('负载按核数折算:18 核上 18 不算忙,18.1 算', async () => {
    const at = (load1: number) => waitForQuietMachine({ load: () => ({ load1, cpus: 18 }), sleep: async () => {}, now: () => 0, log: () => {} }, { waitMin: 0, maxLoadPerCpu: 1 })
    expect(await at(18)).toBeNull()
    expect(await at(18.1)).toContain('机器正忙')
  })

  it('等的时候每分钟看一次,到点还忙就放弃', async () => {
    let t = 0
    const sleeps: number[] = []
    const why = await waitForQuietMachine(
      { load: () => ({ load1: 50, cpus: 10 }), sleep: async ms => { sleeps.push(ms); t += ms }, now: () => t, log: () => {} },
      { waitMin: 3, maxLoadPerCpu: 1 },
    )
    expect(why).toContain('等机器闲了再来')
    expect(sleeps).toEqual([60_000, 60_000, 60_000])
  })
})
