/**
 * Adapter: in-process FactsApi → the `(tool, input) => Promise<string>` call
 * shape `runExtraction` (extract.ts) expects from the MCP bridge. Serves
 * ONLY the tools extract.ts uses (`extraction_batch`/`record_facts`/
 * `supersede_facts` + the obligation-settlement pair
 * `active_obligations`/`settle_obligations`)
 * and JSON.stringify's the FactsApi result so extract.ts's existing
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
    // Obligation settlement (承诺了结闭环) — the two extra tools extract.ts's
    // per-batch settlement step uses. Only the in-proc adapter serves them;
    // on the legacy plugin bridge the step no-ops via its try/catch.
    if (tool === 'active_obligations') {
      const cf = facts.contactFacts(b.contact as string) as { by_kind?: Record<string, unknown[]> }
      return JSON.stringify({ obligations: cf.by_kind?.['obligation'] ?? [] })
    }
    if (tool === 'settle_obligations') {
      return JSON.stringify(facts.settleObligations(b.contact as string, (b.ids as number[] | undefined) ?? [], nowFn()))
    }
    throw new Error('in-proc facts serves only extraction_batch/record_facts/supersede_facts/active_obligations/settle_obligations, got ' + tool)
  }
}
