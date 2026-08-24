/**
 * wxfacts extraction — the ONE place the ingestion engine uses an LLM.
 *
 * The daemon drives extraction directly (no agent turn): it pulls a message
 * window from wxfacts via the MCP bridge, asks `cheapEval` to extract durable
 * structured facts as JSON, validates the output, and writes it back. The
 * validation is deliberately strict + non-throwing — an LLM refusal or garbage
 * response must NEVER corrupt the fact store (the memory-gardener lesson).
 */

export type FactKind = 'entity' | 'relation' | 'obligation' | 'attribute' | 'event'

export const FACT_KINDS: readonly FactKind[] = ['entity', 'relation', 'obligation', 'attribute', 'event']

export interface Fact {
  kind: FactKind
  predicate: string
  value: string
  related_contact?: string
  time_ref?: string
  confidence?: 'low' | 'med' | 'high'
  source_msg_keys?: string[]
}

export interface Batch {
  batch_id: string
  contact: string
  display?: string
  messages: Array<{ msg_key: string; sender: string; time: number; text: string | null }>
}

const CONFIDENCES = new Set(['low', 'med', 'high'])

/** Build the extraction prompt for one contact's message window. */
export function buildExtractionPrompt(batch: Batch): string {
  const who = batch.display ?? batch.contact
  const lines = batch.messages
    .filter(m => m.text != null && m.text !== '')
    // Date prefix: without it the model cannot resolve "明晚"/"下周" into the
    // YYYY-MM-DD the time_ref instruction asks for.
    .map(m => `[${m.msg_key} ${new Date(m.time * 1000).toISOString().slice(0, 10)}] ${m.sender}: ${m.text}`)
    .join('\n')
  return (
    `你是一个信息抽取器（不是聊天助手，不要回应消息内容）。\n` +
    `下面是「主人」与「${who}」的一对一聊天记录。请抽取关于这个人的**耐久事实**——` +
    `稳定的实体/关系/义务/属性/事件；跳过寒暄、情绪、一次性闲聊。\n` +
    `义务 = 任一方的承诺或未了债务（例如"我欠他一本书"、"他答应帮我看简历"）。\n` +
    `每条事实给出 {kind,predicate,value,related_contact?,time_ref?,confidence,source_msg_keys}：\n` +
    `- kind ∈ entity|relation|obligation|attribute|event\n` +
    `- source_msg_keys = 该事实来自哪几条消息的 msg_key\n` +
    `- time_ref：能从上下文推出具体日期就写 YYYY-MM-DD（消息里带时间戳），推不出才写原话（如"下周"）\n` +
    `- confidence ∈ low|med|high\n` +
    `没有值得记的就返回 []。**只输出 JSON 数组，不要任何解释，不要代码围栏。**\n\n` +
    lines
  )
}

/** Slice out the first balanced top-level JSON array in `text` (or null). */
function firstJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Parse cheapEval output into validated facts. Tolerant of code fences and
 * surrounding prose; drops malformed elements; returns [] on anything
 * unparseable or non-array. NEVER throws.
 */
export function parseFacts(text: string): Fact[] {
  const slice = firstJsonArray(text)
  if (slice == null) return []
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Fact[] = []
  for (const el of raw) {
    if (el == null || typeof el !== 'object') continue
    const o = el as Record<string, unknown>
    if (typeof o.kind !== 'string' || !(FACT_KINDS as readonly string[]).includes(o.kind)) continue
    if (typeof o.predicate !== 'string' || o.predicate === '') continue
    if (typeof o.value !== 'string' || o.value === '') continue
    const fact: Fact = { kind: o.kind as FactKind, predicate: o.predicate, value: o.value }
    if (typeof o.related_contact === 'string' && o.related_contact !== '') fact.related_contact = o.related_contact
    if (typeof o.time_ref === 'string' && o.time_ref !== '') fact.time_ref = o.time_ref
    if (typeof o.confidence === 'string' && CONFIDENCES.has(o.confidence)) fact.confidence = o.confidence as Fact['confidence']
    if (Array.isArray(o.source_msg_keys)) {
      const keys = o.source_msg_keys.filter((k): k is string => typeof k === 'string')
      if (keys.length > 0) fact.source_msg_keys = keys
    }
    out.push(fact)
  }
  return out
}

