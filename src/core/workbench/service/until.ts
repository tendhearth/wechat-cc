/**
 * 做到条件成立为止(spec 2026-10-20-workbench-until-design,对标 Claude Code /goal):
 * 一轮成功做完 ⇒ 在这件事的独立工作区里跑一次主人写的检查命令;没过就把输出尾巴(打码、包成数据)送回去接着改,
 * 有轮数上限。每一种停都写一条事件。命令只从 workbench_goals 读 —— 执行者碰不到。
 */
import { randomUUID } from 'node:crypto'
import { redactSecrets } from '../../cli-transcript'
import { startScript, type ScriptExit } from '../script-runner'
import { isUnattendedExecutor, type WorkbenchExecutorCapabilities } from '../executor-capabilities'
import { untilContinuation, untilRequestId } from '../until'
import type { Active } from './state'
import type { ServiceCtx } from './ctx'

export const UNTIL_CHECK_TIMEOUT_MS = 10 * 60_000

export interface UntilOptions {
  /** 测试用:换掉真的 shell。 */
  start?: typeof startScript
  /** 测试用:判免审(缺省 isUnattendedExecutor)。 */
  isUnattended?: (caps: WorkbenchExecutorCapabilities) => boolean
}

const succeeded = (e: ScriptExit) => e.code === 0 && !e.error && !e.timedOut && !e.stopped

