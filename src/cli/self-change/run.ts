/**
 * run.ts —— 把十二个步骤串起来的那台机器。
 *
 * 只有三件事是它自己做的,都是**不该散进步骤里**的:
 *  1. 修复轮:tests / review / ci 三处各自计数、超了就 `<kind>_exhausted`,
 *     没超就把失败原文 `--resume` 交回同一个实现会话,然后**一律跳回 guard** ——
 *     执行者修的时候可能顺手碰了禁改清单,不重过 guard 等于护栏有个后门。
 *  2. 存盘:每一步前后各存一次。中途断电 / 被 kill,`--resume <id>` 从
 *     `state.step` 接着跑,最多重跑一步。
 *  3. 结局:result 怎么记、失败怎么报给主人、连续失败要不要停机、退出码是几。
 *
 * 设计:docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md §流程与闸门。
 */
import { SELF_CHANGE_DEFAULTS } from './policy'
import { commitAll, isDirty, notify, repoPath, steps, summaryOf, writePatch, type FixKind, type PipelineDeps } from './steps'
import type { SelfChangeState } from './state'

/** 退出码的唯一出处(CLI 和微信侧都读这张表)。 */
export const SELF_CHANGE_EXIT = { done: 0, failed: 1, blocked: 2, declined: 3, approvalTimeout: 4 } as const

export type SelfChangeExitCode = 0 | 1 | 2 | 3 | 4

/**
 * 「不是这次改动的错」那几种:重试同样的需求没有意义,得先有人去动机器。
 *
 * 后三个是 CLI 层(Task 7)在流水线起步之前就会挡下的:同时跑第二条、平台不对、
 * 不知道该克隆哪个仓库。它们仍然归在这张表里 —— 退出码只有 `exitCodeFor` 一处说了算,
 * 调用方各自写一个 `return 2` 迟早对不上。
 */
const BLOCKED: readonly string[] = [
  'self_change_halted', 'self_change_quota', 'daemon_not_running', 'owner_chat_unknown',
  'self_change_busy', 'self_change_unsupported_platform', 'repo_url_unknown',
]

export function exitCodeFor(result: string | null): SelfChangeExitCode {
  if (result === 'done') return SELF_CHANGE_EXIT.done
  if (result === 'declined') return SELF_CHANGE_EXIT.declined
  if (result === 'approval_timeout') return SELF_CHANGE_EXIT.approvalTimeout
  if (result !== null && BLOCKED.includes(result)) return SELF_CHANGE_EXIT.blocked
  return SELF_CHANGE_EXIT.failed
}

/** 只有这两种结局会把 `fail_streak` 推到停机:机器本身出了问题,不是这次改动被否了。 */
const HALTABLE: readonly string[] = ['deploy_failed', 'selftest_failed_rolled_back']

/** 失败通知里带多少 detail —— 微信里一条太长的消息没人读,原文在 state 里。 */
const DETAIL_IN_NOTICE = 200

function noticeFor(s: SelfChangeState, result: string, detail: string): string {
  const head = `自改 #${s.id}`
  // 分支保留:v1 没有清理器(spec 的「24 小时后由下次运行清理」推到 v1.1),
  // 所以话要说清楚 —— 远端多出来的这条分支是留给人看的,不是漏删的。
  if (result === 'declined') return `${head} 你回了 n,已放弃。分支 ${s.branch} 留在远端给人看(要清理得手工删)。`
  if (result === 'approval_timeout') return `${head} 没等到拍板,先停在这儿了(wechat-cc self change --resume ${s.id} 可以重发卡)`
  return `${head} 失败:${result}\n${detail.slice(0, DETAIL_IN_NOTICE)}`
}

