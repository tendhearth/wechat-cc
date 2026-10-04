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
  // PYTHONIOENCODING: wxvault prints Chinese progress/errors; on Windows the
  // default console codec (cp1252/GBK) can't encode them and the script dies
  // mid-print (caught by CI) — force UTF-8, which is also how we decode it.
  const env = { ...process.env, WXVAULT_STATE_DIR: opts.stateDir, PYTHONIOENCODING: 'utf-8' }
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

/**
 * 无人值守的刷新只在有「完全磁盘访问」时才去碰微信的容器。
 *
 * WHY(2026-10-04):没有 FDA 时,sync.py 读 ~/Library/Containers/com.tencent.xinWeChat
 * 会触发「"wechat-cc" 想访问其他 App 的数据」框;那一档的「允许」只管当前进程会话,
 * daemon 每重启一次(两天 39 次)就再弹一次 —— 而这个刷新每 5 分钟、开机第 1 秒都在跑。
 * 后台任务永远不该把系统框推到主人脸上:没有 FDA 就跳过(照旧读已有的快照),
 * 在日志 / health 里说清楚。探针本身不弹框(lib/fs-access.ts hasFullDiskAccess)。
 *
 * `hasFda` 返回 null(不知道 / 非 macOS)⇒ 照常刷新,不改变别的平台的行为。
 */
export function gateRefreshOnFullDiskAccess(
  refresh: () => Promise<WxvaultRefreshResult>,
  deps: { hasFda: () => boolean | null; log: (tag: string, line: string) => void; hint: string },
): () => Promise<WxvaultRefreshResult> {
  let lastSkipped = false
  return async () => {
    if (deps.hasFda() === false) {
      if (!lastSkipped) deps.log('KNOWLEDGE', `wxvault refresh skipped — no Full Disk Access; won't touch WeChat's container unattended. ${deps.hint}`)
      lastSkipped = true
      return { upToDate: null }
    }
    if (lastSkipped) deps.log('KNOWLEDGE', 'Full Disk Access present — wxvault refresh resumed')
    lastSkipped = false
    return refresh()
  }
}
