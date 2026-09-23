/**
 * recollect-sink.ts — the daemon-side RecollectSink (src/core/matters/
 * recollection.ts) that src/core/workbench/service.ts's terminal-completion
 * branch calls into (via recollectOnce; fix round 1/5, 2026-09-23,
 * controller ruling: this must be wired up this round, not left for a later
 * task). Fix round 3 removed the settleQuiet call point that rounds 1-2 also
 * had — see recollectOnce's own doc comment in service.ts for why (it
 * conflicted with the persistent, per-matter dedup below: settleQuiet fires
 * on every quiet turn, so the FIRST qualifying moment — often an empty
 * overnight-only story — would use up the matter's one slot before any real
 * "back-and-forth" (turns/returned) ever had a chance to accumulate).
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
 *
 * holdBusy (fix round 3, evaluation M2): this is fire-and-forget — the call
 * site (`recollectOnce` in service.ts) never awaits `maybeTrigger`. Since
 * fix round 3, it only fires ONCE per matter, at the true terminal moment
 * (no next settle to retry from), so a lost in-flight call here is a
 * PERMANENT loss, not a delay — more important than round 1-2's version,
 * not less. This repo's rule for exactly this shape (a background task that
 * doesn't go through SessionManager) is `boot.holdBusy(label)` so idle
 * self-restart won't kill the daemon mid-call; see Bootstrap.holdBusy's own
 * doc comment (bootstrap/types.ts) and wire-intro.ts's `bg()` helper for the
 * idiom this copies.
 *
 * cheapEval timeout (post-final-review fix, "小的" item): holding `holdBusy`
 * across an UNBOUNDED cheapEval call is exactly the failure mode holdBusy
 * exists to prevent turning into something worse — agy's cheapEval upper
 * bound is `--print-timeout 600s`; a stuck call would hold the daemon
 * "busy" (idle self-restart blocked) for ten minutes with no log saying
 * why. Wrapped with `ProviderRegistry.getCheapEvalBudgetMs()` the same way
 * `wire-social.ts`'s disclosure gate does (`withTimeout` + `GATE_TIMEOUT_MS`
 * as the no-budget-given fallback, from `core/a2a-disclosure.ts` — reused,
 * not reinvented). A timeout is a real failure (not "no model available"),
 * so it goes through `maybeRecollect`'s own `ask()` catch → `log` path,
 * same as any other ask() rejection.
 */
import type {MatterStore} from '../../core/matters/store'
import {maybeRecollect, buildRecollectionPrompt, crossedOvernight, RETURNED_SIGNAL_UNAVAILABLE, type RecollectSink} from '../../core/matters/recollection'
import type {Journal} from '../../core/journal-store'
import type {CheapEval} from '../../core/agent-provider'
import {GATE_TIMEOUT_MS} from '../../core/a2a-disclosure'

export interface RecollectSinkDeps {
  matters: MatterStore
  journal: Journal
  /** 每次现取——同一个 registry 里谁能用会随执行者登录状态变,不缓存 provider 本身。 */
  cheapEval(): CheapEval | null
  /** journal 是全局伴侣日志,不按 matter 分——跟 wire-social.ts 里 recordVisit/recordPostcard 落主人默认聊天同一惯例。 */
  ownerChatId(): string | null
  /** 主人本地时区(IANA 时区名),给 crossedOvernight 算"本地日"用。见 recollection.ts 的 crossedOvernight 文档注释——别新造配置项,复用 companion 配置的 timezone 字段。 */
  timezone(): string
  /** cheapEval 的延迟预算(ms,`ProviderRegistry.getCheapEvalBudgetMs()`);不给就用 `GATE_TIMEOUT_MS`(见文件头「cheapEval timeout」一节)。 */
  cheapEvalBudgetMs?(): number
  now?(): number
  log?(tag: string, line: string): void
  /** 后台长任务的 busy 登记(见文件头「holdBusy」一节);不给就不登记(降级,不报错)。 */
  holdBusy?(label: string): () => void
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('recollect_ask_timeout')), ms) }),
    ])
  } finally {
    if (t) clearTimeout(t)
  }
}

/**
 * 退化回复(终审必判④a):模型答"无"/"没有"/"(空)"/"没什么可记的"这一
 * 类,字面上不是空字符串(`journal.recordRecollection` 的 trim-empty 守
 * 卫拦不住),但意思就是"它决定不写"——终审实测复现:matter 23:50 UTC
 * 建、00:10 终态,prompt 说"跨了一夜才有回复"(接给模型一个假前提),模
 * 型老实答"无",落库 `note='无'`、`hasRecollection` 翻真,那件事唯一的
 * 配额从此永久花在"无"这个字上。按"它决定不写"latch 并留痕,复用已经建
 * 好的 `declined` 那条路,不新开一条判断。
 */
