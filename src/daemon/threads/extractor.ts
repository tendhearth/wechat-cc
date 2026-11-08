/**
 * 话题抽取(话题 T1,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T1)—— 每个自省拍一次。
 *
 * 增量:读这个 chat 新水位(entries_to_ts)之后的消息,主人的对话上再读 MatterLog 水位(work_cursor)之后做完的活的结论,
 * 交给便宜模型出话题 / 条目操作,照做,推进水位。历史一次读不完 ⇒ 按字数切批,一拍最多 MAX_ROUNDS 批。
 *
 * 失败:空输出 / 输出被想光了(EvalOutputExhaustedError)⇒ 同一批重试一次;再不行或解析失败 ⇒ 这一批不动水位,下一拍再来。
 */
import type { MessagesStore, MessageRecord } from '../../lib/messages-store'
import type { ThreadsStore, Facet } from '../../lib/threads-store'
import { buildExtractPrompt, parseExtractResponse, renderMessage, renderWork, ENTRIES_PER_TOPIC, type ExtractOp } from './extract-prompt'
import type { WorkResult } from './work-results'
import { isTopicMessage, isRoutineTopicText } from '../../domain/topic-noise'
import { withoutRoutineTopicNoise } from '../../domain/topic-match'

const FETCH_LIMIT = 500          // 一批最多从库里拿这么多条消息
const CONTEXT_TAIL = 30          // 水位之前的几条,只用来判断「又聊到了」
export const BATCH_CHARS = 24_000 // 一批对话 + 结论的字数上限(不含已有话题);输出要装得下这一批的全部操作
export const MAX_ROUNDS = 8       // 一拍最多跑几批
const EPOCH = '1970-01-01T00:00:00Z'

export interface ExtractorDeps {
  chatId: string
  messages: MessagesStore
  threads: ThreadsStore
  sdkEval: (prompt: string) => Promise<string>
  recordEvent: (reasoning: string) => Promise<void>
  log: (tag: string, line: string) => void
  /** agent 的活(只在主人的对话上给):水位之后做完了的结论 + 下一个水位。 */
  work?: (afterCursor: number) => { results: WorkResult[]; nextCursor: number }
}

/** 空输出 / 想光了 ⇒ 重试一次;别的错照抛(网络守护拒了之类,交给调用方记)。 */
async function evalWithRetry(sdkEval: (p: string) => Promise<string>, prompt: string, log: (t: string, l: string) => void): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await sdkEval(prompt)
      if (out && out.trim()) return out
      log('THREADS', `extract eval returned empty output (attempt ${attempt + 1})`)
    } catch (err) {
      if (!(err instanceof Error && (err.name === 'EvalOutputExhaustedError' || err.message.startsWith('eval_output_exhausted')))) throw err
      log('THREADS', `extract eval exhausted its output budget (attempt ${attempt + 1})`)
    }
  }
  return ''
}

/** 按字数取一批:至少一条;同一 ts 的几条不拆开(水位是 ts > since)。 */
function takeMessages(rows: MessageRecord[], budget: number): { taken: MessageRecord[]; used: number } {
  const taken: MessageRecord[] = []
  let used = 0
  for (const m of rows) {
    const len = isTopicMessage(m) ? renderMessage({ ts: m.ts, direction: m.direction, text: m.text }).length : 0
    const prev = taken[taken.length - 1]
    if (taken.length > 0 && used + len > budget && prev && prev.ts !== m.ts) break
    taken.push(m)
    used += len
  }
  return { taken, used }
}

