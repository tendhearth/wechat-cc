import { afterEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'
import { CC_ACTIVITY, CC_RESPONSE, createCCActivity, createCCResponsePerformance } from '../../packages/protocol/src/cc-activity.js'
// Exercise the page's actual projection, including its initial-list fallback.
const waitingProjection = readFileSync(new URL('./src/delegation.js', import.meta.url), 'utf8').match(/^function cWaitingMatters\(\).*$/m)![0]
const statusProjection = readFileSync(new URL('./src/workbench.js', import.meta.url), 'utf8').match(/^function mStatusKey\(m\) \{[\s\S]*?^\}/m)![0]
const windows: Window[] = []
afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())); vi.useRealTimers() })
function fixture(device = true, random = () => 0) {
  vi.useFakeTimers()
  const w = new Window(); windows.push(w)
  w.document.body.innerHTML = '<button id="small-cc" class="lit"><img></button><div class="home-scene"><img class="home-light"></div><form id="chat-form"><textarea id="chat-input">saved draft</textarea></form>'
  let data: any = { running: null, events: [], cursor: 0 }, fail = false, finish: ((value: any) => void) | undefined
  let defer = false, inFlight = 0, maximum = 0, reply: any
  const times: number[] = []
  const read = vi.fn(async () => {
    times.push(Date.now())
    maximum = Math.max(maximum, ++inFlight)
    try {
      await Promise.resolve()
      if (defer) return await new Promise<any>(resolve => { finish = resolve })
      if (fail) throw Error('offline')
      if (reply) return reply
      return { status: 200, json: async () => data }
    } finally { inFlight-- }
  })
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { changed = fn } }; let changed = () => {}
  w.matchMedia = (() => motion) as any
  const env = { window: w, document: w.document, navigator: { onLine: true }, setTimeout, clearTimeout, setInterval, Date, Math: Object.assign(Object.create(Math), { random }), CCP: { CC_ACTIVITY, CC_RESPONSE, createCCActivity, createCCResponsePerformance }, api: read, onUnauthorized: vi.fn() }
  const f = new Function(...Object.keys(env), `var T='dTEST',isDevice=${device},cReady=true,cOwnerMatterId='owner',cPrivacyRevision=0,mOffline=false,cWaitingRows=[],mMatters=[],homeFocus=null;\n${statusProjection}\n${waitingProjection}\n${readFileSync(new URL('./src/activity.js', import.meta.url), 'utf8')}\nreturn {mobileCC,waiting(rows,matters=[],focus=null){cWaitingRows=rows;mMatters=matters;homeFocus=focus;mobileCC.refresh();return cWaitingMatters().length},token(value){T=value;mobileCC.refresh()},disconnect(){document.getElementById('small-cc').classList.remove('lit');mobileCC.refresh()},revoke(){isDevice=false;mobileCC.stop()}}`)(...Object.values(env))
  const input = w.document.querySelector('textarea')!
  return { w, input, ...f, read, phase: () => w.document.getElementById('small-cc')!.getAttribute('data-cc-phase'),
    response: () => w.document.getElementById('small-cc')!.getAttribute('data-cc-response'),
    data(value: any) { data = value }, fail(on = true) { fail = on }, defer() { defer = true }, times,
    reply(status: number, retryAfter?: string, invalidJson = false) { reply = { status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}), json: async () => { if (invalidJson) throw SyntaxError('invalid JSON'); return data } } },
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
it.each(['network', '404', '429', '503', 'json', 'shape'])('backs off consecutive %s failures exponentially to a 60s cap', async kind => {
  const h = fixture()
  if (kind === 'network') h.fail()
  else if (kind === 'shape') h.data({})
  else h.reply(kind === 'json' ? 200 : Number(kind), undefined, kind === 'json')
  await vi.advanceTimersByTimeAsync(183000)
  expect(h.times.slice(1).map((t: number, i: number) => t - h.times[i]!)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 50000, 50000])
  expect(h.maximum()).toBe(1); expect(h.phase()).toBe('idle'); expect(h.response()).toBe('static')
  h.revoke()
})
it('jitters failure retries while keeping the exponential delay bounded', async () => {
  const h = fixture(true, () => 0.5); h.fail()
  await vi.advanceTimersByTimeAsync(1099); expect(h.read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2199); expect(h.read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(3)
  h.revoke()
})
it('retains jitter after reaching the capped exponential retry window', async () => {
  const h = fixture(true, () => 0.5); h.fail()
  await vi.advanceTimersByTimeAsync(179300)
  expect(h.times.slice(1).map((t: number, i: number) => t - h.times[i]!).slice(-2)).toEqual([55000, 55000])
  h.revoke()
})
it('resets failure backoff after success and rebaselines before live text resumes', async () => {
  const h = fixture(); h.fail()
  await vi.advanceTimersByTimeAsync(3000); expect(h.read).toHaveBeenCalledTimes(3)
  h.fail(false); h.data(stream('recovered history'))
  await vi.advanceTimersByTimeAsync(4000); expect(h.read).toHaveBeenCalledTimes(4); expect(h.phase()).toBe('thinking')
  h.data(stream('', 1)); await vi.advanceTimersByTimeAsync(1000)
  h.data(stream('live', 2)); await vi.advanceTimersByTimeAsync(1000); expect(h.phase()).toBe('speaking')
  h.fail(); await vi.advanceTimersByTimeAsync(1000); expect(h.phase()).toBe('idle')
  const count = h.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(999); expect(h.read).toHaveBeenCalledTimes(count)
  await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(count + 1)
  h.revoke()
})
it.each(['seconds', 'date'])('respects a Retry-After %s value beyond the exponential cap', async kind => {
  const h = fixture()
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  h.reply(429, kind === 'seconds' ? '120' : 'Tue, 10 Nov 2026 12:02:00 GMT')
  await vi.advanceTimersByTimeAsync(119999); expect(h.read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(2)
  h.revoke()
})
it.each(['invalid', '-1', '0', 'Tue, 10 Nov 2020 12:00:00 GMT'])('uses backoff for an unusable Retry-After %s', async header => {
  const h = fixture(); h.reply(503, header)
  await vi.advanceTimersByTimeAsync(3000); expect(h.read).toHaveBeenCalledTimes(3)
  h.revoke()
})
it.each(['hidden', 'revoked'])('does not schedule another failure retry after being %s', async reason => {
  const h = fixture(); h.fail(); await vi.advanceTimersByTimeAsync(3000)
  if (reason === 'hidden') h.visibility(false)
  else h.revoke()
  const count = h.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(180000)
  expect(h.read).toHaveBeenCalledTimes(count); expect(h.phase()).toBe('idle')
})
it.each(['home decision', 'initial matter fallback'])('uses the page waiting projection for %s ahead of input and live output', async source => {
  const h = fixture(); await vi.advanceTimersByTimeAsync(0)
  const matter = { id: 'pending', taskState: { status: 'running', pending: 1 } }
  expect(source === 'home decision'
    ? h.waiting([], [], { id: 'decision', kind: 'decision' })
    : h.waiting(null, [matter])).toBe(1)
  h.input.focus(); h.input.dispatchEvent(new h.w.Event('input', { bubbles: true }))
  expect(h.phase()).toBe('idle'); expect(h.response()).toBe('static')
  h.input.blur(); h.data(stream('')); await vi.advanceTimersByTimeAsync(1000)
  h.data(stream('live')); await vi.advanceTimersByTimeAsync(1000)
  expect(h.phase()).toBe('idle'); expect(h.response()).toBe('static')
  h.revoke()
})
it('immediately yields active live output when the page dynamically enters a decision', async () => {
  const h = fixture(); await vi.advanceTimersByTimeAsync(0)
  h.data(stream('')); await vi.advanceTimersByTimeAsync(1000)
  h.data(stream('live')); await vi.advanceTimersByTimeAsync(1000)
  expect(h.phase()).toBe('speaking'); expect(h.response()).toBe('acting')
  expect(h.waiting([], [], { id: 'decision', kind: 'decision' })).toBe(1)
  expect(h.phase()).toBe('idle'); expect(h.response()).toBe('static')
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.phase()).toBe('idle'); expect(h.response()).toBe('static')
  h.revoke()
})
