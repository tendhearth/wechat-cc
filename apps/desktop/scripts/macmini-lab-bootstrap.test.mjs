import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { pruneExecutors, serve } from './macmini-lab-bootstrap.mjs'
import { executorBundle, executorHeader, executorInvocation, sendSnapshot } from './macmini-lab-client.mjs'
import { installBootstrap } from './macmini-lab-install.mjs'
import { main } from './macmini-ui.mjs'
import { acquireMachineLock } from './macmini-machine-lock.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bundled = executorBundle()
const hash = bundled.sha256
const testHeader = (pack = bundled) => executorHeader({ kind: 'ui' }, pack)
const input = (pack, body = '') => Readable.from([testHeader(pack), Buffer.from(body)])

async function fixture(run) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cc-lab-bootstrap-')))
  const labHome = join(home, 'lab')
  const cache = join(labHome, 'executors')
  await fs.mkdir(labHome)
  let previous = Promise.resolve()
  const lock = vi.fn(async () => {
    const before = previous
    let release
    previous = new Promise(resolve => { release = resolve })
    await before
    return release
  })
  const load = vi.fn(async () => ({ run: async (_request, body) => {
    for await (const _chunk of body) { /* drain the supplied request */ }
    return 17
  } }))
  const options = { locate: () => ({ home, labHome }), fs, lock, load }
  try { await run({ home, labHome, cache, options, lock, load }) }
  finally {
    if ((await fs.lstat(cache).catch(() => null))?.isDirectory()) {
      for (const item of await fs.readdir(cache, { withFileTypes: true })) {
        if (item.isDirectory()) await fs.chmod(join(cache, item.name), 0o700)
      }
    }
    await fs.rm(home, { recursive: true, force: true })
  }
}

test('bundles deterministic, unmodified bytes for the executor and test harness', async () => {
  expect(executorBundle()).toEqual(bundled)
  expect(hash).toBe(digest(bundled.bundle))
  const files = new Map(JSON.parse(bundled.bundle))
  expect([...files.keys()]).toEqual([
    'cc-alive-shots.spec.ts', 'design-unify-shots.spec.ts', 'macmini-app-snapshot.mjs',
    'macmini-browser-snapshot.mjs', 'macmini-embedded-ui.mjs', 'macmini-job-lifecycle.mjs',
    'macmini-lab-executor.mjs', 'macmini-lab-health.mjs', 'macmini-machine-lock.mjs', 'macmini-snapshot-retention.mjs',
    'macmini-source-manifest.mjs', 'macmini-ui-app.mjs', 'macmini-ui-protocol.mjs', 'macmini-ui-remote.mjs',
    'playwright.config.ts', 'roster-fixture.ts', 'task-detail-minimal.spec.ts',
  ])
  expect(Buffer.from(files.get('roster-fixture.ts'), 'base64')).toEqual(await fs.readFile(new URL('../playwright/roster-fixture.ts', import.meta.url)))
  expect(executorBundle(url => Buffer.from(url.pathname)).sha256).not.toBe(hash)
})

test('bootstrap rejects bad hashes, traversal, and truncated frames before locking or loading', () => fixture(async ({ options, lock, load, labHome }) => {
  await expect(serve(input({ ...bundled, sha256: '1'.repeat(64) }), options)).rejects.toThrow('SHA-256')
  const bundle = JSON.stringify([['../escape.mjs', '']])
  await expect(serve(input({ bundle, sha256: digest(bundle) }), options)).rejects.toThrow('Invalid executor file path')
  await expect(serve(Readable.from([testHeader().subarray(0, 25)]), options)).rejects.toThrow('Truncated')
  expect(lock).not.toHaveBeenCalled()
  expect(load).not.toHaveBeenCalled()
  expect(await fs.readdir(labHome)).toEqual([])
}))

