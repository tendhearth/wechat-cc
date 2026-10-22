/**
 * DaemonModule 容器(第三批 3b,spec docs/superpowers/specs/2026-10-22-daemon-module-design.md)。
 *
 * 一个功能 = 一个模块:`init(ctx)` 只造和登记(interval / onStart / own),**不开始干活**;全部 init 成功以后
 * 容器统一开动(start 段);关机逆序。启停成对靠构造,不靠自觉:模块拿不到裸的 setInterval,登记了的容器负责停。
 *
 * 三段:
 *  - init:按 needs ∪ wants 拓扑序逐个 init。有环、needs / wants 写了不存在的模块 ⇒ 开机就抛(编程错误)。
 *    enabled() 为 false ⇒ off;needs 的上游不是 ok ⇒ 跟着上游(off / degraded),不 init,原因写上游。
 *    optional 的 init 抛错 ⇒ degraded,它已经登记的 own 立刻逆序停掉,interval / onStart 作废(从没开始)。
 *    非 optional 的抛错 ⇒ 已经 init 的模块的 own 全部逆序停掉,再把错抛出去(开机失败,跟今天核心链一样)。
 *  - start:按同样的顺序,开动每个 ok 模块的 interval、依次 await 它的 onStart。onStart 抛错同上:optional ⇒ degraded
 *    并停掉它自己已经开动的;非 optional ⇒ 停掉全部再抛。`lazy` 拿到的东西只在这之后被用到,两个真环
 *    (ilink ↔ speech 构造期、pipeline ↔ polling 运行期)靠它。
 *  - stop:模块逆序、模块内逆登记序;单项 5 秒超时,失败只记一行不挡后面(LifecycleSet 的语义)。可重复调。
 *
 * 状态形状沿用 SubsystemStatus(/v1/health.subsystems 读的就是它)。
 */
import type { SubsystemStatus } from '../subsystems'

export interface DaemonModule<P = unknown> {
  name: string
  /** 必须先起;上游不是 ok ⇒ 我也不起(跟着上游的状态)。 */
  needs?: readonly string[]
  /** 有就用,没有也能起;经 ctx.maybe 拿,拿到 null 自己兜。 */
  wants?: readonly string[]
  /** 起失败 ⇒ degraded,不拖垮开机。缺省 false:起失败 = 开机失败。 */
  optional?: boolean
  /** 缺省开。false ⇒ 不 init,状态 off(模块开关;已经有主人开关的东西别用它,见设计稿「一件事只有一个开关」)。 */
  enabled?: () => boolean
  /** 只造和登记,不开始干活。返回值 = 对外提供的东西(别的模块 needs 我时经 ctx.get 拿到)。 */
  init(ctx: ModuleCtx): P | Promise<P>
}

export interface ModuleCtx {
  /** 只能拿 needs 里写了的。 */
  get<T>(name: string): T
  /** 只能拿 wants 里写了的;那个模块不是 ok ⇒ null。 */
  maybe<T>(name: string): T | null
  /** 唯一的晚绑定,只给真的环用。返回的函数在 start 段之前调 ⇒ 抛;那个模块不是 ok ⇒ 抛。 */
  lazy<T>(name: string): () => T
  /** 登记一个定时器:start 段才开始计时,关机自动 clear。fn 抛错 / reject 只记一行。 */
  interval(name: string, ms: number, fn: () => unknown): void
  /** 登记「开动」:起服务、开始拉消息……start 段按登记顺序 await。要停的东西另用 own 登记。 */
  onStart(name: string, fn: () => unknown): void
  /** 登记一个要停的资源(连接、服务):init 里造好就登记,关机逆序停。 */
  own(name: string, stop: () => unknown): void
  log(line: string): void
}

export interface ModuleTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface StartedModules {
  status(): SubsystemStatus[]
  /** 拿某个 ok 模块提供的东西;不存在 / 不是 ok ⇒ undefined。给 main.ts 接线用,模块之间走 ctx。 */
  provided<T>(name: string): T | undefined
  stopAll(): Promise<void>
}

export const STOP_TIMEOUT_MS = 5_000

