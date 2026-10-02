/**
 * 网络守护的 daemon 侧接线(2026-10-02):一个 Ref 装调度器(guard 生命周期起来后
 * 才有)、一个网络闸门、一个 /v1/health 快照、一个给后台任务用的「不安全就跳过」包装。
 *
 * main.ts 在最前面建它(早于 internal-api / bootstrap),因为 provider registry、
 * SessionManager、协调器都在 bootstrap 里建,而 guard 生命周期在很后面才 start。
 * 闸门在调度器还没起来时会自己当场读一次 bx(见 gate.ts),所以这段空窗不会放行。
 */
import { Ref } from '../../lib/lifecycle'
import type { NetworkGate, NetworkGateVerdict } from '../../lib/network-gate'
import { findBx, readBxStatus } from './bx'
import { createNetworkGate } from './gate'
import type { GuardLifecycle } from './lifecycle'
import { loadGuardConfig } from './store'
import type { GuardHealth } from '../internal-api/types'

export interface GuardRuntime {
  ref: Ref<GuardLifecycle>
  gate: NetworkGate
  health(): GuardHealth
  /**
   * 后台 / 定时任务包装:不安全就不跑,只记一行日志(同一段不安全期内同一个任务只记一次),
   * 下一拍再看。不抛、不重试。
   */
  skipWhenUnsafe(name: string, fn: () => Promise<void>): () => Promise<void>
}

export interface GuardRuntimeDeps {
  stateDir: string
  log: (tag: string, line: string) => void
  /** 测试注入;缺省读 guard.json / 找真的 bx。 */
  isEnabled?: () => boolean
  findBx?: () => string | null
  readBx?: typeof readBxStatus
}

export function makeGuardRuntime(deps: GuardRuntimeDeps): GuardRuntime {
  const ref = new Ref<GuardLifecycle>('guard')
  const isEnabled = deps.isEnabled ?? (() => loadGuardConfig(deps.stateDir).enabled)
  const find = deps.findBx ?? (() => findBx())
  const read = deps.readBx ?? ((bin: string) => readBxStatus(bin))
  const gate = createNetworkGate({
    isEnabled,
    current: () => ref.current?.current() ?? null,
    pokeNow: () => ref.current?.pokeNow() ?? null,
    findBx: find,
    readBx: (bin) => read(bin),
    log: deps.log,
  })
  const skipLogged = new Set<string>()

  function health(): GuardHealth {
    let enabled = true
    try { enabled = isEnabled() } catch { /* 读不出配置按开着算 */ }
    const s = ref.current?.current() ?? null
    const last: NetworkGateVerdict | null = gate.lastVerdict()
    if (!enabled) return { enabled: false, source: 'off', safe: true, detail: '网络守护未开启', ip: s?.ip ?? null, checked_at: s?.lastChecked ?? null }
    if (s && s.lastChecked) return { enabled: true, source: s.source, safe: s.safe, detail: s.detail, ip: s.ip, checked_at: s.lastChecked }
    if (last && last.source !== 'off') return { enabled: true, source: last.source, safe: last.safe, detail: last.detail, ip: null, checked_at: null }
    return { enabled: true, source: 'probe', safe: true, detail: '尚未探测', ip: null, checked_at: null }
  }

  function skipWhenUnsafe(name: string, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      const v = await gate.check()
      if (!v.safe) {
        if (!skipLogged.has(name)) {
          skipLogged.add(name)
          deps.log('GUARD', `${name}: skipped — network unprotected [${v.source}] ${v.detail}(恢复后下一拍自动继续)`)
        }
        return
      }
      if (skipLogged.delete(name)) deps.log('GUARD', `${name}: network protected again — resuming`)
      await fn()
    }
  }

  return { ref, gate: { check: () => gate.check() }, health, skipWhenUnsafe }
}
