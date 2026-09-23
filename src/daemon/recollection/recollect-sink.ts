/**
 * recollect-sink.ts — the daemon-side RecollectSink (src/core/matters/
 * recollection.ts) that src/core/workbench/service.ts's settleQuiet calls
 * into (via recollectOnce, right after reportOnce; fix round 1/5,
 * 2026-09-23, controller ruling: this must be wired up this round, not
 * left for a later task).
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
 * De-dup: in-memory only, per taskId, latched once a recollection is
 * actually written (journal.recordRecollection returns a non-null id).
 * This resets on daemon restart — the same bound already accepted for
 * Active.turnSeq itself and the reportedTurn/recollectedTurn dedup keys in
 * service.ts. Bounded because "story-worthy" is a narrow gate by design;
 * most tasks never cross it. (Duplicate calls for the *same* turnSeq are
 * already deduped one layer up, in service.ts's recollectOnce — this Set
 * guards a different thing: don't tell the same matter's story twice
 * across *different* turnSeqs.)
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
  const done = new Set<string>()
  return {
    maybeTrigger(taskId, turns) {
      if (done.has(taskId)) return
      const matter = deps.matters.get(taskId)
      if (!matter) return // Defensive: settleQuiet only ever passes a live task's own id.
      const chatId = deps.ownerChatId()
      if (!chatId) return // 没有主人聊天可落 —— 没配好主人之前,journal 这条也整条不存在。
      const overnight = crossedOvernight(matter.createdAt, deps.now?.() ?? Date.now())
      const returned = RETURNED_SIGNAL_UNAVAILABLE
      const cheapEval = deps.cheapEval()
      void maybeRecollect({
        turns, returned, overnight,
        ask: cheapEval ? () => cheapEval(buildRecollectionPrompt({title: matter.title, turns, returned, overnight})) : undefined,
        write: text => {
          const id = deps.journal.recordRecollection({chatId, text})
          if (id) done.add(taskId)
        },
        log: msg => deps.log?.('MATTER_RECOLLECT', `${taskId}: ${msg}`),
      }).catch(err => deps.log?.('MATTER_RECOLLECT', `maybeRecollect threw for ${taskId}: ${err instanceof Error ? err.message : err}`))
    },
  }
}
