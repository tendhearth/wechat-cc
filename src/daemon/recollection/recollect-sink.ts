/**
 * recollect-sink.ts — the daemon-side RecollectSink (src/core/matters/
 * recollection.ts) that src/core/workbench/service.ts's settleQuiet AND its
 * terminal-completion branch both call into (via recollectOnce; fix round
 * 1/5, 2026-09-23, controller ruling: this must be wired up this round, not
 * left for a later task; fix round 2/5 wires the second call point + fixes
 * below).
 *
 * Thin glue, same philosophy as ../reports/report-sink.ts: look up the
 * matter (title + createdAt), pick a cheap model, and let the pure
 * `maybeRecollect` decide whether this crosses the story threshold. If it
 * does, write straight to journal.recordRecollection.
 *
 * `returned` has no data source anywhere in this codebase yet — passed as
 * the explicit constant RETURNED_SIGNAL_UNAVAILABLE (see its doc comment
 * in recollection.ts), never computed here. Do not add bookkeeping for it;
 * that's a separate task.
 *
 * De-dup, THREE layers (fix round 2, complaint from the evaluation round —
 * the first version only had the weakest of these):
 *
 *  1. Persistent, cross-restart (journal.hasRecollection, v67's
 *     journal.matter_id): checked BEFORE even resolving a cheap model.
 *     Round 1's in-memory `done` Set reset on every daemon restart — two
 *     sink instances (= two daemon lifetimes) sharing the same db would
 *     each write their own "一段回忆" for the same still-open matter,
 *     confirmed by evaluation round 2's real repro (crossedOvernight is
 *     true for any matter still open the next day, so the gate reopens on
 *     every restart with no persistent memory of "already told"). The fix
 *     is NOT to change what `overnight` means (spec's literal "不在同一
 *     天") — it's to remember, durably, that this matter already got its
 *     story.
 *  2. In-flight guard (`inFlight`, fix round 2 "小的" ①): two different
 *     turnSeq values can both reach `maybeTrigger` before either's async
 *     `maybeRecollect` call resolves (service.ts's `recollectOnce` only
 *     dedupes the *same* turnSeq; it does not serialize different ones).
 *     Without this, both would pass the persistent check (neither has
 *     written yet) and both would ask the cheap model — two calls, and a
 *     race on which one's `write` lands. `inFlight` closes that window:
 *     marked before the async call starts, cleared in `.finally()`.
 *  3. `declined` (fix round 2 item 6): the model answering with an empty
 *     string is CC deciding "not story-worthy after all" — a legitimate
 *     outcome per spec, not a failure. Without a latch here, every future
 *     settle would ask again, burning a cheap-model call each time with
 *     nothing to show for it and no trace anywhere that this is happening.
 *     In-memory only (not persisted like #1) — a deliberate, narrower
 *     scope than the persistent write-dedup; see the report's concerns for
 *     the tradeoff this accepts.
 */
import type {MatterStore} from '../../core/matters/store'
import {maybeRecollect, buildRecollectionPrompt, crossedOvernight, RETURNED_SIGNAL_UNAVAILABLE, type RecollectSink} from '../../core/matters/recollection'
import type {Journal} from '../../core/journal-store'
import type {CheapEval} from '../../core/agent-provider'

export interface RecollectSinkDeps {
  matters: MatterStore
  journal: Journal
  /** 每次现取——同一个 registry 里谁能用会随执行者登录状态变,不缓存 provider 本身。 */
  cheapEval(): CheapEval | null
  /** journal 是全局伴侣日志,不按 matter 分——跟 wire-social.ts 里 recordVisit/recordPostcard 落主人默认聊天同一惯例。 */
  ownerChatId(): string | null
  now?(): number
  log?(tag: string, line: string): void
}

export function makeRecollectSink(deps: RecollectSinkDeps): RecollectSink {
  /** 同一件事不许同时发起两次模型调用(见文件头 #2)。 */
  const inFlight = new Set<string>()
  /** 模型给过空回复、CC 判断不值得写(见文件头 #3)。只在这个 sink 实例的生命周期里有效。 */
  const declined = new Set<string>()
  return {
    maybeTrigger(taskId, turns) {
      if (inFlight.has(taskId) || declined.has(taskId)) return
      const matter = deps.matters.get(taskId)
      if (!matter) return // Defensive: settleQuiet only ever passes a live task's own id.
      const chatId = deps.ownerChatId()
      if (!chatId) return // 没有主人聊天可落 —— 没配好主人之前,journal 这条也整条不存在。
      if (deps.journal.hasRecollection(taskId)) return // 持久去重(见文件头 #1):这件事已经写过一段回忆,哪怕跨了一次 daemon 重启。
      const overnight = crossedOvernight(matter.createdAt, deps.now?.() ?? Date.now())
      const returned = RETURNED_SIGNAL_UNAVAILABLE
      const cheapEval = deps.cheapEval()
      inFlight.add(taskId)
      void maybeRecollect({
        turns, returned, overnight,
        ask: cheapEval ? () => cheapEval(buildRecollectionPrompt({title: matter.title, turns, returned, overnight})) : undefined,
        write: text => {
          const id = deps.journal.recordRecollection({chatId, text, matterId: taskId})
          if (id === null) {
            // 空回复 = CC 决定这件事不值得写,不是错误(见文件头 #3)。留痕、
            // 不再问——不留痕会让"反复烧额度但没人知道"重演。
            declined.add(taskId)
            deps.log?.('MATTER_RECOLLECT', `${taskId}: 模型给了空回复,按它决定不写处理,不再问`)
          }
        },
        log: msg => deps.log?.('MATTER_RECOLLECT', `${taskId}: ${msg}`),
      })
        .catch(err => deps.log?.('MATTER_RECOLLECT', `maybeRecollect threw for ${taskId}: ${err instanceof Error ? err.message : err}`))
        .finally(() => { inFlight.delete(taskId) })
    },
  }
}
