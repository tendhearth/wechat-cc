import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as nativeFs from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const BOOTSTRAP_VERSION = 1
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashName = /^[0-9a-f]{64}$/
const missing = error => { if (error.code !== 'ENOENT') throw error }
const dataModule = bytes => import('data:text/javascript;base64,' + bytes.toString('base64'))

export function sshLab() {
  if (process.platform !== 'darwin' || !process.env.SSH_CONNECTION) throw Error('UI lab requires an SSH session on a configured mini')
  const home = homedir()
  const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim()
  if (home === '/Users/home' && name === 'Home’s Mac mini') return { home, labHome: join(home, 'cc-ui-lab') }
  if (home === '/Users/homebot' && name === 'Homebot’s Mac mini') return { home, labHome: join(home, 'ci/cc-ui-lab') }
  throw Error('UI lab requires a configured mini')
}

export async function familyLock(home, lane, sha, lockSource, signal) {
  const { acquireMachineLock, machineGateOptions } = await dataModule(lockSource)
  return acquireMachineLock({ path: join(home, 'ci/lock'), lane, sha: sha.slice(0, 40),
    ...machineGateOptions(), load: () => 0, log: console.error,
    ...(signal && { assertRunning: () => signal.throwIfAborted(), sleep: ms => delay(ms, undefined, { signal }) }) })
}

async function readRequest(input) {
  const chunks = input[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  async function read(size) {
    const parts = []
    while (size > pending.length) {
      parts.push(pending)
      size -= pending.length
      const chunk = await chunks.next()
      if (chunk.done) throw Error('Truncated UI lab header')
      pending = Buffer.from(chunk.value)
    }
    parts.push(pending.subarray(0, size))
    pending = pending.subarray(size)
    return Buffer.concat(parts)
  }
  const size = (await read(4)).readUInt32BE()
  if (size === 0 || size > 1024 * 1024) throw Error('Invalid UI lab header size')
  const header = JSON.parse(await read(size))
  if (header.version !== BOOTSTRAP_VERSION) throw Error('Unsupported UI lab wire version; check lab-install')
  const { sha256, bundle, request } = header
  if (typeof bundle !== 'string' || typeof sha256 !== 'string' || !hashName.test(sha256) || digest(bundle) !== sha256) throw Error('Executor SHA-256 mismatch')
  const files = new Map()
  for (const [name, encoded] of JSON.parse(bundle)) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,100}\.(mjs|ts)$/.test(name) || files.has(name)) throw Error('Invalid executor file path')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) throw Error('Invalid executor file encoding')
    files.set(name, bytes)
  }
  for (const name of ['macmini-machine-lock.mjs', 'macmini-lab-executor.mjs']) {
    if (!files.has(name)) throw Error('Missing executor module: ' + name)
  }
  const body = Readable.from((async function* () {
    try {
      if (pending.length) yield pending
      for (;;) {
        const next = await chunks.next()
        if (next.done) break
        yield next.value
      }
    } finally { await chunks.return?.() }
  })())
  // Cancel the underlying SSH read too, including a pending iterator next().
  const destroy = body.destroy.bind(body)
  body.destroy = error => { if (!input.readableEnded) input.destroy?.(); return destroy(error) }
  return { sha256, files, request, body }
}

async function checkPath(fs, path, directory) {
  const stat = await fs.lstat(path)
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || await fs.realpath(path) !== path) throw Error('Unsafe executor cache path: ' + path)
  return stat
}

const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

