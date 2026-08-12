/**
 * In-process indexer — Knowledge Kernel Task 6' (Option C pivot).
 *
 * Pure orchestration over the store + an injected `embed` function: pages
 * `source` via `store.listMessages`, embeds each page's texts, writes the
 * resulting vectors to `semantic` via `store.putSemantic`. Deliberately
 * knows NOTHING about subprocesses or HTTP — that's `embed-runner.ts`'s job
 * (the daemon wires a persistent-subprocess `embed` into this at call
 * sites); tests here inject a fake `embed` instead.
 *
 * Resume is a store-meta cursor keyed by model_id
 * (`indexer_cursor:<model_id>`, semantic.db meta via getMeta/setMeta — NOT
 * source.db's source_meta, which the source-adapter already owns for its
 * own, differently-scoped cursor). Keying by model_id means switching
 * models (or running two models side by side) each gets its own resume
 * point rather than fighting over one shared cursor — consistent with
 * provenance being per-model throughout the store (T1/T2).
 */
import type { Chunk, KnowledgeStore, SourceMsg } from './store'

const DEFAULT_BATCH = 200

function cursorKey(model_id: string): string {
  return `indexer_cursor:${model_id}`
}

export interface RunIndexerOpts {
  store: KnowledgeStore
  embed: (texts: string[]) => Promise<number[][]>
  model_id: string
  model_version: string
  batch?: number
}

export interface RunIndexerResult {
  indexed: number
}

export async function runIndexer(opts: RunIndexerOpts): Promise<RunIndexerResult> {
  const { store, embed, model_id, model_version } = opts
  const batchSize = opts.batch && opts.batch > 0 ? opts.batch : DEFAULT_BATCH

  let cursor = Number(store.getMeta(cursorKey(model_id)) ?? '0')
  let indexed = 0

  for (;;) {
    // Knowledge Graph inproc Task 1: source now holds every message kind
    // (voice/transfer/system/…), not just text — filter to 'text' so this
    // indexer keeps embedding only text, same as before source enrichment.
    const page = store.listMessages(cursor, batchSize, 'text')
    if (page.messages.length === 0) break

    const toEmbed = page.messages.filter((m: SourceMsg) => m.text.trim().length > 0)
    if (toEmbed.length > 0) {
      const vectors = await embed(toEmbed.map((m: SourceMsg) => m.text))
      const chunks: Chunk[] = toEmbed.map((m: SourceMsg, i: number) => ({
        msg_key: m.msg_key,
        conversation: m.conversation,
        sender: m.sender,
        time: m.time,
        kind: m.kind ?? 'text',
        text: m.text,
        vector: vectors[i]!,
      }))
      store.putSemantic(model_id, model_version, chunks)
      indexed += chunks.length
    }

    // Advance past the WHOLE page (including skipped empty-text rows) so
    // they aren't rescanned forever, mirroring the source-adapter's
    // cursor-advances-past-non-emitted-rows behavior.
    cursor = page.watermark
    store.setMeta(cursorKey(model_id), String(cursor))
  }

  return { indexed }
}
