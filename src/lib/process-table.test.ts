import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'

const { spawn, execFileSync } = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn, execFileSync }))

import { readProcessTable } from './process-tree-freeze'

it('abandons a stuck ps while other timers run, without waiting for exit or close', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
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
    const result = await Promise.race([readProcessTable(30), watchdog])
    order.push('result')
    await heartbeat
    expect(order).toEqual(['heartbeat', 'result'])
    expect(result).toBeNull()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.stdout.destroyed).toBe(true)
  } finally { clearTimeout(timer) }
})
