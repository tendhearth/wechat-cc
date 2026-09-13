/**
 * threads extractor — one isolated eval per introspect tick (spec D3).
 * Incremental: reads messages after the per-chat watermark, asks the
 * cheap model for thread ops, applies them, advances the watermark.
 * Parse failure → no watermark advance → retried next tick.
 */
import type { MessagesStore } from '../../lib/messages-store'
import type { ThreadsStore } from '../../lib/threads-store'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

const BATCH_LIMIT = 500     // cap one round; remainder picked up next tick
const CONTEXT_TAIL = 50     // pre-watermark messages for "reappeared?" judgment

export interface ExtractorDeps {
  chatId: string
  messages: MessagesStore
  threads: ThreadsStore
  sdkEval: (prompt: string) => Promise<string>
  recordEvent: (reasoning: string) => Promise<void>
  log: (tag: string, line: string) => void
}

export async function runThreadsExtraction(deps: ExtractorDeps): Promise<{ applied: number; skipped: number }> {
  const since = (await deps.threads.getWatermark(deps.chatId)) ?? '1970-01-01T00:00:00Z'
  const recorded = await deps.messages.listSince(deps.chatId, since, BATCH_LIMIT)
  if (recorded.length === 0) return { applied: 0, skipped: 0 }
  const lastTs = recorded[recorded.length - 1]!.ts
  // Task inputs and results belong to the workbench journal, not personal memory.
  // Advance over excluded rows too, so a task-only batch cannot stall extraction.
  const batch = recorded.filter(m => m.source !== 'workbench')
  if (batch.length === 0) {
    await deps.threads.setWatermark(deps.chatId, lastTs)
    return { applied: 0, skipped: 0 }
  }

  // Context tail stays before the original batch; task-origin rows are excluded here too.
  const tail = (await deps.messages.listRange(deps.chatId, { limit: CONTEXT_TAIL, beforeTs: recorded[0]!.ts }))
    .filter(m => m.source !== 'workbench')

  const existing = await deps.threads.list(deps.chatId)
  const prompt = buildExtractPrompt({
    newMessages: batch.map(m => ({ ts: m.ts, direction: m.direction, text: m.text })),
    ...(tail.length > 0 ? { contextTail: tail.map(m => ({ ts: m.ts, direction: m.direction, text: m.text })) } : {}),
    existingThreads: existing.map(t => ({ id: t.id, title: t.title, facets: t.facets, tags: t.tags, summary: t.summary })),
    tagVocabulary: await deps.threads.tagVocabulary(30),
  })
  const raw = await deps.sdkEval(prompt)
  const ops = parseExtractResponse(raw)
  if (ops === null) {
    deps.log('THREADS', `extract parse failed for ${deps.chatId}; watermark held at ${since}`)
    return { applied: 0, skipped: 0 }
  }

  let applied = 0, skipped = 0
  for (const op of ops) {
    if (op.op === 'create') {
      await deps.threads.create({ chatId: deps.chatId, title: op.title, summary: op.summary, facets: op.facets, tags: op.tags, private: op.private, episodes: [op.episode] })
      applied++
    } else {
      const t = await deps.threads.get(op.id)
      if (!t) { skipped++; continue }
      if (op.op === 'touch') {
        await deps.threads.update(op.id, { episodes: [...t.episodes, op.episode], lastActive: lastTs })
      } else {
        const { op: _op, id: _id, ...fields } = op
        await deps.threads.update(op.id, { ...fields, lastActive: lastTs })
      }
      applied++
    }
  }
  await deps.threads.setWatermark(deps.chatId, lastTs)
  await deps.recordEvent(`batch=${batch.length} ops=${ops.length} applied=${applied} skipped=${skipped}`)
  return { applied, skipped }
}
