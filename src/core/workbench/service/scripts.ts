/**
 * 独立工作区的脚本怎么跑(2026-10-20,对标 Conductor;PR-B):setup / run / archive 的时机、批准、端口、落库、停机与重启核对。
 * 读脚本见 worktree-scripts.ts(钉在建工作区时的提交),起进程见 script-runner.ts。
 *
 * 规矩:只跑主人当面批准过的内容 —— 按 (仓库, 内容哈希) 批,改一个字就要重批;没批 ⇒ 时间线说一句「待确认」,什么都不跑。
 *   - setup:建好工作区 / 重新打开后跑一次(批了才跑;批准那一刻补跑);和第一轮并行。
 *   - run:主人点「运行」;setup 还没跑成 ⇒ 先跑 setup,成了再接着跑 run。每个工作区同时只有一个 run。
 *   - archive:删工作区前跑(先停 run),限时 2 分钟;没跑成照样删,留一句。
 * holdBusy 只给 setup / archive(有时限);run 是开发服务,可能一直开着,不能挡空闲自重启 —— 停机时一并停掉,重启后核对。
 * 输出:时间线里一条 command 活动(run_id = script-<uuid>),尾巴先过 redactSecrets 再落库。
 */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { redactSecrets } from '../../cli-transcript'
import { startScript, KILL_GRACE_MS, type RunningScript, type ScriptExit } from '../script-runner'
import { allocatePort } from '../worktree-ports'
import { readPinnedScripts, repoKeyOf, type PinnedScripts, type ScriptKind } from '../worktree-scripts'
import type { WorktreeRecord } from '../store'
import { BOOT_TOLERANCE_MS, bootTimeMs, groupAlive } from './writer-exit'
import type { ServiceCtx } from './ctx'
import type { ScriptsView } from './types'
export type { ScriptsView } from './types'

export const SETUP_TIMEOUT_MS = 30 * 60_000
export const ARCHIVE_TIMEOUT_MS = 2 * 60_000
/** 记下的启动时刻与 ps 报的差多少以内算同一个进程(ps 只到秒,spawn 本身也要一点时间)。 */
const START_TOLERANCE_MS = 5_000

export interface ScriptsOptions {
  /** 测试用:shell、基底环境、输出节流、端口探测、ps 启动时刻、发信号。 */
  shell?: string
  baseEnv?: NodeJS.ProcessEnv
  outputIntervalMs?: number
  probe?: (port: number) => Promise<boolean>
  processStartMs?: (pid: number) => number | null
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

interface Live { kind: ScriptKind; eventId: string; startedAt: number; script: RunningScript | null; stopRequested: boolean }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** 进程启动时刻(毫秒):`ps -o lstart=`,钉 UTC + C 区域再自己解析;读不出 / Windows ⇒ null(那就不动它)。 */
export function psStartMs(pid: number): number | null {
  if (process.platform === 'win32') return null
  let text = ''
  try { text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim() } catch { return null }
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text)
  const month = m ? MONTHS.indexOf(m[1]!) : -1
  return m && month >= 0 ? Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) : null
}

