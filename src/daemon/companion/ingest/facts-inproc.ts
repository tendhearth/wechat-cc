/**
 * Adapter: in-process FactsApi → the `(tool, input) => Promise<string>` call
 * shape `runExtraction` (extract.ts) expects from the MCP bridge. Serves
 * ONLY `extraction_batch`/`record_facts`/`supersede_facts` — the three tools
 * extract.ts uses — and JSON.stringify's the FactsApi result so extract.ts's existing
 * `call → JSON string` contract is unchanged. This is what lets
 * companion-ingest's auto-extraction loop keep working after the wxfacts
 * plugin is retired (no MCP subprocess, no `..`).
 */
import type { FactsApi } from '../../../core/knowledge/facts'

export function makeInProcFactsCall(
  facts: FactsApi,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): (tool: string, input?: unknown) => Promise<string> {
  return async (tool, input) => {
    const b = (input ?? {}) as Record<string, unknown>
    if (tool === 'extraction_batch') {
      return JSON.stringify(facts.nextBatch((b.contact as string | undefined) ?? null, (b.limit as number | undefined) ?? 40))
    }
    if (tool === 'record_facts') {
      return JSON.stringify(facts.record(b.batch_id as string, (b.facts as any[] | undefined) ?? [], nowFn()))
    }
    if (tool === 'supersede_facts') {
      return JSON.stringify(facts.supersede((b.pairs as Array<{ supersede: number; by: number }> | undefined) ?? [], nowFn()))
    }
    throw new Error('in-proc facts serves only extraction_batch/record_facts/supersede_facts, got ' + tool)
  }
}