export async function runSelfChange(
  state: SelfChangeState,
  deps: PipelineDeps,
): Promise<{ state: SelfChangeState; exitCode: SelfChangeExitCode }> {
  const s = state

  const save = (): void => { s.updatedAt = deps.now(); deps.state.save(s) }

  // 重新开跑 ⇒ 盘上先变回「活的」。
  //
  // 2026-09-18 真机:`--resume` 一条 approval_timeout 的自改,内存里接着跑得好好的,
  // 盘上却还写着 `result: approval_timeout` 和上一轮的 hash —— 于是 `--approve` 的
  // 第一道门(`result === null`)直接把人挡在外面,拍不了板,又只能等超时。
  // result / error 是**上一次的结局**,这一次还没有结局;approval.decision 同理
  // (拿上一轮的 timeout 当这一轮的答案,会让轮询以为已经落定了)。
  if (s.result !== null || s.error !== null) {
    deps.log(`[self-change] #${s.id} 从 ${s.step} 接着跑(上次收在 ${s.result ?? '(没记结局)'})`)
    s.result = null
    s.error = null
    s.approval.decision = null
  }

  /** 走到结局:记 result、存盘、告诉主人、必要时停机。 */
  const finish = async (result: string, detail: string): Promise<{ state: SelfChangeState; exitCode: SelfChangeExitCode }> => {
    s.result = result
    if (detail) s.error = detail
    save()
    await notify(s, deps, noticeFor(s, result, detail))
    // 连着两次部署 / 自检失败 ⇒ 停机。再自动跑下去只会把机器越推越坏。
    // 只认这两种结局:`fail_streak` 是上一条留下的,主人这次回了个 n
    // (或者评审没过)不该把机器停掉。
    if (HALTABLE.includes(result) && deps.config.failStreak >= SELF_CHANGE_DEFAULTS.halt_after_fail_streak) {
      deps.config.haltedAt = deps.now()
      deps.config.haltReason = `${result}(连续 ${deps.config.failStreak} 次)`
      writePatch(deps, { halted_at: deps.config.haltedAt, halt_reason: deps.config.haltReason })
      await notify(s, deps, `自改已停机:${deps.config.haltReason}。修好之后 wechat-cc self change --unhalt 解除。`)
    }
    return { state: s, exitCode: exitCodeFor(result) }
  }

  /**
   * 一轮修复。计数超了就到此为止,否则交回同一个实现会话,
   * 工作树脏了替它提交,然后回 guard 重走一遍四道闸门。
   */
  const fixRound = async (kind: FixKind, prompt: string, detail: string): Promise<{ state: SelfChangeState; exitCode: SelfChangeExitCode } | null> => {
    s.implement.rounds[kind] += 1
    if (s.implement.rounds[kind] > SELF_CHANGE_DEFAULTS.max_fix_rounds) {
      return await finish(`${kind}_exhausted`, detail)
    }
    deps.log(`[self-change] 修复轮 ${kind} 第 ${s.implement.rounds[kind]} 轮`)
    save()
    const res = await deps.runner.run({
      cwd: repoPath(deps.config),
      prompt,
      ...(s.implement.sessionId ? { resume: s.implement.sessionId } : {}),
      // 预算是**这条自改实现侧的总额**,不是每轮的额度:六轮修复各给一份
      // implement_budget_usd,最坏情况是主人以为花 20 刀、实际花了七倍。
      // 给剩下的那部分;花超了也留 1 刀,好让这一轮能把话说完而不是当场没钱。
      budgetUsd: Math.max(1, deps.config.implementBudgetUsd - s.implement.costUsd),
      maxTurns: deps.config.maxTurns,
    })
    if (res.sessionId) s.implement.sessionId = res.sessionId
    s.implement.costUsd += res.costUsd
    s.implement.turns += res.turns
    // 拍板卡要的是**最近一轮**说的话:修了两轮之后再给主人看第一轮的交代,
    // 等于让他照着一份过期的说明拍板。空话不覆盖(宁可留着上一轮那段)。
    const summary = summaryOf(res.text)
    if (summary) s.implement.summary = summary
    if (res.stderrTail.length) s.stderrTail = res.stderrTail
    if (!res.ok) return await finish('implement_failed', `修复轮(${kind}):${res.error ?? 'unknown'}${res.timedOut ? '(被超时杀掉)' : ''}\n${res.text.slice(-1000)}`)
    try {
      if (isDirty(deps)) commitAll(deps, `自改 #${s.id}:修复轮(${kind})未提交的改动`)
    } catch (err) {
      return await finish('implement_failed', `修复轮(${kind})之后提交不了:${err instanceof Error ? err.message : String(err)}`)
    }
    s.step = 'guard'
    save()
    return null
  }

  while (s.step !== 'done') {
    save()
    const step = steps[s.step]
    let outcome
    try {
      outcome = await step(s, deps)
    } catch (err) {
      // 步骤自己没接住的异常(假件说谎、磁盘满、bug)。当失败记,原文留在 state 里。
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.trim() : String(err)
      return await finish('crashed', message)
    }

    if (!outcome.ok && outcome.fixRound) {
      const ended = await fixRound(outcome.fixRound, outcome.fixPrompt ?? '', outcome.detail ?? '')
      if (ended) return ended
      continue
    }
    if (!outcome.ok) return await finish(outcome.fail ?? 'unknown_failure', outcome.detail ?? '')

    s.step = outcome.next ?? 'done'
    save()
  }

  s.result = 'done'
  save()
  return { state: s, exitCode: SELF_CHANGE_EXIT.done }
}
