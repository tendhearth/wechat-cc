/**
 * cli-upgrade 引擎 —— 发现 → 空闲时用官方升级器升 → 立刻自检 → 不过就退回 + 记坏版本 + 告诉主人一次。
 *
 * 全部副作用都是注入的(跑命令、查最新、空闲判定、busy 登记、自检、通知、状态存储),
 * 所以单测用临时目录里的假 CLI 就能把每条路走一遍,永远不碰主人真装的 CLI。
 *
 * 规矩(docs/maintainer/cli-auto-upgrade.md):
 *  - 同一时刻只做一件事(升级 / 退回 / 补做自检),第二件直接回 busy,不排队;
 *  - 只在空闲时动手(isIdle:没有在途回合、没有这家的活会话、busy 登记处没人),**永不打断**;
 *    动手期间持 busy token,空闲自动重启不会切进来;
 *  - 查最新失败按指数退避(1h → 2h → … ≤24h),断网时不一分钟打一次;
 *  - 自检被网络守护挡下 ≠ 自检失败:标「未验证」,稍后再试,**不退回**;
 *  - 同一件事只通知一次(notified 键)。
 */
import { CLI_IDS, CLI_SPECS, cliIdForProvider, type CliId, type CliSpec } from './specs'
import { installedVersion, type CommandRunner, type LatestResult } from './detect'
import { isNewer } from './version'
import { detectLayout, manualRollbackSteps, planRollback, previousOnDisk, repointSymlink, type Layout, type RollbackPlan } from './layout'
import { outdatedClientSignal } from './outdated-signal'
import type { ResolvedCliUpgradeConfig } from './config'
import type { CliState, CliUpgradeState, StateStore, UpgradeSource, UpgradeResult, VerifyState } from './state'

export interface IdleVerdict { idle: boolean; reason?: string }
export interface VerifyResult {
  /** pass / fail:自检真跑了;deferred:被网络守护挡下或暂时跑不了(稍后重试,不退回);
   *  skipped:这家没法自检(provider 没注册等),不重试、不退回。 */
  status: 'pass' | 'fail' | 'deferred' | 'skipped'
  detail: string
}

export interface CliUpgraderDeps {
  specs?: Readonly<Record<CliId, CliSpec>>
  config: () => ResolvedCliUpgradeConfig
  locate: (id: CliId) => string | null
  run: CommandRunner
  latest: (spec: CliSpec) => Promise<LatestResult>
  isIdle: (spec: CliSpec) => IdleVerdict
  holdBusy: (label: string) => () => void
  verify: (spec: CliSpec) => Promise<VerifyResult>
  notify: (text: string) => Promise<void> | void
  state: StateStore
  log: (tag: string, line: string) => void
  now?: () => number
  /** 本地日历日 / 小时(定时检查用);缺省按本机时区。 */
  localDay?: (ms: number) => string
  localHour?: (ms: number) => number
  /** 退回的文件系统动作(缺省是 layout.ts 的真实现;测试也用真实现,只是在临时目录里)。 */
  layout?: {
    detect: (spec: CliSpec, bin: string) => Layout
    plan: (spec: CliSpec, layout: Layout, version: string) => RollbackPlan
    previous: (spec: CliSpec, layout: Layout, current: string) => string | null
    repoint: (link: string, target: string) => void
  }
  updateTimeoutMs?: number
}

export interface OpOutcome {
  ok: boolean
  result: UpgradeResult | 'not_installed' | 'not_idle' | 'busy' | 'up_to_date' | 'known_bad' | 'bundled' | 'no_previous' | 'backoff' | 'verified' | 'nothing_to_verify'
  from?: string | null
  to?: string | null
  detail?: string
}

export interface CliStatusView {
  id: CliId
  label: string
  auto: boolean
  installed: string | null
  latest: string | null
  update_available: boolean
  accepted: string | null
  verify: VerifyState
  verify_detail: string | null
  last_check_at: string | null
  last_check_error: string | null
  next_check_at: string | null
  pending: UpgradeSource | null
  last_upgrade: CliState['lastUpgrade']
  known_bad: string[]
}

export interface CliUpgradeStatus {
  enabled: boolean
  check_hour: number
  /** 正在升级 / 退回 / 补自检的那一个。 */
  active: CliId | null
  clis: CliStatusView[]
}

const HOUR = 3_600_000
const REACTIVE_DEBOUNCE_MS = 30 * 60_000
const VERIFY_RETRY_MS = 30 * 60_000
const DEFAULT_UPDATE_TIMEOUT_MS = 10 * 60_000