export function makeScriptsDomain(ctx: ServiceCtx, opts: ScriptsOptions = {}) {
  const { store } = ctx
  const live = new Map<string, Map<ScriptKind, Live>>()
  /** 点了「运行」但 setup 还在跑:setup 成了接着起 run。 */
  const runAfterSetup = new Set<string>()
  const setupFailed = new Set<string>()
  /** 正在收尾(先停 run、再跑 archive、最后删目录)。 */
  const removing = new Set<string>()
  let stopping = false
  let stopPromise: Promise<void> | undefined
  const processStartMs = opts.processStartMs ?? psStartMs
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))

  function pinned(id: string): { wt: WorktreeRecord | null; scripts: PinnedScripts | null } {
    const wt = store.worktrees.get(id)
    if (!wt?.scriptSha) return { wt, scripts: null }
    return { wt, scripts: readPinnedScripts(wt.repoRoot, wt.scriptSha) }
  }
  const approved = (wt: WorktreeRecord, hash: string) => store.scriptApprovals.has(repoKeyOf(wt.repoRoot), hash)
  const liveOf = (id: string, kind: ScriptKind) => live.get(id)?.get(kind)
  function note(id: string, text: string) {
    try { store.addEvent(id, 'system', text); ctx.hub.touched(id) } catch { /* 说不上这句不影响脚本 */ }
  }
  function record(id: string, l: Live, status: 'running' | 'completed' | 'failed' | 'cancelled', tail: string) {
    // 标签不带路径(时间线会到手机);输出先打码再落库
    try {
      store.recordAgentEvent(id, l.eventId, { kind: 'tool_call', tool: 'tendhearth-script', activity: { id: l.eventId, type: 'command', status, label: l.kind, ...(tail ? { output: redactSecrets(tail) } : {}) } })
      ctx.hub.touched(id)
    } catch { /* 任务没了 / 库忙:下一次输出再写 */ }
  }
  function persistGroups(id: string) {
    const entries = [...(live.get(id)?.values() ?? [])].filter(l => l.script?.pgid)
    try { store.worktrees.setScriptGroups(id, entries.map(l => l.script!.pgid!), bootTimeMs(ctx), entries.map(l => l.startedAt)) } catch { /* 下次再记 */ }
  }
  const succeeded = (exit: ScriptExit) => exit.code === 0 && !exit.error && !exit.timedOut && !exit.stopped

  function finished(id: string, l: Live, exit: ScriptExit) {
    record(id, l, exit.stopped ? 'cancelled' : succeeded(exit) ? 'completed' : 'failed', exit.tail || exit.error || '')
    const map = live.get(id)
    if (map?.get(l.kind) === l) map.delete(l.kind)
    if (map && !map.size) live.delete(id)
    persistGroups(id)
    if (l.kind !== 'setup') return
    if (succeeded(exit)) {
      setupFailed.delete(id)
      try { store.worktrees.markSetup(id) } catch { /* 下次照样再跑一遍 setup */ }
      if (runAfterSetup.delete(id) && !stopping) void launch(id, 'run').catch(() => { /* 批准撤了 / 工作区删了:不跑 */ })
    } else {
      if (!exit.stopped) setupFailed.add(id)
      if (runAfterSetup.delete(id)) note(id, 'setup 没跑成功，这次没有接着运行。')
    }
    ctx.hub.bumped(id)
  }

  /** 起一条脚本。每次都重新核对批准(从不跑没批过的内容);端口用到时才分配。 */
  async function launch(id: string, kind: ScriptKind): Promise<RunningScript | null> {
    const { wt, scripts } = pinned(id)
    if (!wt || wt.removedAt !== null || scripts?.kind !== 'ok' || stopping) return null
    const text = scripts.config[kind]
    if (!text) return null
    if (!approved(wt, scripts.hash)) throw new Error('script_approval_required')
    if (liveOf(id, kind)) return null
    const l: Live = { kind, eventId: `script-${randomUUID()}`, startedAt: 0, script: null, stopRequested: false }
    let map = live.get(id)
    if (!map) live.set(id, map = new Map())
    map.set(kind, l)
    const release = kind === 'run' ? undefined : ctx.deps.holdBusy?.(`wt-${kind}:${id}`)
    const drop = () => { if (map!.get(kind) === l) map!.delete(kind); if (!map!.size) live.delete(id); release?.() }
    try {
      let port = wt.port
      if (port === null) port = await allocatePort({ used: () => store.worktrees.usedPorts(), claim: p => store.worktrees.setPort(id, p), ...(opts.probe ? { probe: opts.probe } : {}) })
      if (l.stopRequested || stopping) { drop(); return null }
      record(id, l, 'running', '')
      l.startedAt = Date.now()
      const timeoutMs = kind === 'setup' ? SETUP_TIMEOUT_MS : kind === 'archive' ? ARCHIVE_TIMEOUT_MS : undefined
      l.script = startScript({
        kind, script: text, cwd: wt.root,
        env: { port, workspacePath: wt.root, rootPath: wt.repoRoot, branch: wt.branch },
        onOutput: tail => record(id, l, 'running', tail),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(opts.shell ? { shell: opts.shell } : {}), ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}), ...(opts.outputIntervalMs !== undefined ? { outputIntervalMs: opts.outputIntervalMs } : {}),
      })
      persistGroups(id)
      void l.script.done.then(exit => { try { finished(id, l, exit) } finally { release?.() } })
      ctx.hub.bumped(id)
      return l.script
    } catch (error) { drop(); throw error }
  }

  function status(id: string): ScriptsView | null {
    const { wt, scripts } = pinned(id)
    if (!wt || !scripts || scripts.kind === 'none') return null
    if (scripts.kind === 'invalid') return { configured: false, invalid: scripts.reason }
    const c = scripts.config
    if (!c.setup && !c.run && !c.archive) return null
    return {
      configured: true, approved: approved(wt, scripts.hash), hash: scripts.hash, config: c,
      setup: !c.setup ? 'none' : liveOf(id, 'setup') ? 'running' : wt.setupAt !== null ? 'done' : setupFailed.has(id) ? 'failed' : 'pending',
      run: !c.run ? 'none' : liveOf(id, 'run') ? 'running' : runAfterSetup.has(id) ? 'queued' : 'idle',
      archiving: removing.has(id),
    }
  }

  function stopRun(id: string): Promise<void> {
    runAfterSetup.delete(id)
    const l = liveOf(id, 'run')
    if (!l) return Promise.resolve()
    l.stopRequested = true
    return l.script ? l.script.stop() : Promise.resolve()
  }

  return {
    status,
    /** 回退用(2026-10-21):setup / archive 在跑、或正在收尾删除 ⇒ 正碰着工作区。开发服务(run)不算,只提示。 */
    busy: (id: string): boolean => removing.has(id) || !!liveOf(id, 'setup') || !!liveOf(id, 'archive'),
    /** 开发服务在跑(回退照做,预览里提示一句)。 */
    serving: (id: string): boolean => !!liveOf(id, 'run'),
    /** 建好工作区 / 重新打开之后:批过 ⇒ 跑 setup;没批 ⇒ 说一句「待确认」,什么都不跑。从不抛(不拦建任务)。 */
    afterCheckout(id: string): void {
      try {
        const { wt, scripts } = pinned(id)
        if (!wt || !scripts || scripts.kind === 'none') return
        if (scripts.kind === 'invalid') { note(id, `项目里的 tendhearth.json 读不懂（${scripts.reason}），工作区脚本都不会运行。`); return }
        if (!scripts.config.setup) return
        if (!approved(wt, scripts.hash)) { note(id, '这个项目的 tendhearth.json 里有工作区脚本，在电脑上确认之后才会运行（待确认）。'); return }
        void launch(id, 'setup').catch(() => { /* 只会是批准刚被撤:不跑 */ })
      } catch { /* git 读不了 ⇒ 当没有脚本 */ }
    },
    /** 主人点「运行」/「停下」。 */
    async scriptAction(id: string, action: 'run' | 'stop'): Promise<{ branch: string; scripts: ScriptsView | null; port: number | null }> {
      if (action !== 'run' && action !== 'stop') throw new Error('invalid_request')
      const task = store.get(id)
      const { wt, scripts } = pinned(id)
      if (!wt) throw new Error('not_worktree')
      const result = () => ({ branch: wt.branch, scripts: status(id), port: store.worktrees.getPort(id) })
      if (action === 'stop') {
        // 不等它真停:停 = TERM,最多 5 秒后 KILL;状态行跟着时间线刷新
        void stopRun(id)
        ctx.hub.bumped(id)
        return result()
      }
      ctx.ensureAccepting()
      if (stopping) throw new Error('workbench_stopping')
      if (task.archivedAt !== null) throw new Error('workbench_archived')
      if (wt.removedAt !== null) throw new Error('worktree_removed')
      if (scripts?.kind !== 'ok' || !scripts.config.run) throw new Error('no_scripts')
      if (!approved(wt, scripts.hash)) throw new Error('script_approval_required')
      if (removing.has(id)) throw new Error('workbench_busy')
      if (liveOf(id, 'run') || (runAfterSetup.has(id) && !liveOf(id, 'setup'))) throw new Error('script_running')
      if (liveOf(id, 'setup')) {
        // setup 在跑:排在它后面(批准之后重试「运行」就是这种情况);已经排着 ⇒ 拒绝
        if (runAfterSetup.has(id)) throw new Error('script_setup_running')
        runAfterSetup.add(id); ctx.hub.bumped(id)
        return result()
      }
      if (scripts.config.setup && wt.setupAt === null) {
        runAfterSetup.add(id)
        try { if (!(await launch(id, 'setup'))) runAfterSetup.delete(id) } catch (error) { runAfterSetup.delete(id); throw error }
        return result()
      }
      await launch(id, 'run')
      return result()
    },
    /** 主人在确认框里看过三条脚本原文后批准;hash 是他看到的那份,不一致 ⇒ 内容变了,重新看。 */
    approveScripts(id: string, hash: string): ScriptsView | null {
      const task = store.get(id)
      const { wt, scripts } = pinned(id)
      if (!wt) throw new Error('not_worktree')
      if (scripts?.kind !== 'ok') throw new Error('no_scripts')
      if (scripts.hash !== hash) throw new Error('script_config_changed')
      if (!approved(wt, hash)) {
        store.scriptApprovals.add(repoKeyOf(wt.repoRoot), hash)
        note(id, '已确认这个项目的工作区脚本；内容改了要重新确认。')
      }
      // 批准之前没跑成的 setup 现在补上
      if (scripts.config.setup && wt.setupAt === null && wt.removedAt === null && task.archivedAt === null && !removing.has(id) && !liveOf(id, 'setup') && !setupFailed.has(id)) void launch(id, 'setup').catch(() => {})
      return status(id)
    },
    stopRun,
    /**
     * 删工作区之前(worktree 域的 remove 调):没有在跑的脚本、也没有批过的 archive ⇒ 'sync'(照旧同步删)。
     * 否则 'async':先停在跑的,再跑 archive(限时),最后调 finish 删目录;archive 没跑成照删,留一句。
     */
    beforeRemove(id: string, finish: () => void): 'sync' | 'async' {
      if (removing.has(id)) throw new Error('workbench_busy')
      const { wt, scripts } = pinned(id)
      if (!wt) return 'sync'
      runAfterSetup.delete(id)
      const running = [...(live.get(id)?.values() ?? [])]
      const configured = scripts?.kind === 'ok' ? scripts.config.archive : null
      const archive = configured && scripts?.kind === 'ok' && approved(wt, scripts.hash) ? configured : null
      if (configured && !archive) note(id, '收尾脚本（archive）还没确认，这次没有运行。')
      if (!running.length && !archive) return 'sync'
      removing.add(id)
      ctx.hub.bumped(id)
      void (async () => {
        try {
          for (const l of running) l.stopRequested = true
          await Promise.allSettled(running.map(l => l.script?.stop()))
          let failed = false
          if (archive && !stopping) {
            try {
              const script = await launch(id, 'archive')
              if (script) failed = !succeeded(await script.done)
            } catch { failed = true }
          }
          if (stopping) { note(id, 'CC 正在退出，收尾被打断，独立工作区先保留着。'); return }
          try {
            finish()
            if (failed) note(id, '收尾脚本（archive）没跑成功，工作区照样删了（分支保留）。')
          } catch (error) {
            const code = error instanceof Error ? error.message : ''
            note(id, code === 'worktree_dirty' ? '收尾之后独立工作区里有没提交的改动，先保留着。' : `独立工作区暂时删不掉（${code === 'workbench_busy' ? '又有会话在用' : '出了点问题'}），先保留着。`)
          }
        } finally { removing.delete(id); ctx.hub.bumped(id) }
      })()
      return 'async'
    },
    /** 停机:停掉所有脚本(TERM → 宽限 → KILL),等它们退。 */
    shutdown(): Promise<void> {
      if (stopPromise) return stopPromise
      stopping = true
      runAfterSetup.clear()
      const all = [...live.values()].flatMap(map => [...map.values()])
      for (const l of all) l.stopRequested = true
      stopPromise = Promise.allSettled(all.map(l => l.script?.stop())).then(() => {})
      return stopPromise
    },
    /**
     * 重启后(service 建起来时调一次):上次没停掉的脚本(daemon 崩了 / 被杀)。开机时刻对得上 + 组还在 + 组长的启动时刻对得上
     * 才发信号(组号会被复用,三样都对才敢认);对不上的不动、说一句。列一律清掉。Windows 不记进程组,这里什么都不做。
     */
    recover(): void {
      let rows: ReturnType<typeof store.worktrees.scriptGroupRows>
      try { rows = store.worktrees.scriptGroupRows() } catch { return }
      const boot = bootTimeMs(ctx)
      for (const row of rows) {
        try { store.worktrees.setScriptGroups(row.taskId, []) } catch { /* 下次再清 */ }
        if (!row.groups || row.boot === null || Math.abs(row.boot - boot) > BOOT_TOLERANCE_MS) continue
        const ours = (group: number, i: number) => {
          const started = row.starts?.[i], actual = processStartMs(group)
          return started !== undefined && actual !== null && Math.abs(actual - started) <= START_TOLERANCE_MS
        }
        let stopped = 0, unsure = 0
        row.groups.forEach((group, i) => {
          if (!groupAlive(ctx, group)) return
          if (!ours(group, i)) { unsure++; return }
          try { kill(-group, 'SIGTERM'); stopped++ } catch { return }
          const timer = setTimeout(() => { if (groupAlive(ctx, group) && ours(group, i)) { try { kill(-group, 'SIGKILL') } catch { /* 已经没了 */ } } }, KILL_GRACE_MS)
          timer.unref?.()
        })
        if (stopped) note(row.taskId, 'CC 上次退出时工作区脚本还在跑，已停掉。')
        if (unsure) note(row.taskId, 'CC 上次退出时留下的工作区脚本进程核对不上，没有动它；如果它还在跑，请自己结束。')
      }
    },
  }
}
export type ScriptsDomain = ReturnType<typeof makeScriptsDomain>
