import { afterEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'
import { CC_ACTIVITY, CC_RESPONSE, createCCActivity, createCCResponsePerformance } from '../../packages/protocol/src/cc-activity.js'
const windows: Window[] = []
afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())); vi.useRealTimers() })
function fixture(device = true) {
  vi.useFakeTimers()
  const w = new Window(); windows.push(w)
  w.document.body.innerHTML = '<button id="small-cc" class="lit"><img></button><div class="home-scene"><img class="home-light"></div><form id="chat-form"><textarea id="chat-input">saved draft</textarea></form>'
  let data: any = { running: null, events: [], cursor: 0 }, fail = false, finish: ((value: any) => void) | undefined
  let defer = false, inFlight = 0, maximum = 0
  const read = vi.fn(async () => {
    maximum = Math.max(maximum, ++inFlight)
    try {
      if (defer) return await new Promise<any>(resolve => { finish = resolve })
      if (fail) throw Error('offline')
      return { status: 200, json: async () => data }
    } finally { inFlight-- }
  })
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { changed = fn } }; let changed = () => {}
  w.matchMedia = (() => motion) as any
  const env = { window: w, document: w.document, navigator: { onLine: true }, setTimeout, clearTimeout, setInterval, Date, CCP: { CC_ACTIVITY, CC_RESPONSE, createCCActivity, createCCResponsePerformance }, api: read, onUnauthorized: vi.fn() }
  const f = new Function(...Object.keys(env), `var T='dTEST',isDevice=${device},cReady=true,cOwnerMatterId='owner',cPrivacyRevision=0,mOffline=false,cWaitingRows=[];\n${readFileSync(new URL('./src/activity.js', import.meta.url), 'utf8')}\nreturn {mobileCC,token(value){T=value;mobileCC.refresh()},disconnect(){document.getElementById('small-cc').classList.remove('lit');mobileCC.refresh()},revoke(){isDevice=false;mobileCC.stop()}}`)(...Object.values(env))
  const input = w.document.querySelector('textarea')!
  return { w, input, ...f, read, phase: () => w.document.getElementById('small-cc')!.getAttribute('data-cc-phase'),
    response: () => w.document.getElementById('small-cc')!.getAttribute('data-cc-response'),
    data(value: any) { data = value }, fail() { fail = true }, defer() { defer = true },
    finish(value: any) { defer = false; finish!({ status: 200, json: async () => value }) }, maximum: () => maximum,
    visibility(active: boolean) { Object.defineProperty(w.document, 'hidden', { configurable: true, value: !active }); w.document.dispatchEvent(new w.Event('visibilitychange')) },
    reduce(on: boolean) { motion.matches = on; changed() },
  }
}
const stream = (text: string, cursor = 1) => ({ running: { turnId: 't' }, events: text ? [{ id: 'x', turnId: 't', kind: 'agent_message', text }] : [], cursor })
it('does not act or read private activity for a link; a restored device draft is not input evidence', async () => {
  const link = fixture(false); await vi.advanceTimersByTimeAsync(5000); expect(link.read).not.toHaveBeenCalled(); expect(link.phase()).toBe('idle')
  const h = fixture(); await vi.advanceTimersByTimeAsync(0); expect(h.phase()).toBe('idle')
  h.input.focus(); expect(h.phase()).toBe('idle')
  h.input.dispatchEvent(new h.w.Event('input', { bubbles: true })); expect(h.phase()).toBe('listening')
  await vi.advanceTimersByTimeAsync(1700); expect(h.phase()).toBe('idle')
  h.input.dispatchEvent(new h.w.Event('input', { bubbles: true })); h.input.blur(); expect(h.phase()).toBe('idle')
})
it('primes history through an empty page before fresh matching text can speak, without repeat renewal', async () => {
  const h = fixture(); h.data(stream('history')); await vi.advanceTimersByTimeAsync(0); expect(h.phase()).toBe('thinking')
  h.data(stream('history page two', 2)); await vi.advanceTimersByTimeAsync(1000); expect(h.phase()).toBe('thinking')
  h.data(stream('', 2)); await vi.advanceTimersByTimeAsync(1000)
  h.data(stream('live', 3)); await vi.advanceTimersByTimeAsync(1000); expect(h.phase()).toBe('speaking')
  await vi.advanceTimersByTimeAsync(901); expect(h.phase()).toBe('thinking')
  await vi.advanceTimersByTimeAsync(1100); expect(h.phase()).toBe('thinking')
  h.fail(); await vi.advanceTimersByTimeAsync(1000); expect(h.phase()).toBe('idle')
})
it('expires evidence, gives reduced motion a static substitute and clears immediately on disconnect/revocation', async () => {
  const h = fixture(); await vi.advanceTimersByTimeAsync(0)
  h.data(stream('')); await vi.advanceTimersByTimeAsync(1000)
  h.data(stream('live')); await vi.advanceTimersByTimeAsync(1000); expect(h.response()).toBe('acting')
  h.reduce(true); expect(h.response()).toBe('static'); expect(h.phase()).toBe('speaking')
  h.reduce(false); expect(h.response()).toBe('static')
  h.defer(); await vi.advanceTimersByTimeAsync(2600); expect(h.phase()).toBe('idle')
  h.disconnect(); expect(h.phase()).toBe('idle'); h.revoke(); expect(h.phase()).toBe('idle')
  h.finish(stream('late')); await vi.advanceTimersByTimeAsync(0); expect(h.phase()).toBe('idle')
})
it('serializes stop/resume, ignores retired responses and rebaselines after visibility or identity changes', async () => {
  const h = fixture(); await vi.advanceTimersByTimeAsync(0); h.defer(); await vi.advanceTimersByTimeAsync(1000)
  const count = h.read.mock.calls.length
  h.visibility(false); expect(h.phase()).toBe('idle'); h.visibility(true)
  expect(h.read).toHaveBeenCalledTimes(count)
  h.finish(stream('retired')); await vi.advanceTimersByTimeAsync(0)
  expect(h.maximum()).toBe(1); expect(h.phase()).not.toBe('speaking')
  h.token('dOTHER'); expect(h.phase()).toBe('idle'); await vi.advanceTimersByTimeAsync(0)
  expect(h.phase()).not.toBe('speaking'); h.revoke()
})
