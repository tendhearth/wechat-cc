/**
 * Backup — snapshot the IRREPLACEABLE slice of the state dir (2026-08-24
 * decision: the product's body is its memory, and until now one disk
 * failure erased the bot's whole life).
 *
 * What goes in (≈2MB): wechat-cc.db (observations/milestones/threads/
 * events/messages), knowledge/facts.db (LLM-extracted facts — expensive to
 * recompute), knowledge/graph.db (small, saves a rebuild), memory/ +
 * memory-archive/ (the bot's own .md memory), and the root *.json configs.
 *
 * What stays out, deliberately:
 *  - internal-api-info.json — carries the loopback token; a backup that
 *    leaves the machine must never carry credentials.
 *  - knowledge/semantic.db (~240MB) + source.db (~20MB) — derivable: the
 *    indexer re-embeds and the source adapter re-ingests from wxvault.
 *  - plugin-data/ (~1GB) — wxvault re-decrypts from the local WeChat store.
 *  - logs / inbox media / docs — operational residue, not memory.
 *
 * Live-db safety: sqlite files are snapshotted with VACUUM INTO, which is
 * transactionally consistent against a running daemon (WAL) — never a raw
 * file copy of a hot db.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Database } from 'bun:sqlite'

export const BACKUP_DIRNAME = 'backups'
const BACKUP_PREFIX = 'wechat-cc-backup-'

/** Root-level json files copied into the backup. Allowlist, not "everything
 *  except secrets": a future secret-bearing json must not leak in by default. */
const CONFIG_JSON_ALLOWLIST = [
  'agent-config.json', 'access.json', 'care_ledger.json', 'chat_prefs.json',
  'garden_state.json', 'guard.json', 'health-incidents.json',
  join('companion', 'config.json'), 'context_tokens.json', 'federated-grant.json',
  'a2a-info.json', 'mailbox-key.json', 'stt-config.json', 'voice-config.json',
  'user_account_ids.json', join('plugins', 'plugins.json'),
]

const SQLITE_SNAPSHOTS = ['wechat-cc.db', join('knowledge', 'facts.db'), join('knowledge', 'graph.db')]
const DIR_COPIES = ['memory', 'memory-archive']

function stamp(now: Date): string {
  return now.toISOString().replace(/[:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

/** VACUUM INTO — consistent snapshot of a possibly-live WAL database. */
function snapshotSqlite(src: string, dest: string): void {
  const db = new Database(src, { readonly: true })
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

export interface CreateBackupResult {
  path: string
  bytes: number
  entries: string[]
}

export async function createBackup(opts: { stateDir: string; outDir?: string; now?: Date }): Promise<CreateBackupResult> {
  const now = opts.now ?? new Date()
  const outDir = opts.outDir ?? join(opts.stateDir, BACKUP_DIRNAME)
  mkdirSync(outDir, { recursive: true })

  const staging = mkdtempSync(join(tmpdir(), 'wcc-backup-'))
  const entries: string[] = []
  try {
    for (const rel of SQLITE_SNAPSHOTS) {
      const src = join(opts.stateDir, rel)
      if (!existsSync(src)) continue
      const dest = join(staging, rel)
      mkdirSync(join(dest, '..'), { recursive: true })
      snapshotSqlite(src, dest)
      entries.push(rel)
    }
    for (const rel of DIR_COPIES) {
      const src = join(opts.stateDir, rel)
      if (!existsSync(src)) continue
      cpSync(src, join(staging, rel), { recursive: true })
      entries.push(rel)
    }
    for (const rel of CONFIG_JSON_ALLOWLIST) {
      const src = join(opts.stateDir, rel)
      if (!existsSync(src)) continue
      cpSync(src, join(staging, rel))
      entries.push(rel)
    }

    const outPath = join(outDir, `${BACKUP_PREFIX}${stamp(now)}.tar.gz`)
    const tar = Bun.spawnSync(['tar', '-czf', outPath, '-C', staging, ...readdirSync(staging)])
    if (tar.exitCode !== 0) {
      throw new Error(`tar failed: ${tar.stderr.toString().slice(0, 500)}`)
    }
    return { path: outPath, bytes: statSync(outPath).size, entries }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export interface BackupEntry {
  path: string
  bytes: number
  mtimeMs: number
}

export function listBackups(stateDir: string, outDir?: string): BackupEntry[] {
  const dir = outDir ?? join(stateDir, BACKUP_DIRNAME)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter(n => n.startsWith(BACKUP_PREFIX) && n.endsWith('.tar.gz'))
    .map(n => {
      const p = join(dir, n)
      const st = statSync(p)
      return { path: p, bytes: st.size, mtimeMs: st.mtimeMs }
    })
    .sort((a, b) => basename(b.path).localeCompare(basename(a.path)))   // stamp in name → newest first
}

/** Delete all but the newest `keep`. Returns how many were removed. */
export function pruneBackups(stateDir: string, keep: number, outDir?: string): number {
  const all = listBackups(stateDir, outDir)
  const excess = all.slice(Math.max(0, keep))
  for (const e of excess) rmSync(e.path, { force: true })
  return excess.length
}

export type RestoreResult =
  | { ok: true; undoDir: string; restored: string[] }
  | { ok: false; error: 'daemon_running' | 'bad_archive'; detail?: string }

/**
 * Restore a backup over the state dir. Refuses while the daemon runs (the
 * live process holds WAL handles and in-memory state that would immediately
 * re-diverge). Everything about to be replaced is first moved into
 * `<stateDir>/backups/restore-undo-<ts>/` so a bad restore is reversible.
 */
export async function restoreBackup(opts: {
  stateDir: string
  file: string
  now?: Date
  /** Injectable probe — production passes a real internal-api liveness check. */
  daemonRunning?: () => boolean
}): Promise<RestoreResult> {
  if (opts.daemonRunning?.()) return { ok: false, error: 'daemon_running' }
  if (!existsSync(opts.file)) return { ok: false, error: 'bad_archive', detail: 'file not found' }

  const staging = mkdtempSync(join(tmpdir(), 'wcc-restore-'))
  try {
    const untar = Bun.spawnSync(['tar', '-xzf', opts.file, '-C', staging])
    if (untar.exitCode !== 0) {
      return { ok: false, error: 'bad_archive', detail: untar.stderr.toString().slice(0, 500) }
    }
    const undoDir = join(opts.stateDir, BACKUP_DIRNAME, `restore-undo-${stamp(opts.now ?? new Date())}`)
    mkdirSync(undoDir, { recursive: true })
    const restored: string[] = []
    for (const name of readdirSync(staging)) {
      const target = join(opts.stateDir, name)
      if (existsSync(target)) {
        renameSync(target, join(undoDir, name))
      }
      cpSync(join(staging, name), target, { recursive: true })
      restored.push(name)
    }
    return { ok: true, undoDir, restored }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