export function backoffMs(failures: number): number {
  return Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, failures - 1))
}

function defaultLocalDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface CliUpgrader {
  /** daemon 每分钟调一次。自己吞掉一切异常。 */
  tick(): Promise<void>
  /** 只探测(装的 / 最新的),更新状态;发现新版本就记 pending,等 tick 在空闲时升。 */
  check(id: CliId, source: UpgradeSource): Promise<CliStatusView>
  upgrade(id: CliId, opts?: { source?: UpgradeSource; force?: boolean }): Promise<OpOutcome>
  rollback(id: CliId): Promise<OpOutcome>
  /** 回合失败的错误通道 → 像「CLI 太旧」就排一次检查(去抖)。 */
  onTurnError(providerId: string, code: string | null | undefined, message: string | null | undefined): boolean
  status(): CliUpgradeStatus
  active(): CliId | null
}

export function makeCliUpgrader(deps: CliUpgraderDeps): CliUpgrader {
  const specs = deps.specs ?? CLI_SPECS
  const now = deps.now ?? Date.now
  const localDay = deps.localDay ?? defaultLocalDay
  const localHour = deps.localHour ?? ((ms: number) => new Date(ms).getHours())
  const L = deps.layout ?? { detect: detectLayout, plan: planRollback, previous: previousOnDisk, repoint: repointSymlink }
  const iso = (ms: number) => new Date(ms).toISOString()
  const lastReactive = new Map<CliId, number>()
  let active: CliId | null = null
  let ticking = false

  const log = (line: string) => { try { deps.log('CLI_UPGRADE', line) } catch { /* ignore */ } }

  function mutate(id: CliId, fn: (s: CliState) => void): CliState {
    const all = deps.state.load()
    fn(all[id])
    deps.state.save(all)
    return all[id]
  }
  const read = (id: CliId): CliState => deps.state.load()[id]

  async function notifyOnce(id: CliId, key: string, text: string): Promise<void> {
    const s = read(id)
    if (s.notified.includes(key)) return
    mutate(id, (x) => { x.notified = [...x.notified, key].slice(-50) })
    try { await deps.notify(text) } catch (err) { log(`${id}: notify failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  async function exclusive(id: CliId, fn: () => Promise<OpOutcome>): Promise<OpOutcome> {
    if (active) return { ok: false, result: 'busy', detail: `正在处理 ${active}` }
    active = id
    try { return await fn() } finally { active = null }
  }

  async function check(id: CliId, source: UpgradeSource): Promise<CliStatusView> {
    const spec = specs[id]
    const bin = deps.locate(id)
    const t = now()
    const installed = bin ? await installedVersion(spec, bin, deps.run) : null
    const s0 = read(id)
    let latest: LatestResult | null = null
    const inBackoff = s0.nextCheckAt !== null && Date.parse(s0.nextCheckAt) > t
    if (bin && !inBackoff && spec.latest.kind !== 'none') latest = await deps.latest(spec)
    mutate(id, (s) => {
      s.installed = installed
      if (!bin) { s.pending = null; return }
      // 第一次见到:就当它是好的(我们没理由怀疑主人已经在用的版本)。
      if (s.accepted === null && installed) s.accepted = installed
      // CLI 自己的后台升级器换了版本(claude / codex / agy 都有):欠一次自检。
      // 自动退回已经失败过、主人还没处理的那个坏版本:不再每次都重新排(通知已经发过一次)。
      const stuckOnBad = s.verify === 'failed' && s.lastUpgrade?.result === 'rollback_failed' && s.lastUpgrade.to === installed
      if (installed && s.accepted && installed !== s.accepted && s.verify !== 'unverified' && !stuckOnBad) {
        s.verify = 'unverified'
        s.rollbackTo = s.accepted
        s.verifyAttemptAt = null
        s.lastUpgrade = { from: s.accepted, to: installed, at: iso(t), source: 'external', result: 'unverified', detail: 'CLI 自己换了版本' }
        log(`${id}: 版本在外面变了 ${s.accepted} → ${installed},排一次自检`)
      }
      if (latest) {
        s.lastCheckAt = iso(t)
        if (latest.version) {
          s.latest = latest.version
          s.latestSource = latest.source
          s.lastCheckError = null
          s.checkFailures = 0
          s.nextCheckAt = null
        } else {
          s.lastCheckError = latest.error ?? 'unknown'
          s.checkFailures += 1
          s.nextCheckAt = iso(t + backoffMs(s.checkFailures))
          log(`${id}: 查最新失败(${s.lastCheckError}),${Math.round(backoffMs(s.checkFailures) / 60_000)} 分钟后再试`)
        }
      } else if (spec.latest.kind === 'none') {
        s.lastCheckAt = iso(t)
      }
      if (!installed) return
      if (spec.latest.kind === 'none') {
        // 没有只读来源:定时 / 报错触发时交给官方升级器自己判(它没新版就什么都不做)。
        if ((source === 'scheduled' || source === 'reactive') && !inBackoff) s.pending = s.pending ?? source
      } else if (s.latest && isNewer(spec, s.latest, installed) && !s.knownBad.includes(s.latest)) {
        s.pending = s.pending ?? source
      }
    })
    return viewOf(id)
  }

  async function applyRollback(spec: CliSpec, bin: string, layout: Layout, target: string): Promise<{ ok: boolean; detail: string }> {
    const plan = L.plan(spec, layout, target)
    if (plan.kind === 'impossible') return { ok: false, detail: plan.reason }
    try {
      if (plan.kind === 'repoint') {
        for (const { link, target: to } of plan.links) L.repoint(link, to)
        return { ok: true, detail: `改指回 ${target}` }
      }
      const r = await deps.run(bin, plan.args, { timeoutMs: deps.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS })
      return r.code === 0 ? { ok: true, detail: `${spec.bin} ${plan.args.join(' ')}` } : { ok: false, detail: `${spec.bin} ${plan.args.join(' ')} 退出码 ${r.code}${r.stderr ? `:${r.stderr.trim().slice(-200)}` : ''}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 版本已经从 from 变成 to:自检;不过就退回 from。调用方已持 exclusive + busy。 */
  async function verifyAfterChange(spec: CliSpec, bin: string, from: string | null, toVersion: string | null, source: UpgradeSource, brokenDetail?: string): Promise<OpOutcome> {
    const id = spec.id
    const t = now()
    const to = toVersion ?? '(打不出版本)'
    const bad = toVersion !== null && read(id).knownBad.includes(toVersion)
    const vr: VerifyResult = brokenDetail ? { status: 'fail', detail: brokenDetail }
      : bad ? { status: 'fail', detail: `${to} 之前已经验出过问题` } : await safeVerify(spec)
    if (vr.status === 'pass') {
      mutate(id, (s) => {
        s.verify = 'ok'; s.verifyDetail = vr.detail; s.accepted = to; s.rollbackTo = null; s.verifyAttemptAt = null
        s.lastUpgrade = { from, to, at: iso(t), source, result: 'upgraded', detail: vr.detail }
      })
      log(`${id}: ${from ?? '?'} → ${to},自检通过`)
      if (source !== 'external') await notifyOnce(id, `ok:${to}`, `${spec.label} 已自动升级到 ${to}，自检通过`)
      return { ok: true, result: 'upgraded', from, to, detail: vr.detail }
    }
    if (vr.status === 'deferred' || vr.status === 'skipped') {
      mutate(id, (s) => {
        s.verify = 'unverified'; s.verifyDetail = vr.detail; s.verifyAttemptAt = iso(t)
        // skipped:跑不了也不会再跑 ⇒ 不欠自检、接受这个版本;deferred:欠着,稍后重试。
        if (vr.status === 'skipped') { s.accepted = to; s.rollbackTo = null } else s.rollbackTo = from
        s.lastUpgrade = { from, to, at: iso(t), source, result: 'unverified', detail: vr.detail }
      })
      log(`${id}: ${from ?? '?'} → ${to},自检${vr.status === 'deferred' ? '暂缓' : '跳过'}:${vr.detail}`)
      return { ok: true, result: 'unverified', from, to, detail: vr.detail }
    }
    // fail ⇒ 退回
    const layout = L.detect(spec, bin)
    const target = from ?? (toVersion ? L.previous(spec, layout, toVersion) : null)
    if (toVersion) mutate(id, (s) => { if (!s.knownBad.includes(toVersion)) s.knownBad = [...s.knownBad, toVersion].slice(-20) })
    if (!target) {
      mutate(id, (s) => {
        s.verify = 'failed'; s.verifyDetail = vr.detail; s.rollbackTo = null
        s.lastUpgrade = { from, to, at: iso(t), source, result: 'rollback_failed', detail: `${vr.detail};不知道该退回哪个版本` }
      })
      await notifyOnce(id, `bad:${to}`, `⚠️ ${spec.label} 换到 ${to} 后自检没通过（${vr.detail}），找不到可以退回的旧版本。手动处理：${manualRollbackSteps(spec, null)}`)
      return { ok: false, result: 'rollback_failed', from, to, detail: vr.detail }
    }
    const rb = await applyRollback(spec, bin, layout, target)
    const after = rb.ok ? await installedVersion(spec, bin, deps.run) : toVersion
    if (!rb.ok || after !== target) {
      const why = rb.ok ? `退回后版本是 ${after ?? '打不出来'}` : rb.detail
      mutate(id, (s) => {
        s.installed = after; s.verify = 'failed'; s.verifyDetail = vr.detail; s.rollbackTo = null
        s.lastUpgrade = { from, to, at: iso(t), source, result: 'rollback_failed', detail: `${vr.detail};${why}` }
      })
      log(`${id}: ${to} 自检失败,自动退回 ${target} 没做成:${why}`)
      await notifyOnce(id, `bad:${to}`, `⚠️ ${spec.label} 换到 ${to} 后自检没通过（${vr.detail}），自动退回做不到（${why}）。手动退回：${manualRollbackSteps(spec, target)}`)
      return { ok: false, result: 'rollback_failed', from, to, detail: why }
    }
    const vr2 = await safeVerify(spec)
    mutate(id, (s) => {
      s.installed = target; s.accepted = target; s.rollbackTo = null; s.verifyAttemptAt = null
      s.verify = vr2.status === 'pass' ? 'ok' : vr2.status === 'fail' ? 'failed' : 'unverified'
      s.verifyDetail = vr2.detail
      s.pending = null
      s.lastUpgrade = { from, to, at: iso(t), source, result: 'rolled_back', detail: `${vr.detail};已退回 ${target}` }
    })
    log(`${id}: ${to} 自检失败(${vr.detail}),已退回 ${target};退回后自检 ${vr2.status}`)
    const tail = vr2.status === 'pass' ? '，退回后自检通过' : vr2.status === 'fail' ? `，但退回后自检仍没通过（${vr2.detail}），可能不是版本的问题` : `（退回后的自检暂缓：${vr2.detail}）`
    await notifyOnce(id, `bad:${to}`, `⚠️ ${spec.label} 换到 ${to} 后自检没通过（${vr.detail}），已自动退回 ${target}${tail}。${to} 记为有问题的版本，出了更新的版本再自动升级。`)
    return { ok: true, result: 'rolled_back', from: to, to: target, detail: vr.detail }
  }

  async function safeVerify(spec: CliSpec): Promise<VerifyResult> {
    try { return await deps.verify(spec) } catch (err) {
      // 自检本身崩了(不是「CLI 坏了」的证据)⇒ 暂缓。
      return { status: 'deferred', detail: `自检没跑起来:${err instanceof Error ? err.message : String(err)}` }
    }
  }

  function gate(spec: CliSpec): { bin: string; release: () => void } | OpOutcome {
    const bin = deps.locate(spec.id)
    if (!bin) return { ok: false, result: 'not_installed' }
    if (L.detect(spec, bin).kind === 'bundled') return { ok: false, result: 'bundled', detail: 'SDK 自带的二进制,不归自动升级管' }
    const idle = deps.isIdle(spec)
    if (!idle.idle) return { ok: false, result: 'not_idle', detail: idle.reason ?? '有工作在跑' }
    return { bin, release: deps.holdBusy(`cli-upgrade:${spec.id}`) }
  }

  async function upgrade(id: CliId, opts?: { source?: UpgradeSource; force?: boolean }): Promise<OpOutcome> {
    const spec = specs[id]
    const source = opts?.source ?? 'manual'
    return exclusive(id, async () => {
      const g = gate(spec)
      if ('result' in g) {
        if (g.result !== 'not_idle') mutate(id, (s) => { s.pending = null })
        return g
      }
      try {
        const s0 = read(id)
        if (source !== 'manual' && s0.nextCheckAt && Date.parse(s0.nextCheckAt) > now()) {
          return { ok: false, result: 'backoff', detail: `退避到 ${s0.nextCheckAt}` }
        }
        const before = await installedVersion(spec, g.bin, deps.run)
        if (!opts?.force && s0.latest && before && spec.latest.kind !== 'none') {
          if (!isNewer(spec, s0.latest, before)) { mutate(id, (s) => { s.pending = null; s.installed = before }); return { ok: true, result: 'up_to_date', from: before, to: before } }
          if (s0.knownBad.includes(s0.latest)) { mutate(id, (s) => { s.pending = null }); return { ok: false, result: 'known_bad', from: before, to: s0.latest, detail: `${s0.latest} 之前自检没过` } }
        }
        const t = now()
        log(`${id}: 跑官方升级器 ${spec.bin} ${spec.updateArgs.join(' ')}(当前 ${before ?? '?'},来源 ${source})`)
        const r = await deps.run(g.bin, spec.updateArgs, { timeoutMs: deps.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS })
        const after = await installedVersion(spec, g.bin, deps.run)
        if (after === null && before !== null) {
          // 升级器把 CLI 弄得连 --version 都打不出来了:按自检失败处理(退回),新版本号不知道就不记坏版本。
          mutate(id, (s) => { s.pending = null; s.installed = null })
          return await verifyAfterChange(spec, g.bin, before, null, source, `升级后 ${spec.bin} --version 打不出来`)
        }
        if (r.code !== 0 && after === before) {
          const detail = `${spec.bin} ${spec.updateArgs.join(' ')} 退出码 ${r.code ?? (r.timedOut ? '超时' : '?')}${(r.stderr || r.error) ? `:${(r.stderr || r.error || '').trim().slice(-300)}` : ''}`
          mutate(id, (s) => {
            s.pending = null
            s.checkFailures += 1
            s.nextCheckAt = iso(t + backoffMs(s.checkFailures))
            s.lastUpgrade = { from: before, to: after, at: iso(t), source, result: 'failed', detail }
          })
          log(`${id}: 升级器失败 ${detail}`)
          return { ok: false, result: 'failed', from: before, to: after, detail }
        }
        if (!after || after === before) {
          mutate(id, (s) => {
            s.pending = null; s.installed = after
            s.lastUpgrade = { from: before, to: after, at: iso(t), source, result: 'noop', detail: '升级器说没有新版本' }
          })
          return { ok: true, result: 'noop', from: before, to: after }
        }
        mutate(id, (s) => { s.pending = null; s.installed = after; s.verify = 'unverified'; s.rollbackTo = before; s.verifyAttemptAt = null })
        log(`${id}: ${before ?? '?'} → ${after},开始自检`)
        return await verifyAfterChange(spec, g.bin, before, after, source)
      } finally { g.release() }
    })
  }

  /** 欠着的自检(外部换了版本 / 上次被网络守护挡下)。 */
  async function verifyOwed(id: CliId): Promise<OpOutcome> {
    const spec = specs[id]
    return exclusive(id, async () => {
      const g = gate(spec)
      if ('result' in g) return g
      try {
        const s = read(id)
        const cur = await installedVersion(spec, g.bin, deps.run)
        if (!cur || s.verify !== 'unverified' || !s.rollbackTo) return { ok: true, result: 'nothing_to_verify' }
        if (cur === s.rollbackTo) {
          // 有人(主人 / CLI 自己)已经换回去了:不欠自检了。
          mutate(id, (x) => { x.installed = cur; x.accepted = cur; x.rollbackTo = null; x.verify = 'unknown' })
          return { ok: true, result: 'nothing_to_verify' }
        }
        return await verifyAfterChange(spec, g.bin, s.rollbackTo, cur, s.lastUpgrade?.source ?? 'external')
      } finally { g.release() }
    })
  }

  async function rollback(id: CliId): Promise<OpOutcome> {
    const spec = specs[id]
    return exclusive(id, async () => {
      const g = gate(spec)
      if ('result' in g) return g
      try {
        const t = now()
        const cur = await installedVersion(spec, g.bin, deps.run)
        if (!cur) return { ok: false, result: 'not_installed', detail: '当前版本打不出来' }
        const s = read(id)
        const layout = L.detect(spec, g.bin)
        const target = (s.lastUpgrade?.to === cur && s.lastUpgrade.from && s.lastUpgrade.from !== cur ? s.lastUpgrade.from : null)
          ?? (s.accepted && s.accepted !== cur ? s.accepted : null)
          ?? L.previous(spec, layout, cur)
        if (!target) return { ok: false, result: 'no_previous', from: cur, detail: `找不到比 ${cur} 旧的版本。${manualRollbackSteps(spec, null)}` }
        const rb = await applyRollback(spec, g.bin, layout, target)
        const after = rb.ok ? await installedVersion(spec, g.bin, deps.run) : cur
        if (!rb.ok || after !== target) {
          const why = rb.ok ? `退回后版本是 ${after ?? '打不出来'}` : rb.detail
          mutate(id, (x) => { x.lastUpgrade = { from: cur, to: target, at: iso(t), source: 'manual', result: 'rollback_failed', detail: why } })
          return { ok: false, result: 'rollback_failed', from: cur, to: target, detail: `${why}。${manualRollbackSteps(spec, target)}` }
        }
        const vr = await safeVerify(spec)
        mutate(id, (x) => {
          if (!x.knownBad.includes(cur)) x.knownBad = [...x.knownBad, cur].slice(-20)
          x.installed = target; x.accepted = target; x.rollbackTo = null; x.pending = null
          x.verify = vr.status === 'pass' ? 'ok' : vr.status === 'fail' ? 'failed' : 'unverified'
          x.verifyDetail = vr.detail
          x.lastUpgrade = { from: cur, to: target, at: iso(t), source: 'manual', result: 'rolled_back', detail: `手动退回;自检 ${vr.status}:${vr.detail}` }
        })
        return { ok: vr.status !== 'fail', result: 'rolled_back', from: cur, to: target, detail: `自检 ${vr.status}:${vr.detail}` }
      } finally { g.release() }
    })
  }

  function viewOf(id: CliId): CliStatusView {
    const s = read(id)
    const spec = specs[id]
    const cfg = safeConfig()
    return {
      id, label: spec.label, auto: cfg.enabled && cfg.cli[id],
      installed: s.installed, latest: s.latest,
      update_available: !!(s.installed && s.latest && isNewer(spec, s.latest, s.installed) && !s.knownBad.includes(s.latest)),
      accepted: s.accepted, verify: s.verify, verify_detail: s.verifyDetail ?? null,
      last_check_at: s.lastCheckAt, last_check_error: s.lastCheckError, next_check_at: s.nextCheckAt,
      pending: s.pending, last_upgrade: s.lastUpgrade, known_bad: s.knownBad,
    }
  }

  function safeConfig(): ResolvedCliUpgradeConfig {
    try { return deps.config() } catch { return { enabled: false, checkHour: 4, cli: { claude: false, codex: false, cursor: false, agy: false } } }
  }

  async function tick(): Promise<void> {
    if (ticking || active) return
    ticking = true
    try {
      const cfg = safeConfig()
      if (!cfg.enabled) return
      const t = now()
      const day = localDay(t)
      for (const id of CLI_IDS) {
        if (!cfg.cli[id]) continue
        let s = read(id)
        const scheduledDue = s.lastScheduledDay !== day && localHour(t) >= cfg.checkHour
        const reactiveDue = s.reactiveAt !== null
        if (scheduledDue || reactiveDue) {
          await check(id, reactiveDue ? 'reactive' : 'scheduled')
          mutate(id, (x) => { if (scheduledDue) x.lastScheduledDay = day; x.reactiveAt = null })
          s = read(id)
        }
        if (s.verify === 'unverified' && s.rollbackTo !== undefined && s.rollbackTo !== null) {
          const last = s.verifyAttemptAt ? Date.parse(s.verifyAttemptAt) : 0
          if (t - last >= VERIFY_RETRY_MS && deps.isIdle(specs[id]).idle) {
            await verifyOwed(id)
            return // 一拍只做一件重活
          }
        }
        if (s.pending && deps.isIdle(specs[id]).idle) {
          await upgrade(id, { source: s.pending })
          return
        }
      }
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`)
    } finally { ticking = false }
  }

  function onTurnError(providerId: string, code: string | null | undefined, message: string | null | undefined): boolean {
    try {
      const id = cliIdForProvider(providerId)
      if (!id || !outdatedClientSignal(id, message, code)) return false
      const t = now()
      const last = lastReactive.get(id)
      if (last !== undefined && t - last < REACTIVE_DEBOUNCE_MS) return false
      lastReactive.set(id, t)
      mutate(id, (s) => { s.reactiveAt = iso(t) })
      log(`${id}: 回合报错像是 CLI 太旧,排一次版本检查`)
      return true
    } catch { return false }
  }

  return {
    tick,
    check: (id, source) => check(id, source),
    upgrade,
    rollback,
    onTurnError,
    status: () => {
      const cfg = safeConfig()
      return { enabled: cfg.enabled, check_hour: cfg.checkHour, active, clis: CLI_IDS.map(viewOf) }
    },
    active: () => active,
  }
}

export type { CliUpgradeState }
