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
 *    **开动每个模块之前再查一遍上游**(9d 评审 #542):上游在 start 段才坏(onStart 抛错 ⇒ degraded、已经停掉)时,
 *    已经 init 过的下游手里拿着的是一个停了的上游。needs 的上游、以及 init 时经 maybe **真拿到了**的 wants 上游,
 *    只要不再是 ok ⇒ 下游跟着上游的状态,并停掉它 init 时登记的 own;没拿到的 wants 不算,它本来就没在用。
 *  - interval 叠跑:上一次还没跑完(async 没结束)⇒ 这一拍跳过,不叠(慢的时候不会越积越多)。
 *  - stop:模块逆序、模块内逆登记序;单项 5 秒超时,失败只记一行不挡后面(LifecycleSet 的语义)。可重复调。
 *    **开机途中也能停**(第 2 步,SIGTERM 落在开机途中):`createModules` 先拿到句柄、把 stopAll 交给收尾清单,
 *    再 `start()`。start 途中调 stopAll ⇒ 下一个模块边界就不再往下 init / start,等手上那一步落定(最多一个
 *    停止超时),再停掉已经起了的。
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
  /** 真环的那一条边(只有这里写了的名字才能经 ctx.lazy 拿):不进拓扑排序,环写在表里看得见。 */
  lazy?: readonly string[]
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
  /** 唯一的晚绑定,只给真的环用,只能拿 lazy 里写了的。返回的函数在 start 段之前调 ⇒ 抛;那个模块不是 ok ⇒ 抛。 */
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
  | { kind: 'interval'; name: string; ms: number; fn: () => unknown; handle?: unknown; busy?: boolean }
  | { kind: 'onStart'; name: string; fn: () => unknown }
  | { kind: 'own'; name: string; stop: () => unknown }

interface Slot { mod: DaemonModule; status: SubsystemStatus; value?: unknown; regs: Reg[]; started: Reg[]; /** init 时经 maybe 真拿到了的 wants(之后上游坏了,它也跟着)。 */ took: Set<string> }

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** needs ∪ wants 的拓扑序。有环 / 指向不存在的模块 / 重名 ⇒ 抛。同一层按表里的顺序,结果稳定。 */
export function orderModules(mods: readonly DaemonModule[]): DaemonModule[] {
  const byName = new Map<string, DaemonModule>()
  for (const m of mods) {
    if (byName.has(m.name)) throw new Error(`modules: duplicate name '${m.name}'`)
    byName.set(m.name, m)
  }
  for (const m of mods) {
    for (const d of [...(m.needs ?? []), ...(m.wants ?? []), ...(m.lazy ?? [])]) {
      if (!byName.has(d)) throw new Error(`modules: '${m.name}' depends on unknown module '${d}'`)
      if (d === m.name) throw new Error(`modules: '${m.name}' depends on itself`)
    }
    const both = (m.lazy ?? []).find(d => (m.needs ?? []).includes(d) || (m.wants ?? []).includes(d))
    if (both) throw new Error(`modules: '${m.name}' lists '${both}' in lazy and in needs / wants — a lazy edge is a cycle edge, pick one`)
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

export interface ModuleGroup extends StartedModules {
  /** init 段 + start 段。只能调一次。途中被 stopAll ⇒ 停在下一个模块边界,正常返回(不抛)。 */
  start(): Promise<void>
}

type ModuleOpts = { log: (tag: string, line: string) => void; timers?: ModuleTimers; now?: () => number; stopTimeoutMs?: number }

/** 建好、起完再返回(没有开机途中要停的场景时用,比如测试)。 */
export async function startModules(mods: readonly DaemonModule[], opts: ModuleOpts): Promise<StartedModules> {
  const group = createModules(mods, opts)
  await group.start()
  return group
}

/** 先拿句柄(好把 stopAll 交给收尾清单),再 start()。 */
export function createModules(mods: readonly DaemonModule[], opts: ModuleOpts): ModuleGroup {
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
  /** 开机途中有人要停:init / start 循环在下一个模块边界退出。 */
  let stopRequested = false
  let starting: Promise<void> | null = null
  /** 读当前阶段(跨 await 时 TS 会按旧值收窄,这里要的是真值)。 */
  const stopped = (): boolean => phase === 'stopped'

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

  async function run(): Promise<void> {
    // —— init 段 ——
    for (const mod of ordered) {
      if (stopRequested) return
      const slot: Slot = { mod, status: { name: mod.name, state: 'ok', sinceIso: iso() }, regs: [], started: [], took: new Set() }
      slots.set(mod.name, slot)
      if (mod.enabled && !mod.enabled()) { slot.status = { name: mod.name, state: 'off', sinceIso: iso() }; continue }
      const blocker = (mod.needs ?? []).map(n => slots.get(n)!).find(s => s.status.state !== 'ok')
      if (blocker) {
        slot.status = { name: mod.name, state: blocker.status.state, ...(blocker.status.state === 'degraded' ? { error: `upstream ${blocker.mod.name} not running` } : {}), sinceIso: iso() }
        opts.log('MODULES', `${mod.name} ${blocker.status.state}: upstream ${blocker.mod.name} is ${blocker.status.state}`)
        continue
      }
      const needs = new Set(mod.needs ?? []), wants = new Set(mod.wants ?? []), lazies = new Set(mod.lazy ?? [])
      const ctx: ModuleCtx = {
        get: <T>(n: string): T => {
          if (!needs.has(n)) throw new Error(`modules: '${mod.name}' called ctx.get('${n}') but '${n}' is not in its needs`)
          return slots.get(n)!.value as T
        },
        maybe: <T>(n: string): T | null => {
          if (!wants.has(n)) throw new Error(`modules: '${mod.name}' called ctx.maybe('${n}') but '${n}' is not in its wants`)
          const s = slots.get(n)!
          if (s.status.state !== 'ok') return null
          slot.took.add(n)
          return s.value as T
        },
        lazy: <T>(n: string): (() => T) => {
          if (!lazies.has(n)) throw new Error(`modules: '${mod.name}' called ctx.lazy('${n}') but '${n}' is not in its lazy`)
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
      if (stopRequested) return
      const slot = slots.get(mod.name)!
      if (slot.status.state !== 'ok') continue
      // 上游在 start 段才坏了 ⇒ 我手里拿着的是一个停了的上游:跟着它,停掉我 init 时登记的(9d 评审 #542)
      const upstream = [...(mod.needs ?? []), ...slot.took].map(n => slots.get(n)!).find(s => s.status.state !== 'ok')
      if (upstream) {
        opts.log('MODULES', `${mod.name} not started: upstream ${upstream.mod.name} became ${upstream.status.state} during start`)
        await stopSlot(slot)
        slot.regs = []
        slot.status = { name: mod.name, state: upstream.status.state, ...(upstream.status.state === 'degraded' ? { error: `upstream ${upstream.mod.name} not running` } : {}), sinceIso: iso() }
        continue
      }
      try {
        for (const r of slot.regs) {
          if (r.kind === 'interval') {
            r.handle = timers.setInterval(() => {
              if (r.busy) return   // 上一次还没跑完 ⇒ 这一拍跳过,不叠
              r.busy = true
              const done = (): void => { r.busy = false }
              try {
                void Promise.resolve(r.fn())
                  .catch(err => opts.log('MODULES', `${mod.name}/${r.name} tick failed: ${errMsg(err)}`))
                  .finally(done)
              } catch (err) { done(); opts.log('MODULES', `${mod.name}/${r.name} tick failed: ${errMsg(err)}`) }
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
    if (!stopRequested) phase = 'running'
  }

  return {
    start: () => {
      if (starting) throw new Error('modules: start() called twice')
      starting = run()
      return starting
    },
    status: () => ordered.map(m => ({ ...(slots.get(m.name)?.status ?? { name: m.name, state: 'off' as const, sinceIso: iso() }) })),
    provided: <T>(name: string): T | undefined => {
      const s = slots.get(name)
      return s && s.status.state === 'ok' ? (s.value as T) : undefined
    },
    stopAll: async () => {
      if (phase === 'stopped') return
      stopRequested = true
      // 开机途中:等手上那一步落定(最多一个停止超时),它可能正在登记 own
      if (starting) {
        let t: ReturnType<typeof setTimeout> | undefined
        await Promise.race([starting.catch(() => {}), new Promise<void>(r => { t = setTimeout(r, stopTimeoutMs) })])
        if (t) clearTimeout(t)
      }
      if (stopped()) return   // start 自己失败时已经全停过
      phase = 'stopped'
      await stopAllSlots()
    },
  }
}
