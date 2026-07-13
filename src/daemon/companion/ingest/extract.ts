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
    .map(m => `[${m.msg_key}] ${m.sender}: ${m.text}`)
    .join('\n')
  return (
    `你是一个信息抽取器（不是聊天助手，不要回应消息内容）。\n` +
    `下面是「主人」与「${who}」的一对一聊天记录。请抽取关于这个人的**耐久事实**——` +
    `稳定的实体/关系/义务/属性/事件；跳过寒暄、情绪、一次性闲聊。\n` +
    `义务 = 任一方的承诺或未了债务（例如"我欠他一本书"、"他答应帮我看简历"）。\n` +
    `每条事实给出 {kind,predicate,value,related_contact?,time_ref?,confidence,source_msg_keys}：\n` +
    `- kind ∈ entity|relation|obligation|attribute|event\n` +
    `- source_msg_keys = 该事实来自哪几条消息的 msg_key\n` +
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
export async function runExtraction(d: ExtractDeps): Promise<{ batches: number; recorded: number }> {
  let batches = 0
  let recorded = 0
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
    try {
      await d.call('record_facts', { batch_id: batch.batch_id, facts })
    } catch (e) {
      d.log?.('INGEST', `record_facts failed for ${batch.batch_id}: ${String(e)}`)
      break
    }
    batches++
    recorded += facts.length
  }
  return { batches, recorded }
}