export async function pruneExecutors(cache, fs = nativeFs, isAlive = alive) {
  const pinned = new Set()
  const entries = []
  for (const name of await fs.readdir(cache)) {
    const path = join(cache, name)
    const pin = /^([0-9a-f]{64})\.([1-9][0-9]*)\.[a-f0-9-]{36}\.pin$/.exec(name)
    if (pin && isAlive(Number(pin[2]))) pinned.add(pin[1])
    else if (pin) await fs.unlink(path).catch(missing)
    else if (hashName.test(name) || (/^\.stage-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.test(name) && !isAlive(Number(name.split('-')[1])))) {
      const stat = await fs.lstat(path)
      if (!stat.isDirectory() || await fs.realpath(path) !== path) continue
      entries.push({ name, path, used: hashName.test(name) ? stat.mtimeMs : -Infinity })
    }
  }
  entries.sort((a, b) => b.used - a.used || a.name.localeCompare(b.name))
  for (const [index, { name, path, used }] of entries.entries()) {
    if (pinned.has(name) || (index < 3 && Number.isFinite(used))) continue
    await fs.chmod(path, 0o700)
    await fs.rm(path, { recursive: true })
  }
}

export async function serve(input, { locate = sshLab, fs = nativeFs, lock = familyLock,
  load = path => import(pathToFileURL(path).href),
  timeoutMs = Number(process.env.CC_UI_JOB_TIMEOUT_MS ?? 14400000), now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('Invalid job timeout')
  const deadline = now() + timeoutMs
  const controller = new AbortController()
  const { signal } = controller
  const expire = () => {
    controller.abort()
    input.destroy?.()
  }
  let timer
  const armTimer = ms => {
    const slice = Math.min(ms, 2147483647)
    timer = setTimeout(ms > slice ? () => armTimer(Math.ceil(deadline - now())) : expire, slice)
  }
  armTimer(timeoutMs)
  const remaining = () => {
    const budget = Math.ceil(deadline - now())
    if (budget <= 0) expire()
    signal.throwIfAborted()
    return budget
  }
  let pin
  try {
    const { home, labHome } = locate()
    const { sha256, files, request, body } = await readRequest(input)
    const cache = join(await fs.realpath(labHome), 'executors')
    const dir = join(cache, sha256)
    remaining()
    const release = await lock(home, 'lab-executor', sha256, files.get('macmini-machine-lock.mjs'), signal)
    try {
      remaining()
      try { await fs.mkdir(cache, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await checkPath(fs, cache, true)
      if (!await fs.lstat(dir).catch(missing)) {
        const stage = await fs.mkdtemp(join(cache, `.stage-${process.pid}-`))
        try {
          for (const [name, bytes] of files) {
            remaining()
            await fs.writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o444 })
          }
          await fs.chmod(stage, 0o555)
          await fs.rename(stage, dir)
        } catch (error) {
          await fs.chmod(stage, 0o700)
          await fs.rm(stage, { recursive: true, force: true })
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        }
      }
      await checkPath(fs, dir, true)
      if ((await fs.readdir(dir)).length !== files.size) throw Error('Executor cache file count mismatch')
      for (const [name, bytes] of files) {
        remaining()
        const path = join(dir, name)
        await checkPath(fs, path, false)
        if (!(await fs.readFile(path)).equals(bytes)) throw Error('Executor cache content mismatch: ' + name)
      }
      await fs.utimes(dir, new Date(), new Date())
      const marker = join(cache, `${sha256}.${process.pid}.${randomUUID()}.pin`)
      await fs.writeFile(marker, '', { flag: 'wx', mode: 0o600 })
      pin = marker
      remaining()
      await pruneExecutors(cache, fs).catch(error => console.error('Executor cache retention:', error.message))
    } finally { await release() }
    remaining()
    const executor = await load(join(dir, 'macmini-lab-executor.mjs'))
    const budget = remaining()
    clearTimeout(timer)
    return await executor.run(request, body, dir, budget)
  } catch (error) {
    if (!signal.aborted) throw error
    console.error('UI lab job timed out')
    return 124
  } finally {
    clearTimeout(timer)
    if (pin) await fs.unlink(pin).catch(missing)
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'macmini-lab-bootstrap.mjs' &&
  import.meta.url === pathToFileURL(await nativeFs.realpath(process.argv[1])).href) process.exitCode = await serve(process.stdin)