export function makeUntilDomain(ctx: ServiceCtx, opts: UntilOptions = {}) {
  const { store } = ctx
  const start = opts.start ?? startScript
  const unattended = opts.isUnattended ?? isUnattendedExecutor
  const inFlight = new Map<string, { promise: Promise<void>; stop: () => Promise<void> }>()
  /** 这一轮已经排过检查(内存去重:settleQuiet 同一轮会触发不止一次;库里的 checked_turn 管跑完之后)。 */
  const queued = new Set<string>()
  /** 检查跑着时又做完了一轮(评审 #419 ①):记下最新那一轮,在跑的结果作废,跑完补查这一轮 —— 不然最后的代码没人查。 */
  const recheck = new Map<string, Active>()

  function note(id: string, text: string) {
    try { store.addEvent(id, 'system', text); ctx.hub.touched(id) } catch { /* 记不上不影响检查 */ }
  }
  function stop(id: string, reason: string) {
    // 在跑的检查一起停(评审 #419 ②):不然它在主人停了 / 工作区要删的时候还跑最长 10 分钟,还挂着 busy 挡自重启
    recheck.delete(id)
    void inFlight.get(id)?.stop().catch(() => {})
    const g = store.goals.get(id)
    if (!g || g.status !== 'active') return
    store.goals.finish(id, 'stopped', reason)
    note(id, `「直到检查通过」停了:${reason}`)
  }
  /** 闸门:不该跑的原因;null = 可以跑。 */
  function blocked(id: string, running: Active): string | null {
    let task
    try { task = store.get(id) } catch { return '这件事不在了' }
    if (task.archivedAt !== null) return '这件事归档了'
    const wt = store.worktrees.get(id)
    if (!wt || wt.removedAt !== null) return '独立工作区已经删了'
    if (running.networkSuspended) return '网络守护暂停了这件事'
    const caps = ctx.deps.registry.get(task.providerId as never)?.opts.workbench as WorkbenchExecutorCapabilities | undefined
    if (caps && unattended(caps)) return '现在的执行者是免审的,不自动接着改'
    return null
  }

  /** 一轮成功做完(retained 的 settleQuiet / 不保留的收尾处)。只排队,不阻塞调用方。 */
  function afterTurn(running: Active): void {
    const id = running.taskId
    const goal = store.goals.get(id)
    if (!goal || goal.status !== 'active' || ctx.state.stopping) return
    const turn = `${running.identity}:${running.turnSeq}`
    if (goal.checkedTurn === turn || queued.has(turn)) return
    if (inFlight.has(id)) { recheck.set(id, running); return }
    // 主人有排队的话 ⇒ 让主人的先;这一轮的检查作废,等下一轮做完再查(设计 §跑的时候 1)。
    if (store.liveInputs.next(id)) return
    const why = blocked(id, running)
    if (why) { stop(id, why); return }
    queued.add(turn)
    const round = goal.rounds + 1
    const eventId = `until-${randomUUID()}`
    const record = (status: 'running' | 'completed' | 'failed' | 'cancelled', tail: string) => {
      try {
        store.recordAgentEvent(id, running.identity, { kind: 'tool_call', tool: 'tendhearth-check', activity: { id: eventId, type: 'command', status, label: `检查 · 第 ${round} 轮`, ...(tail ? { output: redactSecrets(tail) } : {}) } })
        ctx.hub.touched(id)
      } catch { /* 下一次输出再写 */ }
    }
    const wt = store.worktrees.get(id)!
    const release = ctx.deps.holdBusy?.(`wt-check:${id}`)
    record('running', '')
    const script = start({
      kind: 'check', script: goal.command, cwd: wt.root, timeoutMs: UNTIL_CHECK_TIMEOUT_MS,
      env: { port: wt.port, workspacePath: wt.root, rootPath: wt.repoRoot, branch: wt.branch },
      onOutput: tail => record('running', tail),
    })
    const promise = script.done.then(exit => settle(running, turn, round, exit)).catch(err => {
      ctx.log?.('WORKBENCH_UNTIL', `${id}: ${err instanceof Error ? err.message : err}`)
    }).finally(() => {
      inFlight.delete(id); queued.delete(turn); release?.()
      const next = recheck.get(id)
      if (next) { recheck.delete(id); try { afterTurn(next) } catch { /* 下一轮做完再查 */ } }
    })
    inFlight.set(id, { promise, stop: script.stop })

    async function settle(r: Active, turnKey: string, n: number, exit: ScriptExit) {
      const ok = succeeded(exit)
      record(exit.stopped ? 'cancelled' : ok ? 'completed' : 'failed', exit.tail || exit.error || '')
      const g = store.goals.get(id)
      if (!g || g.status !== 'active' || ctx.state.stopping || exit.stopped) return
      // 检查期间又做完了一轮(保留会话 / 不保留会话都一样走 afterTurn)⇒ 这个结果是旧代码的,作废;finally 里补查新的那一轮。
      if (recheck.has(id)) return
      // 跑完重新核对:这一轮之后开始了新的一轮 / 换了一条 run ⇒ 结果作废(那一轮做完时会排检查)。
      const current = ctx.state.runsByTask.get(id)
      if (current && (current !== r || r.turnSeq !== Number(turnKey.split(':').pop()) || !ctx.actions.deref('until').isReplied(current))) return
      const why = blocked(id, r)
      if (why) { stop(id, why); return }
      store.goals.recordCheck(id, { checkedTurn: turnKey, exit: exit.code, rounds: n })
      if (ok) {
        store.goals.finish(id, 'passed')
        note(id, `检查通过(第 ${n} 轮):\`${g.command}\``)
        return
      }
      if (n >= g.maxRounds) {
        store.goals.finish(id, 'exhausted')
        note(id, `到上限还没过(${g.maxRounds} 轮,最后一次退出码 ${exit.code ?? '无'}),停了。`)
        return
      }
      const text = untilContinuation({ round: n, maxRounds: g.maxRounds, exit: exit.timedOut ? null : exit.code, command: g.command, tail: exit.tail || exit.error || '' })
      const requestId = untilRequestId(id, n)
      try {
        if (current) await ctx.actions.deref('until').submitInput(id, { runId: current.identity, requestId, text })
        else ctx.actions.deref('until').continueTask(id, text, { inputRequestId: requestId })
        note(id, `检查没过(第 ${n}/${g.maxRounds} 轮,退出码 ${exit.code ?? '无'}),已让执行者接着改。`)
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err)
        // 主人这时自己开了一轮 ⇒ 让主人的先,goal 照旧
        if (code === 'workbench_busy' || code === 'native_session_busy') return
        stop(id, code === 'restart_confirmation_required' ? '原会话接不上了,需要你在桌面确认重新开始'
          : code === 'workbench_archived' ? '这件事归档了'
          : code === 'worktree_removed' ? '独立工作区已经删了'
          : `没能接着改(${code})`)
      }
    }
  }

  return {
    afterTurn,
    stop,
    /** 回退用(2026-10-21):这件事的检查在跑 / 已排上 ⇒ 不许回退。 */
    checking: (id: string): boolean => inFlight.has(id) || recheck.has(id),
    /** 测试 / 停机用:等这件事在跑的检查结束。 */
    idle: (id: string) => inFlight.get(id)?.promise ?? Promise.resolve(),
    shutdown: async () => { await Promise.all([...inFlight.values()].map(f => f.stop().catch(() => {}))) },
  }
}
export type UntilDomain = ReturnType<typeof makeUntilDomain>
