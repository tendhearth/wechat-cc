import { describe, it, expect, afterEach, vi } from 'vitest'
import { acquireInstanceLock, acquireInstanceLockWaitingForShutdown, releaseInstanceLock, writeHeartbeat, isHeartbeatFresh, startHeartbeatTicker } from './single-instance'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wcc-lock-'))
const pidPath = join(dir, 'server.pid')

afterEach(() => { releaseInstanceLock(pidPath) })

describe('startHeartbeatTicker', () => {
  it('stamps the heartbeat on each interval, independent of poll work, until stopped', () => {
    vi.useFakeTimers()
    try {
      const hb = join(dir, 'ticker.heartbeat')
      const stop = startHeartbeatTicker(hb, 1000)
      vi.advanceTimersByTime(1000)
      const t1 = readFileSync(hb, 'utf8')
      vi.advanceTimersByTime(1000)
      const t2 = readFileSync(hb, 'utf8')
      // Keeps stamping on a fixed cadence (this is what survives a long inline
      // turn that would otherwise delay the poll-loop's heartbeat stamp).
      expect(Number(t2)).toBeGreaterThan(Number(t1))
      stop()
      vi.advanceTimersByTime(5000)
      expect(readFileSync(hb, 'utf8')).toBe(t2) // no writes after stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('single-instance', () => {
  it('acquires when no pid file exists', () => {
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
    expect(existsSync(pidPath)).toBe(true)
  })

  it('steals lock when pid file refers to dead process', () => {
    writeFileSync(pidPath, '999999999', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
  })

  it('refuses when pid file refers to live process (self)', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already running/i)
  })

  it('steals lock when the live daemon holder fails the health check (wedged/half-started placeholder)', () => {
    // The reported desktop scenario: launchd auto-starts a daemon that holds
    // the pidfile (process alive, comm=bun) but never actually serves — so
    // the CLI used to refuse with "already running" and the user had to kill
    // it by hand. With an injected health probe that reports the holder is
    // not serving, acquire treats the lock as stale and takes it over.
    writeFileSync(pidPath, String(process.pid), 'utf8') // self → looks like our daemon
    const r = acquireInstanceLock(pidPath, { isHealthy: () => false })
    expect(r.ok).toBe(true)
  })

  it('still refuses when the live daemon holder passes the health check', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const r = acquireInstanceLock(pidPath, { isHealthy: () => true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already running/i)
  })

  it('writes our own pid into the file after stealing a dead holder', () => {
    // The atomic-claim refactor (exclusive `wx` create for a fresh start, then
    // inspect+steal on EEXIST) must still leave OUR pid in the file when it
    // steals a dead holder — otherwise releaseInstanceLock would never clean up.
    writeFileSync(pidPath, '999999999', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
    expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid))
  })

  it('does not overwrite a healthy holder\'s pid when it refuses', () => {
    // Exclusive-create + refuse-before-write: a refused acquire must leave the
    // holder's pidfile untouched (no clobber of the live daemon's identity).
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const before = readFileSync(pidPath, 'utf8')
    const r = acquireInstanceLock(pidPath, { isHealthy: () => true })
    expect(r.ok).toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe(before)
  })

  it('steals lock when pid file refers to a live but unrelated process (post-reboot PID reuse)', () => {
    // Reproduces the post-kernel-panic scenario: the pidfile points at a
    // PID that IS alive after reboot, but it belongs to some other
    // process (sshd, login shell, etc.) — not our daemon.
    // pid 1 (init/systemd) is always alive and never our daemon.
    writeFileSync(pidPath, '1', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
  })
})

describe('heartbeat (daemon health signal for the instance lock)', () => {
  const hbPath = join(dir, 'server.heartbeat')
  afterEach(() => { try { unlinkSync(hbPath) } catch { /* may not exist */ } })

  it('is fresh immediately after a write', () => {
    writeHeartbeat(hbPath, 1000)
    expect(isHeartbeatFresh(hbPath, 5000, 2000)).toBe(true)
  })

  it('is stale once older than the threshold', () => {
    writeHeartbeat(hbPath, 1000)
    expect(isHeartbeatFresh(hbPath, 5000, 10_000)).toBe(false)
  })

  it('treats a missing heartbeat as fresh — never steal a lock we cannot prove is stale', () => {
    expect(isHeartbeatFresh(join(dir, 'no-such.heartbeat'), 5000, 10_000)).toBe(true)
  })
})

describe('acquireInstanceLockWaitingForShutdown:撞上正在收尾的上一个进程就等它退(2026-10-22,kickstart -k 的锁竞争)', () => {
  // 「占着锁的」用本进程的 pid 模拟(看起来就是我们的 daemon,活着);它「退出」= 删掉 pidfile
  function fakeClock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }
  it('**占着锁的正在收尾、过一会儿退了 ⇒ 等到它退、拿到锁**(以前直接判失败、退避 10 秒)', async () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const c = fakeClock()
    let polls = 0
    const waited: number[] = []
    const r = await acquireInstanceLockWaitingForShutdown(pidPath, {
      isHealthy: () => true,
      holderShuttingDown: () => true,
      onWait: (pid) => waited.push(pid),
      now: c.now,
      sleep: async (ms) => { await c.sleep(ms); if (++polls === 3) unlinkSync(pidPath) },   // 第三次重试前,旧进程收尾完删了 pidfile
    })
    expect(r).toEqual({ ok: true })
    expect(waited).toEqual([process.pid])
    expect(polls).toBe(3)
  })
  it('**占着锁的没在收尾(真的两个同时起)⇒ 立刻拒,一毫秒都不多等**', async () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const sleep = vi.fn(async () => {})
    const r = await acquireInstanceLockWaitingForShutdown(pidPath, { isHealthy: () => true, holderShuttingDown: () => false, sleep })
    expect(r).toMatchObject({ ok: false, reason: 'another daemon already running' })
    expect(sleep).not.toHaveBeenCalled()
    unlinkSync(pidPath)
  })
  it('一直不退 ⇒ 等到头就照旧拒(交给开机失败的退避),不无限等', async () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const c = fakeClock()
    const r = await acquireInstanceLockWaitingForShutdown(pidPath, { isHealthy: () => true, holderShuttingDown: () => true, now: c.now, sleep: c.sleep, maxWaitMs: 30_000, pollMs: 250 })
    expect(r).toMatchObject({ ok: false })
    expect(c.now()).toBe(30_000)
    unlinkSync(pidPath)
  })
  it('一开始就拿得到 ⇒ 不碰 holderShuttingDown', async () => {
    const holderShuttingDown = vi.fn(() => true)
    expect(await acquireInstanceLockWaitingForShutdown(pidPath, { holderShuttingDown })).toEqual({ ok: true })
    expect(holderShuttingDown).not.toHaveBeenCalled()
  })
})