const DEGENERATE_REPLIES = new Set(['无', '没有', '没什么可记的', '没什么好记的', '空', 'none', 'n/a', 'na', 'nothing', 'nil'])
function isDegenerateReply(text: string): boolean {
  const normalized = text.trim()
    .replace(/^[()（）[\]【】"'“”‘’、,,。.!!??\s]+|[()（）[\]【】"'“”‘’、,,。.!!??\s]+$/g, '')
    .toLowerCase()
  return normalized === '' || DEGENERATE_REPLIES.has(normalized)
}

export function makeRecollectSink(deps: RecollectSinkDeps): RecollectSink {
  /** 同一件事不许同时发起两次模型调用(见文件头 #2)。 */
  const inFlight = new Set<string>()
  /** 模型给过空回复(或退化回复)、CC 判断不值得写(见文件头 #3)。只在这个 sink 实例的生命周期里有效。 */
  const declined = new Set<string>()
  return {
    maybeTrigger(taskId, turns) {
      if (inFlight.has(taskId) || declined.has(taskId)) return
      const matter = deps.matters.get(taskId)
      if (!matter) return // Defensive: recollectOnce's terminal call site only ever passes a live task's own id (settleQuiet no longer calls this at all — fix round 3).
      const chatId = deps.ownerChatId()
      if (!chatId) return // 没有主人聊天可落 —— 没配好主人之前,journal 这条也整条不存在。
      if (deps.journal.hasRecollection(taskId)) return // 持久去重(见文件头 #1):这件事已经写过一段回忆,哪怕跨了一次 daemon 重启。
      const now = deps.now?.() ?? Date.now()
      const timezone = deps.timezone()
      const overnight = crossedOvernight(matter.createdAt, now, timezone)
      const elapsedHours = (now - matter.createdAt) / 3_600_000
      const returned = RETURNED_SIGNAL_UNAVAILABLE
      const cheapEval = deps.cheapEval()
      const budgetMs = deps.cheapEvalBudgetMs?.() ?? GATE_TIMEOUT_MS
      inFlight.add(taskId)
      // holdBusy(见文件头):这是终态那一拍唯一的一次机会,空闲自动重启若
      // 正好切在这一段中间,没有 token 挡着的话这条回忆会静默丢失、也不
      // 会有下一拍来补(不像 round 1-2 挂在 settleQuiet 时那样还有后续
      // 轮次兜底)。登记失败/放开失败都只当没登记(照 wire-intro.ts 的
      // holdBusy() 包法),不让这条降级反过来砸了回忆本身。
      let releaseBusy: () => void = () => {}
      try { releaseBusy = deps.holdBusy?.('recollect') ?? releaseBusy } catch { /* 登记失败:降级为不登记 */ }
      void maybeRecollect({
        turns, returned, overnight,
        ask: cheapEval ? () => withTimeout(cheapEval(buildRecollectionPrompt({title: matter.title, turns, returned, overnight, elapsedHours})), budgetMs) : undefined,
        write: text => {
          // 空回复(trim 后为空)与退化回复("无"/"没有"/"(空)" 这一类)是
          // CC 决定这件事不值得写,不是错误(见文件头 #3)——两者判据重叠
          // (isDegenerateReply 的空串分支覆盖了 recordRecollection 自己的
          // trim-empty 守卫),合成一条分支,不写两条几乎一样的日志。留
          // 痕、不再问——不留痕会让"反复烧额度但没人知道"重演。
          if (isDegenerateReply(text)) {
            declined.add(taskId)
            deps.log?.('MATTER_RECOLLECT', `${taskId}: 模型给了空/退化回复(${JSON.stringify(text.trim())}),按它决定不写处理,不再问`)
            return
          }
          const id = deps.journal.recordRecollection({chatId, text, matterId: taskId})
          if (id === null) {
            // 防御性兜底,理论上不可达:recordRecollection 唯一返回 null 的
            // 理由(trim 后为空)已经被上面 isDegenerateReply 的空串分支挡在
            // 前面。留着是"宁吵不静默"——万一以后 recordRecollection 加了
            // 别的返回 null 的理由,不会悄悄漏判、变成什么都不做也不留痕。
            declined.add(taskId)
            deps.log?.('MATTER_RECOLLECT', `${taskId}: journal 没有写成(recordRecollection 返回 null),按它决定不写处理,不再问`)
          }
        },
        log: msg => deps.log?.('MATTER_RECOLLECT', `${taskId}: ${msg}`),
      })
        .catch(err => deps.log?.('MATTER_RECOLLECT', `maybeRecollect threw for ${taskId}: ${err instanceof Error ? err.message : err}`))
        .finally(() => { inFlight.delete(taskId); try { releaseBusy() } catch { /* 放开失败:下一次重启窗口再说 */ } })
    },
  }
}