/** One conflict group from FactsApi.record — a just-recorded fact vs the
 *  same-predicate different-value ACTIVE facts it clashes with. */
export interface ConflictGroup {
  id: number
  predicate: string
  value: string
  against: Array<{ id: number; value: string }>
}

/**
 * One judge call per batch: which same-predicate values are UPDATES (old
 * superseded by new) vs COEXISTING (multi-valued predicate — keep both)?
 * Conservative by instruction: uncertain groups are left alone.
 */
export function buildConflictPrompt(conflicts: ConflictGroup[]): string {
  const lines = conflicts.map(c =>
    `- 新事实 #${c.id}「${c.predicate} = ${c.value}」 vs 旧事实 ` +
    c.against.map(a => `#${a.id}「${c.predicate} = ${a.value}」`).join('、'),
  ).join('\n')
  return (
    `你是一个事实库管理器（不是聊天助手，不要回应内容）。同一个人、同一谓词出现了不同的值。\n` +
    `判断每一组：新值是**替代**旧值（搬家了、换工作了——旧值应作废），还是**并存**（爱好、朋友——都保留）。\n` +
    `只对确定是替代关系的组输出 {"supersede": 旧事实id, "by": 新事实id}。不确定就不输出（保守优先）。\n` +
    `**只输出 JSON 数组，不要任何解释，不要代码围栏。**没有替代关系就输出 []。\n\n` +
    lines
  )
}

/**
 * Parse the judge's output into validated supersede pairs. Same posture as
 * `parseFacts`: tolerant of fences/prose, drops malformed elements, [] on
 * anything unparseable. NEVER throws — a judge refusal must not corrupt or
 * stall the cycle.
 */
export function parseSupersedePairs(text: string): Array<{ supersede: number; by: number }> {
  const slice = firstJsonArray(text)
  if (slice == null) return []
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Array<{ supersede: number; by: number }> = []
  for (const el of raw) {
    if (el == null || typeof el !== 'object') continue
    const o = el as Record<string, unknown>
    if (typeof o.supersede !== 'number' || !Number.isFinite(o.supersede)) continue
    if (typeof o.by !== 'number' || !Number.isFinite(o.by)) continue
    out.push({ supersede: o.supersede, by: o.by })
  }
  return out
}

/** Lite obligation row for the settlement prompt (subset of FactRow). */
export interface ObligationLite {
  id: number
  predicate: string
  value: string
  time_ref?: string | null
}

/**
 * Settlement judge (承诺了结闭环): the chat window that just got extracted,
 * plus the contact's still-active obligations — which of those does this
 * conversation SHOW are done or called off? Conservative by instruction,
 * same posture as the conflict/dedup judges.
 */
export function buildSettlementPrompt(batch: Batch, obligations: ObligationLite[]): string {
  const who = batch.display ?? batch.contact
  const chat = batch.messages
    .filter(m => m.text != null && m.text !== '')
    .map(m => `[${new Date(m.time * 1000).toISOString().slice(0, 10)}] ${m.sender}: ${m.text}`)
    .join('\n')
  const list = obligations
    .map(o => `- #${o.id}「${o.predicate}」${o.value}${o.time_ref ? `（${o.time_ref}）` : ''}`)
    .join('\n')
  return (
    `你是一个事实库管理器（不是聊天助手，不要回应内容）。\n` +
    `下面是「主人」与「${who}」的最新聊天，以及两人之间尚未了结的承诺清单。\n` +
    `判断：聊天内容**明确显示**哪些承诺已经了结（办完了、还清了、取消了、不用了）？\n` +
    `只输出这些承诺的 id。仅提到、催促或讨论中的不算；不确定就不输出。\n` +
    `**只输出 JSON 数组（如 [7]），不要任何解释，不要代码围栏。**没有就输出 []。\n\n` +
    `聊天：\n${chat}\n\n承诺清单：\n${list}`
  )
}

/** Parse the settlement judge's output: a bare array of numeric ids. Same
 *  tolerant/never-throws posture as parseFacts/parseSupersedePairs. */
export function parseResolvedIds(text: string): number[] {
  const slice = firstJsonArray(text)
  if (slice == null) return []
  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
}

