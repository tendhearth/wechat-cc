// src/core/knowledge/wxvault-refresh.ts
//
// Knowledge Kernel — bring wxvault's decrypted snapshot up to date BEFORE the
// source adapter reads it. The adapter reads `out/decrypted/*.sqlite`
// directly, which bypasses wxvault's own query-time refresh (wxvault ≥1.4
// re-decrypts changed DBs only when one of ITS tools is called). Without this
// step the knowledge store/graph/facts are only as fresh as the last time
// someone happened to query wxvault — in practice days stale.
//
// Freshness stays owned by wxvault: this only runs its `sync.py
// --changed-only` (re-decrypt just the DBs WeChat wrote since the snapshot;
// a no-op when nothing changed, and a silent no-op when the WeChat container
// is unreadable). wxvault's flock serializes it against its own MCP refreshes.
import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface MakeWxvaultRefreshOpts {
  pythonBin: string
  /** wxvault's resolved plugin dir (where sync.py lives). */
  pluginDir: string
  /** WXVAULT_STATE_DIR — the same dir wxvault's manifest spawns with. */
  stateDir: string
  /** Kill the refresh after this long; the adapter then reads the existing
   *  snapshot. A full first decrypt is ~10s; incremental is ~1-3s. */
  timeoutMs?: number
}

export interface WxvaultRefreshResult {
  /** wxvault's own verdict after the run: true = snapshot holds everything
   *  WeChat has written; null = wxvault couldn't read the WeChat container. */
  upToDate: boolean | null
}

export function makeWxvaultRefresh(opts: MakeWxvaultRefreshOpts): () => Promise<WxvaultRefreshResult> {
  const script = join(opts.pluginDir, 'sync.py')
  const env = { ...process.env, WXVAULT_STATE_DIR: opts.stateDir }
  return () => new Promise((resolve, reject) => {
    execFile(
      opts.pythonBin,
      [script, '--changed-only', '--json'],
      { env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || stdout || '').trim().split('\n').slice(-1)[0] ?? ''
          reject(new Error(`wxvault sync.py --changed-only failed: ${err.message}${tail ? ` — ${tail}` : ''}`))
          return
        }
        // --json prints the final status as the last stdout line; decrypt's
        // progress goes to the same stream before it.
        const last = String(stdout).trim().split('\n').pop() ?? ''
        try {
          const status = JSON.parse(last) as { up_to_date?: boolean | null }
          resolve({ upToDate: status.up_to_date ?? null })
        } catch {
          resolve({ upToDate: null })
        }
      },
    )
  })
}
