// Runs on the mini only. One read-only look at the things that have broken the
// lab before: a full disk, a lock nobody releases, snapshots that pile up, and a
// lab moved onto an external volume that launchd agents cannot read.
import * as nativeFs from 'node:fs/promises'
import { join } from 'node:path'
import { lockStale } from './macmini-machine-lock.mjs'

const GiB = 1024 ** 3
export const HEALTH_LIMITS = Object.freeze({ minFreeGiB: 20, maxLockHoldSec: 2 * 3600, maxSnapshotsPerKind: 4 })
const snapshotName = /^(app|browser)-[0-9a-f]{40}-[0-9]+$/
const defaultAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

function parseInfo(info) {
  return Object.fromEntries(info.trim().split('\n').filter(Boolean).map(line => {
    const i = line.indexOf('='); return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]
  }))
}

/** Never throws: a part it cannot read is reported as unknown with the error. */
export async function labHealth({ labHome, lockPath, fs = nativeFs, now = () => Date.now(), alive = defaultAlive,
  limits = HEALTH_LIMITS } = {}) {
  const warnings = []
  const health = { warnings }

  try {
    const s = await fs.statfs(labHome)
    health.diskFreeGiB = Math.round(s.bavail * s.bsize / GiB * 10) / 10
    if (health.diskFreeGiB < limits.minFreeGiB) warnings.push(`disk_low: ${health.diskFreeGiB} GiB free under ${labHome}`)
  } catch (error) { health.diskFreeGiB = null; warnings.push(`disk_unknown: ${error.code ?? error.message}`) }

  try {
    const real = await fs.realpath(labHome)
    health.labRealPath = real
    // launchd agents (Appium, CoreSimulator) get "Operation not permitted" on
    // /Volumes/* until someone grants access at the mini's own screen.
    if (real.startsWith('/Volumes/')) warnings.push(`lab_on_external_volume: ${real} — launchd agents cannot read it without a privacy grant`)
  } catch (error) { health.labRealPath = null; warnings.push(`lab_unreadable: ${error.code ?? error.message}`) }

  let info = null
  try { info = await fs.readFile(join(lockPath, 'info'), 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') warnings.push(`lock_unreadable: ${error.code ?? error.message}`)
    else {
      try { await fs.stat(lockPath); info = '' } catch (inner) { if (inner.code !== 'ENOENT') warnings.push(`lock_unreadable: ${inner.code}`) }
    }
  }
  if (info === null) health.lock = { held: false }
  else {
    const fields = parseInfo(info)
    const nowSec = Math.floor(now() / 1000)
    const since = Number(fields.since) || null
    const stale = lockStale(info, nowSec, alive)
    health.lock = { held: true, owner: fields.owner ?? fields.lane ?? null, pid: fields.pid ? Number(fields.pid) : null,
      heldSec: since ? nowSec - since : null, stale }
    if (stale) warnings.push(`lock_stale: owner=${health.lock.owner ?? '?'} pid=${health.lock.pid ?? '?'} (next job reclaims it)`)
    else if (health.lock.heldSec !== null && health.lock.heldSec > limits.maxLockHoldSec) {
      warnings.push(`lock_held_long: owner=${health.lock.owner ?? '?'} for ${Math.round(health.lock.heldSec / 60)} min`)
    }
  }

  try {
    const names = await fs.readdir(labHome)
    const counts = { app: 0, browser: 0 }
    for (const name of names) if (snapshotName.test(name)) counts[name.slice(0, name.indexOf('-'))]++
    health.snapshots = counts
    for (const [kind, n] of Object.entries(counts)) {
      if (n > limits.maxSnapshotsPerKind) warnings.push(`snapshots_piling_up: ${n} ${kind} snapshots (retention keeps referenced + newest 2)`)
    }
  } catch (error) { health.snapshots = null; warnings.push(`snapshots_unknown: ${error.code ?? error.message}`) }

  return health
}
