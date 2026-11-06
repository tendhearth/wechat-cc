// Shared wire format with the family's check/runner.sh. Runs on the mini only.
import { mkdir, readFile, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cpus, loadavg } from 'node:os'

export function lockStale(info, now, alive) {
  const fields = Object.fromEntries(info.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  if (!fields.pid) return true
  return fields.pid === '0' ? now - Number(fields.since || 0) > 900 : !alive(Number(fields.pid))
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const read = async file => { try { return await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error } }
export async function acquireMachineLock({ path, lane, sha, pid = process.pid,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isAlive = alive, load = () => loadavg()[0], cores = cpus().length, log = console.log,
  onAcquired = () => {}, waitMs = 4 * 60 * 60 * 1000, loadWaitMs = 30 * 60 * 1000, pollMs = 5000 }) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{7,40}$/.test(sha)) throw Error('Invalid source commit')
  for (const value of [waitMs, loadWaitMs, pollMs, cores]) if (!Number.isFinite(value) || value <= 0) throw Error('Invalid machine gate limit')
  await mkdir(dirname(path), { recursive: true })
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
    if (lockStale(before, Math.floor(now() / 1000), isAlive)) {
      // Recheck before reclaiming: never delete a changed owner.
      if (await read(info) === before) await rm(path, { recursive: true, force: true })
      continue
    }
    log(`家族 check 在跑 ${before.match(/^owner=(.*)$/m)?.[1] ?? 'unknown'},等它`)
    if (now() - start >= waitMs) throw Error('Machine lock queue timed out')
    await sleep(Math.min(pollMs, waitMs - (now() - start)))
  }
  try {
    const loadStart = now()
    for (;;) {
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
