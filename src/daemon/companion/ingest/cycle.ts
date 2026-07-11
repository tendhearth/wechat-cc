/**
 * One ingest cycle: freshen decryption, run staleness-gated deterministic
 * builders, then drain a bounded slice of wxfacts extraction. All plugin work
 * goes through the MCP bridge (no agent turn); the LLM appears only inside
 * `runExtraction`. Each step is guarded by `hasTool` so a source that isn't
 * loaded/ready is simply skipped — the cycle degrades per-source, never throws.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runExtraction } from './extract'

export interface IngestBridge {
  call: (tool: string, input?: unknown) => Promise<string>
}

export interface CycleDeps {
  bridge: IngestBridge
  /** Is this plugin tool present + ready (from bridge.tools)? */
  hasTool: (tool: string) => boolean
  cheapEval: (prompt: string) => Promise<string>
  /** Max mtime (ms) of the decrypted source dbs; 0 if none. */
  sourceMaxMtime: () => number
  /** Source mtime processed by the previous cycle (in-memory across cycles). */
  lastSourceMtime: number
  /** Per-cycle extraction batch cap. */
  cap: number
  log?: (tag: string, msg: string) => void
}

export interface CycleReport {
  decrypted: boolean
  rebuilt: boolean
  indexed: boolean
  transcribed: boolean
  batches: number
  recorded: number
  /** The source mtime observed this cycle; the caller stores it as next lastSourceMtime. */
  newSourceMtime: number
}

/** Max mtime (ms) of wxvault's decrypted message dbs, or 0 if none exist. */
export function maxDecryptedMtime(stateDir: string): number {
  const dir = join(stateDir, 'plugin-data', 'wxvault', 'out', 'decrypted')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0   // dir absent (no decrypted output yet)
  }
  let max = 0
  for (const name of names) {
    if (!name.endsWith('.sqlite')) continue
    try {
      const m = statSync(join(dir, name)).mtimeMs
      if (m > max) max = m
    } catch { /* file vanished mid-scan */ }
  }
  return max
}

async function tryBuild(d: CycleDeps, tool: string): Promise<boolean> {
  if (!d.hasTool(tool)) return false
  try {
    await d.bridge.call(tool)
    return true
  } catch (e) {
    d.log?.('INGEST', `builder ${tool} failed (continuing): ${String(e)}`)
    return false
  }
}

export async function runIngestCycle(d: CycleDeps): Promise<CycleReport> {
  const report: CycleReport = {
    decrypted: false, rebuilt: false, indexed: false, transcribed: false,
    batches: 0, recorded: 0, newSourceMtime: d.lastSourceMtime,
  }

  // 1. Poke wxvault to force an incremental re-decrypt (it refreshes lazily).
  if (d.hasTool('overview')) {
    try { await d.bridge.call('overview'); report.decrypted = true } catch (e) {
      d.log?.('INGEST', `wxvault poke failed (continuing): ${String(e)}`)
    }
  }

  // 2. Deterministic builders — only when the decrypted source advanced.
  const mtime = d.sourceMaxMtime()
  report.newSourceMtime = mtime
  if (mtime > d.lastSourceMtime) {
    report.rebuilt = await tryBuild(d, 'rebuild')            // wxgraph
    report.indexed = await tryBuild(d, 'index_update')       // wxsearch
    report.transcribed = await tryBuild(d, 'voice_backfill') // wxmedia
  }

  // 3. wxfacts extraction — self-gates via {done:true} when caught up.
  if (d.hasTool('extraction_batch')) {
    const { batches, recorded } = await runExtraction({
      call: d.bridge.call, cheapEval: d.cheapEval, cap: d.cap, log: d.log,
    })
    report.batches = batches
    report.recorded = recorded
  }

  return report
}
