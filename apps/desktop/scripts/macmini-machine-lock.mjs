// Shared wire format with the family's check/runner.sh. Runs on the mini only.
import { mkdir, readFile, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { cpus, loadavg } from 'node:os'

export function lockStale(info, now, alive) {
  const fields = Object.fromEntries(info.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  if (!fields.pid) return true
  return fields.pid === '0' ? now - Number(fields.since || 0) > 900 : !alive(Number(fields.pid))
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const read = async file => { try { return await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error } }
const readInfoSync = file => {
  try { return readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}

async function reclaim(path, info, before, now, isAlive, assertRunning) {
  // Only reclaimers take this OS-backed lock. It is released if the process
  // dies, and ordinary family holders still need only mkdir and info.
  const Database = process.versions.bun
    ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync
  assertRunning()
  const guard = new Database(path + '.reclaim.sqlite')
  let tomb
  try {
    guard.exec('BEGIN IMMEDIATE')
    const current = readInfoSync(info)
    if (current !== before || !lockStale(current, Math.floor(now() / 1000), isAlive)) return false
    // A legacy runner can be between mkdir and writing its reservation.
    if (!/^pid=.+/m.test(current) && Date.now() - statSync(path).mtimeMs < 2000) return false
    const candidate = path + '.stale-' + randomUUID()
    renameSync(path, candidate)
    if (readInfoSync(join(candidate, 'info')) !== before) {
      throw Error('Machine lock owner changed during recovery: ' + candidate)
    }
    tomb = candidate
  } catch (error) {
    if (error.code === 'ENOENT') return true
    if (error.errcode === 5 || error.code === 'SQLITE_BUSY') return false
    throw error
  } finally { guard.close() }
  await rm(tomb, { recursive: true, force: true })
  return true
}

export async function acquireMachineLock({ path, lane, sha, pid = process.pid,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isAlive = alive, load = () => loadavg()[0], cores = cpus().length, log = console.log,
  onAcquired = () => {}, assertRunning = () => {}, waitMs = 4 * 60 * 60 * 1000, loadWaitMs = 30 * 60 * 1000, pollMs = 5000 }) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{7,40}$/.test(sha)) throw Error('Invalid source commit')
  for (const value of [waitMs, loadWaitMs, pollMs, cores]) if (!Number.isFinite(value) || value <= 0) throw Error('Invalid machine gate limit')
  await mkdir(dirname(path), { recursive: true })
  assertRunning()
  const info = join(path, 'info')
  const start = now()
  let content
  let released = false
  const release = async () => {
    if (released) return
    released = true
    if (await read(info) === content) await rm(path, { recursive: true, force: true })
  }
  for (;;) {
    assertRunning()
    try {
      // Publish pid in the same JS turn as mkdir, so signal cleanup is installed
      // before the first await after acquiring the lock.
      mkdirSync(path, { mode: 0o700 })
      content = `pid=${pid}\nsince=${Math.floor(now() / 1000)}\nowner=wechat-cc ${lane} ${sha.slice(0, 7)}\n`
      try { writeFileSync(info, content, { flag: 'wx' }) } catch (error) { await rm(path, { recursive: true, force: true }); throw error }
      onAcquired(release)
      break
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    const before = await read(info)
    assertRunning()
    if (lockStale(before, Math.floor(now() / 1000), isAlive)) {
      assertRunning()
      if (await reclaim(path, info, before, now, isAlive, assertRunning)) continue
    } else {
      log(`家族 check 在跑 ${before.match(/^owner=(.*)$/m)?.[1] ?? 'unknown'},等它`)
    }
    if (now() - start >= waitMs) throw Error('Machine lock queue timed out')
    await sleep(Math.min(pollMs, waitMs - (now() - start)))
  }
  try {
    const loadStart = now()
    for (;;) {
      assertRunning()
      const value = load()
      if (!Number.isFinite(value) || value < 0) throw Error('Invalid machine load')
      if (value <= cores * 1.5) break
      log(`Mini 负载 ${value} > ${cores} × 1.5,等它降下来`)
      if (now() - loadStart >= loadWaitMs) throw Error('Machine load gate timed out')
      await sleep(Math.min(pollMs, loadWaitMs - (now() - loadStart)))
    }
    return release
  } catch (error) { await release(); throw error }
}

export function machineGateOptions(env = process.env) {
  return { waitMs: Number(env.CC_UI_LOCK_WAIT_MS ?? 14400000), loadWaitMs: Number(env.CC_UI_LOAD_WAIT_MS ?? 1800000) }
}