type Reg =
  | { kind: 'interval'; name: string; ms: number; fn: () => unknown; handle?: unknown }
  | { kind: 'onStart'; name: string; fn: () => unknown }
  | { kind: 'own'; name: string; stop: () => unknown }

interface Slot { mod: DaemonModule; status: SubsystemStatus; value?: unknown; regs: Reg[]; started: Reg[] }

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** needs ∪ wants 的拓扑序。有环 / 指向不存在的模块 / 重名 ⇒ 抛。同一层按表里的顺序,结果稳定。 */
export function orderModules(mods: readonly DaemonModule[]): DaemonModule[] {
  const byName = new Map<string, DaemonModule>()
  for (const m of mods) {
    if (byName.has(m.name)) throw new Error(`modules: duplicate name '${m.name}'`)
    byName.set(m.name, m)
  }
  for (const m of mods) {
    for (const d of [...(m.needs ?? []), ...(m.wants ?? [])]) {
      if (!byName.has(d)) throw new Error(`modules: '${m.name}' depends on unknown module '${d}'`)
      if (d === m.name) throw new Error(`modules: '${m.name}' depends on itself`)
    }
  }
  const out: DaemonModule[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (m: DaemonModule, path: string[]): void => {
    const s = state.get(m.name)
    if (s === 'done') return
    if (s === 'visiting') throw new Error(`modules: dependency cycle ${[...path, m.name].join(' → ')} (a real cycle goes through ctx.lazy, not needs / wants)`)
    state.set(m.name, 'visiting')
    for (const d of [...(m.needs ?? []), ...(m.wants ?? [])]) visit(byName.get(d)!, [...path, m.name])
    state.set(m.name, 'done')
    out.push(m)
  }
  for (const m of mods) visit(m, [])
  return out
}

export async function startModules(
  mods: readonly DaemonModule[],
  opts: { log: (tag: string, line: string) => void; timers?: ModuleTimers; now?: () => number; stopTimeoutMs?: number },
): Promise<StartedModules> {
  const timers: ModuleTimers = opts.timers ?? {
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); (h as { unref?: () => void }).unref?.(); return h },
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }
  const now = opts.now ?? Date.now
  const stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS
  const iso = (): string => new Date(now()).toISOString()
  const ordered = orderModules(mods)
  const slots = new Map<string, Slot>()
  let phase: 'init' | 'start' | 'running' | 'stopped' = 'init'

  const stopOne = async (slot: Slot, r: Reg): Promise<void> => {
    if (r.kind === 'onStart') return
    if (r.kind === 'interval') { if (r.handle !== undefined) { timers.clearInterval(r.handle); r.handle = undefined }; return }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => r.stop()),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stop timeout (${stopTimeoutMs}ms)`)), stopTimeoutMs) }),
      ])
      opts.log('MODULES', `stopped ${slot.mod.name}/${r.name}`)
    } catch (err) {
      opts.log('MODULES', `stop ${slot.mod.name}/${r.name} failed: ${errMsg(err)}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  /** 停一个模块:已经开动的 interval + 全部 own,逆登记序。 */
  const stopSlot = async (slot: Slot): Promise<void> => {
    const live = slot.regs.filter(r => r.kind === 'own' || (r.kind === 'interval' && r.handle !== undefined))
    for (const r of live.reverse()) await stopOne(slot, r)
  }
  const stopAllSlots = async (): Promise<void> => {
    for (const m of [...ordered].reverse()) { const s = slots.get(m.name); if (s) await stopSlot(s) }
  }
  const degrade = async (slot: Slot, err: unknown, stage: string): Promise<void> => {
    slot.status = { name: slot.mod.name, state: 'degraded', error: errMsg(err), sinceIso: iso() }
    opts.log('MODULES', `${slot.mod.name} degraded at ${stage}: ${errMsg(err)}`)
    await stopSlot(slot)
    slot.regs = []
  }

  // —— init 段 ——
  for (const mod of ordered) {
    const slot: Slot = { mod, status: { name: mod.name, state: 'ok', sinceIso: iso() }, regs: [], started: [] }
    slots.set(mod.name, slot)
    if (mod.enabled && !mod.enabled()) { slot.status = { name: mod.name, state: 'off', sinceIso: iso() }; continue }
    const blocker = (mod.needs ?? []).map(n => slots.get(n)!).find(s => s.status.state !== 'ok')
    if (blocker) {
      slot.status = { name: mod.name, state: blocker.status.state, ...(blocker.status.state === 'degraded' ? { error: `upstream ${blocker.mod.name} not running` } : {}), sinceIso: iso() }
      opts.log('MODULES', `${mod.name} ${blocker.status.state}: upstream ${blocker.mod.name} is ${blocker.status.state}`)
      continue
    }
    const needs = new Set(mod.needs ?? []), wants = new Set(mod.wants ?? [])
    const ctx: ModuleCtx = {
      get: <T>(n: string): T => {
        if (!needs.has(n)) throw new Error(`modules: '${mod.name}' called ctx.get('${n}') but '${n}' is not in its needs`)
        return slots.get(n)!.value as T
      },
      maybe: <T>(n: string): T | null => {
        if (!wants.has(n)) throw new Error(`modules: '${mod.name}' called ctx.maybe('${n}') but '${n}' is not in its wants`)
        const s = slots.get(n)!
        return s.status.state === 'ok' ? (s.value as T) : null
      },
      lazy: <T>(n: string): (() => T) => {
        if (!mods.some(m => m.name === n)) throw new Error(`modules: '${mod.name}' called ctx.lazy('${n}') for an unknown module`)
        return () => {
          if (phase === 'init') throw new Error(`modules: lazy('${n}') used by '${mod.name}' before start — only start-phase code may touch a lazy dependency`)
          const s = slots.get(n)
          if (!s || s.status.state !== 'ok') throw new Error(`modules: lazy('${n}') used by '${mod.name}' but '${n}' is ${s?.status.state ?? 'missing'}`)
          return s.value as T
        }
      },
      interval: (name, ms, fn) => { slot.regs.push({ kind: 'interval', name, ms, fn }) },
      onStart: (name, fn) => { slot.regs.push({ kind: 'onStart', name, fn }) },
      own: (name, stop) => { slot.regs.push({ kind: 'own', name, stop }) },
      log: (line) => opts.log('MODULES', `${mod.name}: ${line}`),
    }
    try {
      slot.value = await mod.init(ctx)
    } catch (err) {
      if (mod.optional) { await degrade(slot, err, 'init'); continue }
      opts.log('MODULES', `${mod.name} failed at init (required): ${errMsg(err)}`)
      await stopAllSlots()
      phase = 'stopped'
      throw err
    }
  }

  // —— start 段 ——
  phase = 'start'
  for (const mod of ordered) {
    const slot = slots.get(mod.name)!
    if (slot.status.state !== 'ok') continue
    try {
      for (const r of slot.regs) {
        if (r.kind === 'interval') {
          r.handle = timers.setInterval(() => {
            try { void Promise.resolve(r.fn()).catch(err => opts.log('MODULES', `${mod.name}/${r.name} tick failed: ${errMsg(err)}`)) }
            catch (err) { opts.log('MODULES', `${mod.name}/${r.name} tick failed: ${errMsg(err)}`) }
          }, r.ms)
        } else if (r.kind === 'onStart') {
          await r.fn()
        }
      }
    } catch (err) {
      if (mod.optional) { await degrade(slot, err, 'start'); continue }
      opts.log('MODULES', `${mod.name} failed at start (required): ${errMsg(err)}`)
      await stopAllSlots()
      phase = 'stopped'
      throw err
    }
  }
  phase = 'running'

  return {
    status: () => ordered.map(m => ({ ...slots.get(m.name)!.status })),
    provided: <T>(name: string): T | undefined => {
      const s = slots.get(name)
      return s && s.status.state === 'ok' ? (s.value as T) : undefined
    },
    stopAll: async () => {
      if (phase === 'stopped') return
      phase = 'stopped'
      await stopAllSlots()
    },
  }
}