test.each(['cache', 'hash', 'file'])('bootstrap refuses an escaping symlink at the %s path', layer => fixture(async ({ home, cache, options, load }) => {
  const outside = join(home, 'outside')
  await fs.mkdir(outside)
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  if (layer === 'cache') await fs.symlink(outside, cache, linkType)
  else {
    await fs.mkdir(cache)
    if (layer === 'hash') await fs.symlink(outside, join(cache, hash), linkType)
    else {
      await fs.mkdir(join(cache, hash))
      for (const [name, bytes] of JSON.parse(bundled.bundle)) {
        await fs.writeFile(join(cache, hash, name), Buffer.from(bytes, 'base64'))
      }
      const path = join(cache, hash, 'macmini-lab-executor.mjs')
      await fs.unlink(path)
      await fs.symlink(outside, path, linkType)
    }
  }
  await expect(serve(input(), options)).rejects.toThrow('Unsafe executor cache path')
  expect(await fs.readdir(outside)).toEqual([])
  expect(load).not.toHaveBeenCalled()
}))

test('concurrent and repeated requests publish once, with unchanged content on a cache hit', () => fixture(async ({ home, labHome, cache, options, load }) => {
  // Exercise the realpath layout used when the lab is on an external volume.
  const alias = join(home, 'external-lab-alias')
  await fs.symlink(labHome, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const rename = vi.fn(fs.rename)
  const invocation = { ...options, locate: () => ({ home, labHome: alias }), fs: { ...fs, rename } }
  expect(await Promise.all([serve(input(), invocation), serve(input(), invocation)])).toEqual([17, 17])
  expect(await serve(input(), invocation)).toBe(17)
  expect(rename).toHaveBeenCalledTimes(1)
  expect(load.mock.calls.map(([path]) => path)).toEqual(Array(3).fill(join(cache, hash, 'macmini-lab-executor.mjs')))
  expect(await fs.readdir(cache)).toEqual([hash])
  if (process.platform !== 'win32') expect((await fs.stat(join(cache, hash))).mode & 0o777).toBe(0o555)
  const path = join(cache, hash, 'macmini-lab-executor.mjs')
  await fs.chmod(path, 0o644)
  await fs.writeFile(path, 'changed')
  await expect(serve(input(), invocation)).rejects.toThrow('cache content mismatch')
  expect(load).toHaveBeenCalledTimes(3)
}))

test('wire body is delivered byte for byte across split prefix and header boundaries', () => fixture(async ({ options }) => {
  const header = executorHeader({ kind: 'app-snapshot', sha: 'a'.repeat(40) })
  const bytes = Buffer.from([0, 255, 127, 255, 10])
  const wire = Readable.from([header.subarray(0, 3), header.subarray(3, 19),
    Buffer.concat([header.subarray(19), bytes.subarray(0, 1)]), bytes.subarray(1)])
  await serve(wire, { ...options, load: async () => ({ run: async (request, body) => {
    expect(request).toEqual({ kind: 'app-snapshot', sha: 'a'.repeat(40) })
    const chunks = []
    for await (const chunk of body) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(bytes)
  } }) })
}))

test('the bootstrap times out even while waiting for a partial request header', () => fixture(async ({ options, lock, load }) => {
  const wire = new PassThrough()
  wire.write(testHeader().subarray(0, 19))
  const close = setTimeout(() => wire.end(), 250)
  try {
    expect(await serve(wire, { ...options, timeoutMs: 25 })).toBe(124)
    expect(wire.destroyed).toBe(true)
    expect(lock).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  } finally { clearTimeout(close); wire.destroy() }
}))

test('the job budget bounds the real delivery queue without releasing a family holder', () => fixture(async ({ home, options, load }) => {
  const lockPath = join(home, 'ci', 'lock')
  await fs.mkdir(lockPath, { recursive: true })
  const owner = `pid=${process.pid}\nsince=1\nowner=family full\n`
  await fs.writeFile(join(lockPath, 'info'), owner)
  // Use the actual filesystem lock, bypassing only the bootstrap's Node data URL import.
  const log = vi.fn()
  const lock = (_home, lane, sha, _source, signal) => acquireMachineLock({
    path: lockPath, lane, sha: sha.slice(0, 40), waitMs: 400, log, load: () => 0,
    assertRunning: () => signal?.throwIfAborted(),
    sleep: ms => delay(ms, undefined, { signal }),
  })
  expect(await serve(input(), { ...options, lock, timeoutMs: 100 })).toBe(124)
  expect(log).toHaveBeenCalledWith('家族 check 在跑 family full,等它')
  expect(load).not.toHaveBeenCalled()
  expect(await fs.readFile(join(lockPath, 'info'), 'utf8')).toBe(owner)
}))

test('the executor receives the remaining budget after delivery queue and import', () => fixture(async ({ options, lock }) => {
  let time = 100
  const run = vi.fn(async () => 17)
  expect(await serve(input(), { ...options, timeoutMs: 1000, now: () => time,
    lock: async (...args) => {
      time += 325
      return lock(...args)
    },
    load: async () => { time += 27; return { run } },
  })).toBe(17)
  expect(run.mock.calls[0][3]).toBe(648)
}))

test('retention keeps three most recently used dirs and older live executors, skipping symlinks and legacy dirs', () => fixture(async ({ home, cache }) => {
  await fs.mkdir(cache)
  const entries = Array.from({ length: 6 }, (_, index) => String(index).repeat(64))
  for (const [index, name] of entries.entries()) {
    const path = join(cache, name)
    await fs.mkdir(path)
    await fs.writeFile(join(path, 'executor.mjs'), 'cache')
    await fs.utimes(path, 100 + index, 100 + index)
    await fs.chmod(path, 0o555)
  }
  const pin = `${entries[0]}.42.00000000-0000-0000-0000-000000000000.pin`
  await fs.writeFile(join(cache, pin), '')
  await fs.writeFile(join(cache, `${entries[1]}.43.00000000-0000-0000-0000-000000000000.pin`), '')
  const symlink = 'a'.repeat(64)
  await fs.symlink(home, join(cache, symlink), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.mkdir(join(cache, 'browser-executor'))
  await pruneExecutors(cache, fs, pid => pid === 42)
  expect((await fs.readdir(cache)).sort()).toEqual([entries[0], ...entries.slice(3), pin, symlink, 'browser-executor'].sort())
}))

test('install logs before atomic replacement, backs up old bootstrap, and keeps all legacy entrypoints', () => fixture(async ({ home, labHome, lock }) => {
  const entries = ['run.mjs', 'browser-run.mjs', 'app-run.mjs', 'browser-snapshot.mjs', 'app-snapshot.mjs']
  for (const entry of entries) await fs.writeFile(join(labHome, entry), 'legacy ' + entry)
  for (const lane of ['desktop', 'browser', 'app']) await fs.mkdir(join(labHome, lane + '-executor'))
  const target = join(labHome, 'macmini-lab-bootstrap.mjs')
  const original = Buffer.from('export const BOOTSTRAP_VERSION = 1\n')
  const next = Buffer.from('export const BOOTSTRAP_VERSION = 2\n')
  const logs = []
  const dependencies = { home, labHome, lock, fs, log: line => logs.push(JSON.parse(line)), lockSource: Buffer.alloc(0) }
  await installBootstrap({ ...dependencies, bootstrap: original })
  expect(logs[0].previous).toBeNull()
  if (process.platform === 'win32') await fs.chmod(target, 0o644) // The installer runs on macOS.
  const rename = vi.fn(async (...args) => {
    expect(await fs.readFile(target)).toEqual(original)
    expect(logs[1]).toMatchObject({ previous: { version: '1' }, next: { version: '2' } })
    await fs.rename(...args)
  })
  await installBootstrap({ ...dependencies, bootstrap: next, fs: { ...fs, rename } })
  expect(rename).toHaveBeenCalledTimes(2)
  expect(await fs.readFile(target)).toEqual(next)
  expect(await fs.readFile(logs[1].backup)).toEqual(original)
  expect(lock.mock.calls.map(([, lane]) => lane)).toEqual(['lab-install', 'lab-install'])
  for (const entry of entries) expect(await fs.readFile(join(labHome, entry), 'utf8')).toBe('legacy ' + entry)
  for (const lane of ['desktop', 'browser', 'app']) expect((await fs.stat(join(labHome, lane + '-executor'))).isDirectory()).toBe(true)
}))

test('lab-install targets only a known mini and sends the checked bootstrap via fake SSH', () => {
  const spawn = vi.fn(() => ({ status: 0 }))
  expect(main(['node', 'entry', 'lab-install', 'homebot'], {}, spawn)).toBe(0)
  expect(spawn.mock.calls[0][1]).toContain('homebot-mac-mini')
  expect(spawn.mock.calls[0][1].at(-1)).toContain('installFromStdin')
  expect(spawn.mock.calls[0][1].at(-1)).not.toContain('还没装')
  const payload = JSON.parse(spawn.mock.calls[0][2].input)
  expect(digest(Buffer.from(payload.bootstrap, 'base64'))).toBe(payload.sha256)
  expect(() => main(['node', 'entry', 'lab-install', 'localhost'], {}, spawn)).toThrow('target')
  expect(spawn).toHaveBeenCalledTimes(1)
})

test.skipIf(process.platform === 'win32')('new UI clients show the selected install command when the launcher file is missing', () => fixture(async ({ labHome }) => {
  const ssh = (_file, args) => {
    const command = args.at(-1).replaceAll('/Users/homebot/ci/cc-ui-lab', labHome)
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    expect(result.stderr).toContain('这台 mini 还没装 lab 启动器')
    expect(result.stderr).toContain('node apps/desktop/scripts/macmini-ui.mjs lab-install homebot')
    expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
    return result
  }
  expect(main(['node', 'entry', 'browser', 'homebot'], {}, ssh)).toBe(69)
}))

test('a snapshot sender preserves the missing launcher exit even if SSH closes stdin first', async () => {
  const env = {}
  const transport = executorInvocation('browser', 'home', undefined, env)
  const kill = vi.fn()
  const spawnProcess = () => {
    const stdin = new Writable({ write(_chunk, _encoding, done) {
      done(Object.assign(Error('closed stdin'), { code: 'EPIPE' }))
      setImmediate(() => ssh.emit('close', 69))
    } })
    const ssh = Object.assign(new EventEmitter(), { stdin, kill })
    return ssh
  }
  expect(await sendSnapshot({ transport, payload: Buffer.alloc(0), env, spawnProcess })).toBe(69)
})

test.each(['browser-snapshot', 'app-verified-snapshot', 'app-snapshot'])('snapshot sender frames %s and preserves its existing payload', async kind => {
  const env = { PATH: '/fake' }
  const request = { kind, sha: 'b'.repeat(40) }
  const transport = executorInvocation('browser', 'home', undefined, env, request)
  const bytes = Buffer.from([0, 1, 98, 255])
  const chunks = []
  const spawnProcess = vi.fn(file => {
    const proc = Object.assign(new EventEmitter(), { kill: vi.fn() })
    if (file.endsWith('/git')) {
      proc.stdout = Readable.from([bytes])
      proc.stdout.on('end', () => proc.emit('close', 0))
    } else {
      proc.stdin = new PassThrough()
      proc.stdin.on('data', chunk => chunks.push(chunk))
      proc.stdin.on('finish', () => proc.emit('close', 0))
    }
    return proc
  })
  await sendSnapshot({ transport, spawnProcess, env,
    ...(kind === 'app-snapshot' ? { archiveArgs: ['archive'] } : { payload: bytes }) })
  expect(spawnProcess.mock.calls[0][1].at(-1)).toContain('/macmini-lab-bootstrap.mjs')
  const sent = Buffer.concat(chunks)
  const length = sent.readUInt32BE(0)
  expect(JSON.parse(sent.subarray(4, 4 + length))).toMatchObject({ request, sha256: hash })
  expect(sent.subarray(4 + length)).toEqual(bytes)
  expect(spawnProcess).toHaveBeenCalledTimes(kind === 'app-snapshot' ? 2 : 1)
})
