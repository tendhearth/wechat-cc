import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'

const { spawn, execFileSync } = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn, execFileSync }))

import { makeProcessTreeFreezer, readProcessTable } from './process-tree-freeze'

it('abandons a stuck ps while other timers run, without waiting for exit or close', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, stdout: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
  spawn.mockReturnValue(child)
  // Model a synchronous wait with a finite stand-in so the regression can fail
  // without pinning the test runner. Neither fake returns a usable table.
  execFileSync.mockImplementation(() => {
    const until = performance.now() + 100
    while (performance.now() < until) { /* blocked in the synchronous wait */ }
    return ''
  })
  const order: string[] = []
  const heartbeat = new Promise<void>(resolve => setTimeout(() => { order.push('heartbeat'); resolve() }, 0))
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ps did not return')), 500) })
  try {
    const first = readProcessTable(30)
    const shared = readProcessTable(30)
    const result = await Promise.race([first, watchdog])
    order.push('result')
    await heartbeat
    expect(order).toEqual(['heartbeat', 'result'])
    expect(result).toBeNull()
    expect(await shared).toBeNull()
    expect(await readProcessTable(30)).toBeNull()
    expect(spawn).toHaveBeenCalledOnce()
    expect(child.eventNames()).toEqual([])
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.stdout.destroyed).toBe(true)

    child.exitCode = 1
    const next = Object.assign(new EventEmitter(), { stdout: new PassThrough() })
    spawn.mockReturnValue(next)
    const recovered = readProcessTable(30)
    const joined = readProcessTable(30)
    next.stdout.write('10 1 10\n')
    next.emit('close', 0)
    expect(await recovered).toEqual([{ pid: 10, parent: 1, group: 10 }])
    expect(await joined).toBe(await recovered)
    expect(spawn).toHaveBeenCalledTimes(2)
  } finally { clearTimeout(timer) }
})

it('a freeze does not reuse a ps snapshot that started before its SIGSTOP (it re-reads, then stops the new group)', async () => {
  const fakePs = () => Object.assign(new EventEmitter(), { pid: undefined, exitCode: null as number | null, stdout: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
  const stale = fakePs(), fresh = fakePs()
  spawn.mockReset()
  spawn.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
  // Another task's read is already in flight: its snapshot only has root group 100.
  const other = readProcessTable(1_000)
  const signals: Array<[number, string | number]> = []
  const freezer = makeProcessTreeFreezer(() => 100, { platform: 'darwin', signal: (target, sig) => { signals.push([target, sig]) } })
  const freezing = freezer.freeze()
  await new Promise(resolve => setTimeout(resolve, 0))
  // Group 200 was created just before root 100 stopped; the stale table cannot know it.
  stale.stdout.write('100 1 100\n')
  stale.emit('close', 0)
  expect(await other).toEqual([{ pid: 100, parent: 1, group: 100 }])
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(spawn).toHaveBeenCalledTimes(2)
  fresh.stdout.write('100 1 100\n200 100 200\n')
  fresh.emit('close', 0)
  // The pass after stopping 200 needs yet another snapshot taken after that stop.
  const third = fakePs()
  spawn.mockReturnValueOnce(third)
  await new Promise(resolve => setTimeout(resolve, 0))
  third.stdout.write('100 1 100\n200 100 200\n')
  third.emit('close', 0)
  expect(await freezing).toBe(true)
  expect(freezer.fullyFrozen).toBe(true)
  expect(signals).toEqual([[-100, 'SIGSTOP'], [-200, 'SIGSTOP']])
})
