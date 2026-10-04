import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWarmExecFixture } from '../../lib/test-temp'
import { probeVersion, createProbeRetrier, describeProbeFailure, type VersionProbeHandle } from './provider-probe'

const handle = (h: Partial<VersionProbeHandle> & { exited: Promise<number> }): VersionProbeHandle => ({ kill: vi.fn(), ...h })

describe('probeVersion —— 失败带具体原因', () => {
  it('退出 0 ⇒ ok,带 stdout 第一行非空行', async () => {
    const r = await probeVersion('/x/agy', {
      spawnFn: () => handle({ exited: Promise.resolve(0), output: async () => ({ stdout: '\n1.2.16\nmore\n', stderr: '' }) }),
    })
    expect(r).toMatchObject({ ok: true, firstLine: '1.2.16' })
  })

  it('非零退出 ⇒ reason=exit,detail 带退出码和 stderr', async () => {
    const r = await probeVersion('/x/agy', {
      spawnFn: () => handle({ exited: Promise.resolve(2), output: async () => ({ stdout: '', stderr: 'dyld: Library not loaded\n' }) }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('exit')
    expect(r.detail).toContain('退出码 2')
    expect(r.detail).toContain('dyld: Library not loaded')
    expect(describeProbeFailure(r)).toContain('非零退出')
  })

  it('spawn 同步抛(ENOENT)⇒ reason=spawn_error,带原话', async () => {
    const r = await probeVersion('/no/such', { spawnFn: () => { throw new Error('spawn /no/such ENOENT') } })
    expect(r).toMatchObject({ ok: false, reason: 'spawn_error' })
    if (!r.ok) expect(r.detail).toContain('ENOENT')
  })

  it('真超时 ⇒ reason=timeout 并杀掉子进程', async () => {
    const kill = vi.fn()
    const r = await probeVersion('/x/agy', { timeoutMs: 30, graceMs: 5, spawnFn: () => handle({ exited: new Promise<number>(() => {}), kill }) })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('事件循环被卡住的那段不计入超时 —— 2026-10-04 事故的形状:循环卡 12s,agy 其实早退出了', async () => {
    // 假时钟:第一次醒来时钟跳了 12s(循环被同步活卡住),之后正常走。
    let t = 0
    let calls = 0
    const now = () => {
      calls++
      if (calls === 3) t += 12_000   // 第一个滴答醒来(第 1、2 次是起点):卡了 12s
      else t += 10
      return t
    }
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>(r => { resolveExit = r })
    const kill = vi.fn()
    // 超时 1s,而时钟跳了 12s:墙钟算法必判超时;按「醒着的时间」只记一个滴答,继续等。
    const p = probeVersion('/x/agy', { timeoutMs: 1000, graceMs: 1, now, spawnFn: () => handle({ exited, kill }) })
    // 退出事件在第一个滴答(250ms)之后才落地。
    setTimeout(() => resolveExit(0), 300)
    const r = await p
    expect(r.ok).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })

  it('超时的 detail 说出循环卡了多久(下次真机日志一眼看出病因)', async () => {
    let t = 0
    let calls = 0
    const now = () => { calls++; t += calls === 3 ? 9_000 : 20; return t }
    const r = await probeVersion('/x/agy', { timeoutMs: 40, graceMs: 1, now, spawnFn: () => handle({ exited: new Promise<number>(() => {}) }) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/事件循环被卡住约 \d+ms/)
  })

  describe.runIf(process.platform !== 'win32')('真子进程(POSIX shell 夹具)', () => {
    it('真 spawn:读到 stdout 版本行;非零退出读到 stderr', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'provider-probe-'))
      const good = join(dir, 'good')
      const bad = join(dir, 'bad')
      writeWarmExecFixture(good, '#!/bin/sh\necho "agy 9.9.9"\nexit 0\n')
      writeWarmExecFixture(bad, '#!/bin/sh\necho "boom on stderr" >&2\nexit 3\n')
      const g = await probeVersion(good, { timeoutMs: 15_000 })
      expect(g).toMatchObject({ ok: true, firstLine: 'agy 9.9.9' })
      const b = await probeVersion(bad, { timeoutMs: 15_000 })
      expect(b.ok).toBe(false)
      if (!b.ok) { expect(b.reason).toBe('exit'); expect(b.detail).toContain('boom on stderr') }
    })

    it('真 spawn:二进制不存在 ⇒ 失败(不抛)', async () => {
      const r = await probeVersion(join(tmpdir(), 'definitely-not-here-agy'), { timeoutMs: 15_000 })
      expect(r.ok).toBe(false)
    })
  })
})

/** 手动计时器:排进来的回调由测试决定什么时候跑。 */
function manualTimers() {
  const queue: Array<{ fn: () => void; ms: number; id: number }> = []
  let seq = 0
  return {
    queue,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; queue.push({ fn, ms, id }); return id },
    clearTimer: (h: unknown) => { const i = queue.findIndex(q => q.id === h); if (i >= 0) queue.splice(i, 1) },
    /** 跑最早排进来的那个,并等它的异步尾巴落地。 */
    async fireNext(): Promise<number | null> {
      const next = queue.shift()
      if (!next) return null
      next.fn()
      await vi.waitFor(() => { /* let microtasks settle */ })
      await new Promise(r => setImmediate(r))
      return next.ms
    },
  }
}

describe('createProbeRetrier —— 指数退避重探', () => {
  it('失败一次、再探就通过 ⇒ 状态变 registered,不再排计时器', async () => {
    const timers = manualTimers()
    const logs: string[] = []
    const r = createProbeRetrier({ log: (_t, l) => logs.push(l), setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    const attempt = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: '超时 — 再来' })
      .mockResolvedValueOnce({ ok: true })
    r.schedule('agy', '超时 — 开机那次', attempt)
    expect(r.status()[0]).toMatchObject({ id: 'agy', state: 'retrying', attempts: 0, last_error: '超时 — 开机那次' })
    expect(timers.queue.map(q => q.ms)).toEqual([2_000])
    expect(await timers.fireNext()).toBe(2_000)
    expect(r.status()[0]).toMatchObject({ state: 'retrying', attempts: 1, last_error: '超时 — 再来' })
    expect(timers.queue.map(q => q.ms)).toEqual([4_000])
    await timers.fireNext()
    expect(r.status()[0]).toMatchObject({ state: 'registered', attempts: 2 })
    expect(r.status()[0]!.registered_at).not.toBeNull()
    expect(timers.queue).toHaveLength(0)
    expect(logs.some(l => l.includes('第 2 次重探通过'))).toBe(true)
  })

  it('永远失败 ⇒ 2s、4s、8s … 封顶 60s,之后每 10 分钟一次;一小时最多 12 次,不成风暴', async () => {
    const timers = manualTimers()
    const r = createProbeRetrier({ log: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    const attempt = vi.fn(async () => ({ ok: false as const, reason: 'spawn /x ENOENT' }))
    r.schedule('agy', 'ENOENT', attempt)
    const delays: number[] = []
    let elapsed = 0
    while (elapsed < 60 * 60_000) {
      const ms = await timers.fireNext()
      if (ms === null) break
      delays.push(ms)
      elapsed += ms
    }
    expect(delays.slice(0, 7)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 600_000])
    expect(delays.every(d => d >= 2_000)).toBe(true)
    // 指数段之后全是慢速周期。
    expect(delays.slice(6).every(d => d === 600_000)).toBe(true)
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(12)
    // 任何时刻最多排着一个计时器(一次一个、不重叠)。
    expect(timers.queue.length).toBeLessThanOrEqual(1)
  })

  it('同一个 id 重复登记被忽略;stop() 清掉计时器,在飞的那次跑完也不再排', async () => {
    const timers = manualTimers()
    const r = createProbeRetrier({ log: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    let release!: () => void
    const attempt = vi.fn(() => new Promise<{ ok: false; reason: string }>(res => { release = () => res({ ok: false, reason: 'x' }) }))
    r.schedule('codex', 'x', attempt)
    r.schedule('codex', 'y', attempt)
    expect(timers.queue).toHaveLength(1)
    timers.queue.shift()!.fn()       // 开始一次在飞的探测
    r.stop()
    release()
    await new Promise(res => setImmediate(res))
    expect(timers.queue).toHaveLength(0)
    expect(r.status()[0]!.next_attempt_at).toBeNull()
    r.schedule('agy', 'z', attempt)   // 停了之后不再接新的
    expect(r.status().map(s => s.id)).toEqual(['codex'])
  })
})
