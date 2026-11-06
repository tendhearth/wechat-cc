import { test, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { jobLifecycle } from './macmini-job-lifecycle.mjs'

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['timeout', 124]]) {
  test(`${signal} stops owned groups before release, with forced kill after grace`, async () => {
    const processRef = new EventEmitter()
    const events = []
    const timers = []
    processRef.kill = (pid, sig) => events.push([pid, sig])
    processRef.exit = value => events.push(['exit', value])
    const lifecycle = jobLifecycle({ processRef, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: vi.fn(), timeoutMs: 20 })
    lifecycle.acquired(async () => { events.push('release') })
    lifecycle.onStop(async () => { events.push('cleanup') })
    const child = new EventEmitter(); child.pid = 123
    lifecycle.track(child)
    if (signal === 'timeout') timers[0].fn(); else processRef.emit(signal)
    expect(events).toEqual([[-123, 'SIGTERM']])
    expect(() => lifecycle.assertRunning()).toThrow('Mini job is stopping')
    const finishing = lifecycle.finish()
    expect(finishing).toBeInstanceOf(Promise)
    expect(timers[1].ms).toBe(5000)
    timers[1].fn()
    expect(events).toEqual([[-123, 'SIGTERM'], [-123, 'SIGKILL']])
    child.emit('close')
    await finishing
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([[-123, 'SIGTERM'], [-123, 'SIGKILL'], 'cleanup', 'release', ['exit', code]])
    expect(processRef.listenerCount('SIGTERM')).toBe(0)
  })
}

test('normal completion cancels timeout, removes handlers and releases', async () => {
  const processRef = new EventEmitter()
  const release = vi.fn(), clearTimer = vi.fn()
  const lifecycle = jobLifecycle({ processRef, setTimer: () => 7, clearTimer })
  lifecycle.acquired(release)
  await lifecycle.finish()
  expect(release).toHaveBeenCalledOnce()
  expect(clearTimer).toHaveBeenCalledWith(7)
  expect(processRef.listenerCount('SIGHUP')).toBe(0)
})