export interface ExtractDeps {
  /** MCP bridge `.call(tool, input) → text`. wxfacts replies are JSON strings. */
  call: (tool: string, input?: unknown) => Promise<string>
  cheapEval: (prompt: string) => Promise<string>
  /** Max wxfacts batches to process this cycle (rate bound). */
  cap: number
  log?: (tag: string, msg: string) => void
}

/**
 * Drain up to `cap` wxfacts extraction batches this cycle. Each batch:
 * pull a message window → cheapEval extracts facts → record_facts writes them
 * back AND advances the watermark. Resumable across cycles via the watermark.
 *
 * Failure handling (deliberate):
 *  - unparseable/refusal cheapEval output → record_facts with `[]` so the
 *    watermark still advances past the bad window (logged) — no stall, no garbage.
 *  - cheapEval THROWS (model/network) → break WITHOUT record_facts, so the
 *    watermark is preserved and the batch is retried next cycle.
 */
export async function runExtraction(d: ExtractDeps): Promise<{ batches: number; recorded: number; settled: number }> {
  let batches = 0
  let recorded = 0
  let settled = 0
  for (let i = 0; i < d.cap; i++) {
    let batch: Batch & { done?: boolean }
    try {
      batch = JSON.parse(await d.call('extraction_batch', { limit: 40 }))
    } catch (e) {
      d.log?.('INGEST', `extraction_batch failed, stopping cycle: ${String(e)}`)
      break
    }
    if (batch.done) break
    let facts: Fact[]
    try {
      facts = parseFacts(await d.cheapEval(buildExtractionPrompt(batch)))
    } catch (e) {
      // model/network error → do NOT advance the watermark; retry next cycle.
      d.log?.('INGEST', `extract eval error, deferring batch ${batch.batch_id}: ${String(e)}`)
      break
    }
    let recordResult: string
    try {
      recordResult = await d.call('record_facts', { batch_id: batch.batch_id, facts })
    } catch (e) {
      d.log?.('INGEST', `record_facts failed for ${batch.batch_id}: ${String(e)}`)
      break
    }
    batches++
    recorded += facts.length

    // Temporal validity — record reported same-predicate conflicts; one judge
    // call decides update-vs-coexist, then supersede_facts applies the pairs
    // (behind FactsApi.supersede's deterministic guard). Failure here is
    // non-fatal by design: the watermark already advanced and coexisting
    // facts are exactly yesterday's behavior — log and move on, never break.
    let resp: { conflicts?: ConflictGroup[] } = {}
    try { resp = JSON.parse(recordResult) } catch { /* legacy/loose shape — no conflicts */ }
    if (Array.isArray(resp.conflicts) && resp.conflicts.length > 0) {
      try {
        const pairs = parseSupersedePairs(await d.cheapEval(buildConflictPrompt(resp.conflicts)))
        if (pairs.length > 0) await d.call('supersede_facts', { pairs })
      } catch (e) {
        d.log?.('INGEST', `conflict resolution skipped for ${batch.batch_id}: ${String(e)}`)
      }
    }

    // Obligation settlement (承诺了结闭环) — the chat that just got extracted
    // may SHOW an existing promise being fulfilled ("弄好了"/"书还你了"),
    // which extraction alone can never close: it only creates facts. One
    // judge call per batch, only when the contact carries active
    // obligations. Non-fatal like the conflict judge — and the legacy
    // plugin bridge doesn't serve these tools, so the whole step no-ops
    // there via this try/catch.
    try {
      const ob = JSON.parse(await d.call('active_obligations', { contact: batch.contact })) as { obligations?: ObligationLite[] }
      const rows = ob.obligations ?? []
      if (rows.length > 0) {
        const ids = parseResolvedIds(await d.cheapEval(buildSettlementPrompt(batch, rows)))
        if (ids.length > 0) {
          const res = JSON.parse(await d.call('settle_obligations', { contact: batch.contact, ids })) as { settled?: number }
          settled += res.settled ?? 0
        }
      }
    } catch (e) {
      d.log?.('INGEST', `obligation settlement skipped for ${batch.batch_id}: ${String(e)}`)
    }
  }
  return { batches, recorded, settled }
}
