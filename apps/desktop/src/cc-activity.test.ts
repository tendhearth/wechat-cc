// @repo-guard
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mountCCActivity, createCCActivityFeed } from './cc-activity.js'
import { readFileSync } from 'node:fs'
import { renderCCActivity } from '../../../scripts/gen-routes'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); document.body.replaceChildren() })
it('keeps the desktop generated decisions byte-identical to the shared contract', () => {
  expect(readFileSync(`${__dirname}/generated/cc-activity.js`, 'utf8')).toBe(renderCCActivity())
})
it('only listens on a focused input event; nonempty drafts, blur, expiry and disconnection stay honest', async () => {
  vi.useFakeTimers()
  document.body.innerHTML = '<span id="cc"></span><textarea id="converse-input">saved draft</textarea>'
  const stage = document.querySelector<HTMLElement>('#cc')!, input = document.querySelector('textarea')!
  const cc = mountCCActivity({ stage }); cleanups.push(cc.destroy)
  cc.update({ connected: true }); expect(stage.dataset.ccPhase).toBe('idle')
  input.focus(); expect(stage.dataset.ccPhase).toBe('idle')
  input.dispatchEvent(new Event('input', { bubbles: true })); expect(stage.dataset.ccPhase).toBe('listening')
  await vi.advanceTimersByTimeAsync(1700); expect(stage.dataset.ccPhase).toBe('idle')
  input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); expect(stage.dataset.ccPhase).toBe('idle')
  cc.update({ connected: false }); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); expect(stage.dataset.ccPhase).toBe('idle')
})
it('follows live stream changes and clears immediately on suppression or failed reads', async () => {
  vi.useFakeTimers()
  const stage = document.createElement('span'); document.body.append(stage)
  const cc = mountCCActivity({ stage }); cleanups.push(cc.destroy); cc.update({ connected: true })
  const stream = (text: string) => ({ running: { turnId: 't' }, events: [{ id: 'x', turnId: 't', kind: 'agent_message', text }] })
  cc.observe(stream('old')); expect(stage.dataset.ccPhase).toBe('thinking')
  cc.observe(stream('new')); expect(stage.dataset.ccPhase).toBe('speaking')
  cc.update({ connected: true, enabled: false }); expect(stage.dataset.ccPhase).toBe('idle')
  cc.observe(stream('hidden')); cc.update({ connected: true }); cc.observe(stream('hidden'))
  expect(stage.dataset.ccPhase).toBe('thinking')
  cc.observe(null); expect(stage.dataset.ccPhase).toBe('idle')
})
it('serializes companion reads, clears a failed read and ignores late responses after stop', async () => {
  vi.useFakeTimers()
  const observe = vi.fn(), read = vi.fn<() => Promise<any>>()
  let finish!: (data: any) => void
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValueOnce(Error('unavailable'))
  const feed = createCCActivityFeed({ read, observe }); cleanups.push(feed.stop)
  feed.start(); feed.start(); expect(read).toHaveBeenCalledOnce()
  feed.stop(); finish({ running: { turnId: 'old' }, events: [] }); await vi.advanceTimersByTimeAsync(2000)
  expect(observe.mock.calls).toEqual([[null]])
  feed.start(); await vi.advanceTimersByTimeAsync(0); expect(observe).toHaveBeenLastCalledWith(null)
})
it('advances through long streams and primes all backfill before allowing live output', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async (cursor: number) => ({ cursor: cursor < 100 ? cursor + 50 : 101, running: { turnId: 't' }, events: cursor < 100 ? Array.from({ length: 50 }, (_, i) => ({ id: `${cursor+i}`, turnId: 't', kind: 'agent_message', text: 'backfill' })) : cursor === 100 ? [] : [{ id: 'live', turnId: 't', kind: 'agent_message', text: 'new' }] }))
  const observe = vi.fn(), feed = createCCActivityFeed({ read, observe }); cleanups.push(feed.stop)
  feed.start(); await vi.advanceTimersByTimeAsync(3100)
  expect(read.mock.calls.map(call => call[0])).toEqual([0, 50, 100, 101])
  expect(observe.mock.calls.map(call => call[0].activityReady)).toEqual([false, false, false, true])
})