export async function runThreadsExtraction(deps: ExtractorDeps): Promise<{ applied: number; skipped: number; rounds: number }> {
  let applied = 0, skipped = 0, rounds = 0
  for (; rounds < MAX_ROUNDS; ) {
    const state = await deps.threads.getExtractState(deps.chatId)
    const since = state.entriesToTs ?? EPOCH
    const recorded = await deps.messages.listSince(deps.chatId, since, FETCH_LIMIT)
    const { taken, used } = takeMessages(recorded, BATCH_CHARS)
    // CC 发的「任务 xxx 已答复」通知是 MatterLog 结论的复印件 ⇒ 不进(结论从 work 来);水位照样越过它们。
    const batch = taken.filter(isTopicMessage)
    const lastTs = taken.length > 0 ? taken[taken.length - 1]!.ts : null

    let work: WorkResult[] = []
    let workCursor = state.workCursor
    if (deps.work) {
      const w = deps.work(state.workCursor)
      let budget = Math.max(BATCH_CHARS - used, Math.floor(BATCH_CHARS / 4))
      for (const r of w.results) {
        const len = renderWork(r).length
        if (work.length > 0 && len > budget) break
        work.push(r); budget -= len
      }
      // 全取了 ⇒ 下一个水位就是它给的;只取了一截 ⇒ 停在取到的最后一条(后面的下一批再读)
      workCursor = work.length === w.results.length ? w.nextCursor : work[work.length - 1]!.cursor
    }

    if (batch.length === 0 && work.length === 0) {
      // 只有被跳过的行 / 没做完的活 ⇒ 水位照样往前走,别卡住
      const patch: { entriesToTs?: string; workCursor?: number } = {}
      if (lastTs) patch.entriesToTs = lastTs
      if (workCursor !== state.workCursor) patch.workCursor = workCursor
      if (patch.entriesToTs !== undefined || patch.workCursor !== undefined) await deps.threads.setExtractState(deps.chatId, patch)
      if (recorded.length > taken.length) { rounds++; continue }
      break
    }

    const tail = batch.length > 0
      ? (await deps.messages.listRange(deps.chatId, { limit: CONTEXT_TAIL, beforeTs: batch[0]!.ts })).filter(isTopicMessage)
      : []
    const existing = await deps.threads.list(deps.chatId)
    const entries = await deps.threads.entriesByThread(deps.chatId, { live: true })
    const prompt = buildExtractPrompt({
      newMessages: batch.map(m => ({ ts: m.ts, direction: m.direction, text: m.text })),
      ...(tail.length > 0 ? { contextTail: tail.map(m => ({ ts: m.ts, direction: m.direction, text: m.text })) } : {}),
      existingThreads: existing.map(t => ({
        id: t.id, title: t.title, facets: t.facets, tags: t.tags, aliases: t.aliases, summary: withoutRoutineTopicNoise({ ...t, entries: [] }).summary, description: t.description,
        entries: (entries.get(t.id) ?? []).filter(e => !isRoutineTopicText(`${e.line}\n${e.body}`)).slice(0, ENTRIES_PER_TOPIC).map(e => ({ id: e.id, kind: e.kind, line: e.line, due: e.due })),
      })),
      tagVocabulary: await deps.threads.tagVocabulary(30),
      ...(work.length > 0 ? { workResults: work.map(w => ({ matterId: w.matterId, title: w.title, project: w.project, state: w.state, ask: w.ask, result: w.result, at: w.at })) } : {}),
    })
    rounds++
    const raw = await evalWithRetry(deps.sdkEval, prompt, deps.log)
    const parsed = parseExtractResponse(raw)
    if (parsed === null) {
      deps.log('THREADS', `extract parse failed for ${deps.chatId}; watermark held at ${since} / work ${state.workCursor}`)
      break
    }
    const activeTs = lastTs ?? work[work.length - 1]?.at ?? new Date().toISOString()
    const r = await applyOps(deps, parsed.ops, activeTs, new Set(work.map(w => w.matterId)))
    applied += r.applied; skipped += r.skipped + parsed.dropped
    await deps.threads.setExtractState(deps.chatId, { ...(lastTs ? { entriesToTs: lastTs } : {}), workCursor })
    await deps.recordEvent(`batch=${batch.length} work=${work.length} ops=${parsed.ops.length} applied=${r.applied} skipped=${r.skipped + parsed.dropped}`)
    const moreChat = recorded.length > taken.length || recorded.length === FETCH_LIMIT
    const moreWork = deps.work ? workCursor !== state.workCursor && work.length > 0 : false
    if (!moreChat && !moreWork) break
  }
  return { applied, skipped, rounds }
}

async function applyOps(deps: ExtractorDeps, ops: ExtractOp[], activeTs: string, workMatters: Set<string>): Promise<{ applied: number; skipped: number }> {
  let applied = 0, skipped = 0
  const known = new Set((await deps.threads.list(deps.chatId)).map(t => t.id))
  /** 结论条目:指回的那件事必须是这一批交给它的;编的编号不认。 */
  const matterOf = (m?: string) => (m && workMatters.has(m) ? m : null)
  const sourceOf = (m?: string) => (matterOf(m) ? 'work' as const : 'chat' as const)
  for (const op of ops) {
    if (op.op === 'create_topic') {
      const id = await deps.threads.create({
        chatId: deps.chatId, title: op.title, summary: op.summary, ...(op.description?.trim() ? { description: op.description.trim() } : {}), facets: op.facets as [Facet, ...Facet[]], tags: op.tags.slice(0, 3),
        aliases: op.aliases, private: op.private, episodes: op.episode ? [op.episode] : [], lastActive: activeTs,
      })
      known.add(id)
      for (const e of op.entries) {
        if (isRoutineTopicText([e.line, e.body].filter(Boolean).join('\n'))) { skipped++; continue }
        await deps.threads.addEntry({ threadId: id, kind: e.kind, line: e.line, ...(e.body ? { body: e.body } : {}), ...(e.due ? { due: e.due } : {}), source: sourceOf(e.matter), matterId: matterOf(e.matter) })
      }
      applied++
    } else if (op.op === 'update_topic' || op.op === 'touch') {
      const t = known.has(op.id) ? await deps.threads.get(op.id) : null
      if (!t || t.chatId !== deps.chatId) { skipped++; continue }
      if (op.op === 'touch') {
        await deps.threads.update(op.id, { episodes: [...t.episodes, op.episode], lastActive: activeTs > t.lastActive ? activeTs : t.lastActive })
      } else {
        const { op: _op, id: _id, ...fields } = op
        await deps.threads.update(op.id, { ...fields, ...(fields.tags ? { tags: fields.tags.slice(0, 3) } : {}), lastActive: activeTs > t.lastActive ? activeTs : t.lastActive })
      }
      applied++
    } else if (op.op === 'add_entry') {
      if (!known.has(op.topic)) { skipped++; continue }
      if (isRoutineTopicText([op.line, op.body].filter(Boolean).join('\n'))) { skipped++; continue }
      await deps.threads.addEntry({ threadId: op.topic, kind: op.kind, line: op.line, ...(op.body ? { body: op.body } : {}), ...(op.due ? { due: op.due } : {}), source: sourceOf(op.matter), matterId: matterOf(op.matter) })
      const t = await deps.threads.get(op.topic)
      if (t && activeTs > t.lastActive) await deps.threads.update(op.topic, { lastActive: activeTs })
      applied++
    } else {
      const e = await deps.threads.getEntry(op.id)
      if (!e || !known.has(e.threadId)) { skipped++; continue }
      const { op: _op, id: _id, ...patch } = op
      if ((patch.line !== undefined || patch.body !== undefined) && isRoutineTopicText(`${patch.line ?? e.line}\n${patch.body ?? e.body}`)) { skipped++; continue }
      await deps.threads.updateEntry(op.id, patch)
      applied++
    }
  }
  return { applied, skipped }
}
