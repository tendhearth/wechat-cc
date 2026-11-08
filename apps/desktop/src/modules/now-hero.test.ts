// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { QUIET_MS } from '../companion-preferences.js'
import { createNowHeroFacts, mountNowHero as mountHero } from './now-hero.js'

const heroes: ReturnType<typeof mountHero>[] = []
function mountNowHero(opts: Parameters<typeof mountHero>[0]) { const hero = mountHero(opts); heroes.push(hero); return hero }
const task = (key = 'r') => ({ id: 'a', title: 'task', providerId: 'codex', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: JSON.stringify([key]) })
const attention = (phase: string | null, tasks: any[] = []) => ({ stale: false, tasks, ...(phase === null ? {} : { progress: new Map([['a', phase]]) }) })
const connected = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }
const cc = (id: number, pending = false) => ({ id, role: 'cc', text: pending ? '…' : '回信', pending })
const fresh = () => { const f = createNowHeroFacts(); f.presence(connected); return f }
afterEach(() => { for (const hero of heroes.splice(0)) hero.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); localStorage.clear(); delete document.documentElement.dataset.mode; Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })

describe('home hero consumes independent true-state streams', () => {
  it('does not replay initial replies, unread, terminal requests or late conversation history', () => {
    const f = createNowHeroFacts()
    expect(f.presence({ ...connected, news: { unread: 5, latest_kind: null, latest_title: null } }).intent.oneShots).toEqual([])
    expect(f.attention(attention('replied', [task()])).intent.oneShots).toEqual([])
    expect(f.terminal([{ id: 's', hash: 'old' }]).intent.oneShots).toEqual([])
    f.converse([])
    expect(f.converse([cc(1)]).intent.oneShots).toEqual([])
    expect(f.current().intent.behavior).toBe('permission')
  })
  it('working to replied expresses this round replying once; disappearance and cancellation never mean done', () => {
    const f = fresh()
    f.attention(attention('working'))
    expect(f.current().intent.behavior).toBe('working')
    expect(f.attention(attention('replied')).intent.oneShots).toEqual(['done'])
    expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    f.attention(attention('working'))
    expect(f.attention({ stale: false, tasks: [], progress: new Map() }).intent.oneShots).toEqual([])
    f.attention(attention('working', [task()]))
    expect(f.attention(attention('cancelled')).intent.oneShots).toEqual([])
  })
  it('a stale attention response resets progress baseline without fabricating a reply on recovery', () => {
    const f = fresh(); f.attention(attention('working'))
    const stale = f.attention({ ...attention('working', [task()]), stale: true })
    expect(stale.intent.props).toContain('exclamation')
    expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    f.attention(attention('working'))
    expect(f.attention(attention('replied')).intent.oneShots).toEqual(['done'])
  })
  it('local pending can produce receive only when followed by a new real reply, not removal or history', () => {
    const f = fresh(); f.converse([]); f.converse([cc(1)])
    expect(f.converse([cc(1), cc(2, true)]).intent.behavior).toBe('thinking')
    expect(f.converse([cc(1), cc(3)]).intent.oneShots).toEqual(['receive'])
    expect(f.converse([cc(1), cc(3)]).intent.oneShots).toEqual([])
    f.converse([cc(1), cc(3), cc(4, true)])
    expect(f.converse([cc(1), cc(3)]).intent.oneShots).toEqual([])
    expect(f.converse([cc(1), cc(3), cc(5)]).intent.oneShots).toEqual([])
  })
  it('keeps actual local errors visible in reduced motion without inventing a received reply', () => {
    const f = fresh(); f.converse([]); f.converse([cc(1, true)])
    expect(f.converse([{ id: 2, role: 'error' }]).intent).toMatchObject({ props: ['exclamation'], oneShots: ['error'] })
    expect(f.converse([{ id: 2, role: 'error' }]).intent.oneShots).toEqual([])
    f.setMotion({ reducedMotion: true }); f.converse([cc(3, true)])
    expect(f.converse([{ id: 4, role: 'error' }]).intent).toMatchObject({ props: ['exclamation'], oneShots: [] })
    f.converse([cc(5, true)])
    expect(f.current().intent.props).not.toContain('exclamation')
  })
  it('permissions win over receive, replied and presence work; resolving a request never emits done', () => {
    const f = fresh(); f.attention(attention('working')); f.converse([])
    f.converse([cc(1, true)]); f.terminal([{ id: 's', hash: 'r' }])
    expect(f.converse([cc(2)]).intent).toMatchObject({ behavior: 'permission', oneShots: [] })
    expect(f.attention(attention('replied')).intent).toMatchObject({ behavior: 'permission', oneShots: [] })
    expect(f.terminal([]).intent.oneShots).toEqual([])
    f.attention(attention(null, [task()]))
    expect(f.attention(attention(null)).intent.oneShots).toEqual([])
  })
  it('hidden, quiet and reduced changes consume facts without queued celebrations', () => {
    const f = fresh(); f.attention(attention('working'))
    f.setActive(false)
    expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    expect(f.setActive(true).align).toBe(true)
    expect(f.current().intent.oneShots).toEqual([])
    for (const mode of ['quiet', 'reducedMotion']) {
      f.setMotion({ [mode]: true }); f.attention(attention('working'))
      expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
      f.setMotion({ [mode]: false })
      expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    }
  })
  it('down/reconnect aligns Light/Dark and baselines each arriving stream independently', () => {
    const f = fresh(); f.attention(attention('working')); f.converse([cc(1, true)])
    expect(f.presence({ ...connected, presence: 'down' }).intent).toMatchObject({ form: 'unlit', behavior: 'sleep', oneShots: [] })
    expect(f.presence(connected).align).toBe(true)
    expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    expect(f.converse([cc(2)]).intent.oneShots).toEqual([])
    f.presence({ ...connected, presence: 'down' }); f.attention(attention('working'))
    f.presence(connected)
    expect(f.attention(attention('replied')).intent.oneShots).toEqual([])
    f.attention(attention('working'))
    expect(f.attention(attention('failed')).intent).toMatchObject({ oneShots: ['error'], props: ['exclamation'] })
  })
  it('an old daemon without progress still shows actual permission and local pending', () => {
    const f = fresh(); f.attention(attention(null, [task()]))
    expect(f.current().intent.behavior).toBe('permission')
    f.attention(attention(null)); f.converse([cc(1, true)])
    expect(f.current().intent.behavior).toBe('thinking')
  })
})

const manifest = JSON.parse(readFileSync(`${__dirname}/../assets/pet/cc-v1/manifest.json`, 'utf8'))
function dom() {
  document.body.innerHTML = '<article data-now="home"><button id="hero"><img class="now-cc-light"><img class="now-cc-dark"></button></article>'
  return { root: document.querySelector('article')!, button: document.querySelector('button')! }
}
const fetchManifest = async () => new Response(JSON.stringify(manifest))
describe('home hero uses the real pet lifecycle', () => {
  it('keeps two canonical fallbacks until a sprite loads and stops picture timers in chat and hidden panes', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any)
    const pet = await hero.ready
    expect(pet!.machine.snapshot()).toMatchObject({ form: 'lit', transition: null })
    expect(button.dataset.runtime).toBeUndefined()
    button.querySelector('.now-pet-sprite')!.dispatchEvent(new Event('load'))
    expect(button.dataset.runtime).toBe('ready')
    expect(button.querySelectorAll('.now-cc-light, .now-cc-dark')).toHaveLength(2)
    root.dataset.now = 'chat'; await Promise.resolve()
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-paused')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    hero.setAttention(attention('working')); hero.setAttention(attention('replied'))
    root.dataset.now = 'home'; await Promise.resolve()
    expect(pet!.machine.snapshot().behavior).toBe('idle')
    expect(pet!.machine.snapshot().transition).toBeNull()
    root.hidden = true; await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    hero.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it('suspends pictures while the dashboard is in setup and on document hiding', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const dashboard = document.createElement('main'); dashboard.className = 'dashboard'; document.body.append(dashboard); dashboard.append(root)
    document.documentElement.dataset.mode = 'loading'
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); await hero.ready
    expect(vi.getTimerCount()).toBe(0)
    document.documentElement.dataset.mode = 'dashboard'; await Promise.resolve()
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-paused')).toBe(false)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    hero.setPresence({ ...connected, presence: 'down' } as any)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))
    expect(button.querySelector('.now-pet-stage')!.getAttribute('data-form')).toBe('unlit')
    hero.destroy(); delete document.documentElement.dataset.mode
  })
  it('system reduction changes live and stored choices keep connection/permission visible', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const media = Object.assign(new EventTarget(), { matches: false })
    const hero = mountNowHero({ root, button, motionQuery: media as any, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); const pet = await hero.ready
    media.matches = true; media.dispatchEvent(new Event('change'))
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(true)
    hero.setAttention(attention('working')); hero.setAttention(attention('replied'))
    expect(pet!.machine.snapshot().behavior).toBe('idle')
    hero.setTerminal([{ id: 's', hash: 'p' }] as any)
    expect(pet!.machine.snapshot().behavior).toBe('permission')
    hero.setPresence({ presence: 'down' } as any)
    expect(pet!.machine.snapshot().form).toBe('unlit')
    media.matches = false; media.dispatchEvent(new Event('change'))
    hero.setPresence(connected as any)
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(false)
    hero.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it('honors stored user reduction and quiet deadlines without changing Light/Dark', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ userReduced: true, quietUntil: Date.now() + 1000 }))
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); const pet = await hero.ready
    hero.setAttention(attention('working')); hero.setAttention(attention('replied'))
    expect(pet!.machine.snapshot()).toMatchObject({ form: 'lit', behavior: 'idle' })
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(true)
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ userReduced: false, quietUntil: Date.now() + 3000 }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc.companion.motion.v1' }))
    await vi.advanceTimersByTimeAsync(1001)
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(false)
    expect(pet!.machine.snapshot().behavior).not.toBe('done')
    hero.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['attention', 'converse', 'presence', 'terminal'])('%s snapshots expire suspended quiet only after consuming its current facts', async stream => {
    vi.useFakeTimers(); const { root, button } = dom()
    const wall = Date.now()
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ quietUntil: wall + QUIET_MS }))
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any)
    hero.setAttention(attention('working'))
    hero.setConverse([cc(1, true)])
    const pet = (await hero.ready)!
    const observed: string[] = []
    pet.machine.subscribe(s => { observed.push(s.behavior) })
    // Date moves as on a sleeping WebKit host; performance and timeout callbacks stand still.
    vi.setSystemTime(wall + QUIET_MS + 1)
    if (stream === 'attention') hero.setAttention(attention('replied'))
    if (stream === 'converse') hero.setConverse([cc(2)])
    if (stream === 'presence') hero.setPresence({ ...connected, news: { ...connected.news, unread: 1 } } as any)
    if (stream === 'terminal') hero.setTerminal([{ id: 's', hash: 'p' }])
    expect(button.dataset.motion).toBe('full')
    expect(button.querySelector('.now-pet-stage')!.classList.contains('pet-motion-reduced')).toBe(false)
    expect(observed).not.toContain('done')
    expect(observed).not.toContain('receive')
    if (stream === 'terminal') expect(pet.machine.snapshot().behavior).toBe('permission')
    // Repeating this already consumed snapshot cannot replay its completion.
    if (stream === 'attention') hero.setAttention(attention('replied'))
    if (stream === 'converse') hero.setConverse([cc(2)])
    if (stream === 'presence') hero.setPresence({ ...connected, news: { ...connected.news, unread: 1 } } as any)
    if (stream === 'terminal') hero.setTerminal([{ id: 's', hash: 'p' }])
    expect(observed).not.toContain('done')
    expect(observed).not.toContain('receive')
    hero.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['presence', 'attention'], ['terminal', 'attention'],
    ['presence', 'converse'], ['terminal', 'converse'], ['terminal', 'presence'],
  ])('%s may expire quiet before the first fresh %s completion without replaying it', async (first, stream) => {
    vi.useFakeTimers(); const { root, button } = dom(), wall = Date.now()
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ quietUntil: wall + QUIET_MS }))
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any)
    hero.setAttention(attention(stream === 'attention' ? 'working' : null))
    hero.setConverse(stream === 'converse' ? [cc(1, true)] : [])
    const pet = (await hero.ready)!, observed: string[] = []
    pet.machine.subscribe(s => { observed.push(s.behavior) })
    vi.setSystemTime(wall + QUIET_MS + 1)
    if (first === 'presence') hero.setPresence(connected as any)
    else hero.setTerminal([])
    expect(button.dataset.motion).toBe('full')
    if (stream === 'attention') hero.setAttention(attention('replied'))
    else if (stream === 'converse') hero.setConverse([cc(2)])
    else hero.setPresence({ ...connected, news: { ...connected.news, unread: 1 } } as any)
    expect(observed).not.toContain('done')
    expect(observed).not.toContain('receive')
    // The next genuinely new cycle is live, and repeating its final snapshot is silent.
    if (stream === 'attention') { hero.setAttention(attention('working')); hero.setAttention(attention('replied')) }
    else if (stream === 'converse') { hero.setConverse([cc(2), cc(3, true)]); hero.setConverse([cc(2), cc(4)]) }
    else hero.setPresence({ ...connected, news: { ...connected.news, unread: 2 } } as any)
    const event = stream === 'attention' ? 'done' : 'receive'
    expect(observed.filter(b => b === event)).toHaveLength(1)
    pet.machine.notifyAnimationEnded()
    if (stream === 'attention') hero.setAttention(attention('replied'))
    else if (stream === 'converse') hero.setConverse([cc(2), cc(4)])
    else hero.setPresence({ ...connected, news: { ...connected.news, unread: 2 } } as any)
    expect(observed.filter(b => b === event)).toHaveLength(1)
  })
  it('staggered reobservation retains current errors and permission controls', async () => {
    vi.useFakeTimers(); const { root, button } = dom(), wall = Date.now()
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ quietUntil: wall + QUIET_MS }))
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); hero.setAttention(attention('working')); hero.setConverse([cc(1, true)])
    const pet = (await hero.ready)!
    vi.setSystemTime(wall + QUIET_MS + 1); hero.setPresence(connected as any)
    hero.setAttention(attention('failed'))
    expect(pet.machine.snapshot()).toMatchObject({ behavior: 'error', props: ['exclamation'] })
    pet.machine.notifyAnimationEnded()
    hero.setConverse([{ id: 2, role: 'error' }])
    expect(pet.machine.snapshot()).toMatchObject({ behavior: 'error', props: ['exclamation'] })
    hero.setTerminal([{ id: 's', hash: 'p' }])
    expect(pet.machine.snapshot().props).toContain('exclamation')
    pet.machine.notifyAnimationEnded()
    expect(pet.machine.snapshot().behavior).toBe('permission')
  })
  it.each(['pane', 'document', 'user', 'system'])('%s recovery baselines each first fresh stream after motion resumes', async mode => {
    vi.useFakeTimers(); const { root, button } = dom()
    const media = Object.assign(new EventTarget(), { matches: false })
    const hero = mountNowHero({ root, button, motionQuery: media as any, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); hero.setAttention(attention('working')); hero.setConverse([cc(1, true)])
    const pet = (await hero.ready)!, observed: string[] = []
    pet.machine.subscribe(s => { if (observed.at(-1) !== s.behavior) observed.push(s.behavior) })
    const suppress = async (on: boolean) => {
      if (mode === 'pane') { root.hidden = on; await Promise.resolve() }
      if (mode === 'document') { Object.defineProperty(document, 'hidden', { configurable: true, value: on }); document.dispatchEvent(new Event('visibilitychange')) }
      if (mode === 'system') { media.matches = on; media.dispatchEvent(new Event('change')) }
      if (mode === 'user') { localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ userReduced: on })); window.dispatchEvent(new StorageEvent('storage', { key: 'cc.companion.motion.v1' })) }
    }
    await suppress(true)
    // No completion is observed until AFTER recovery. Cached/unrelated facts cannot release other streams.
    await suppress(false)
    hero.setTerminal([]); hero.setPresence({ ...connected, news: { ...connected.news, unread: 1 } } as any)
    hero.setAttention(attention('replied'))
    hero.setConverse([cc(2)])
    expect(observed).not.toContain('done'); expect(observed).not.toContain('receive')
    // Presence consumed its own fresh baseline above: a later real unread increment can play.
    hero.setPresence({ ...connected, news: { ...connected.news, unread: 2 } } as any)
    expect(observed.filter(b => b === 'receive')).toHaveLength(1)
    pet.machine.notifyAnimationEnded()
    hero.setAttention(attention('working')); hero.setAttention(attention('replied'))
    expect(observed.filter(b => b === 'done')).toHaveLength(1)
    pet.machine.notifyAnimationEnded()
    hero.setConverse([cc(2), cc(3, true)]); hero.setConverse([cc(2), cc(4)])
    expect(observed.filter(b => b === 'receive')).toHaveLength(2)
    pet.machine.notifyAnimationEnded()
    hero.setAttention(attention('replied')); hero.setConverse([cc(2), cc(4)])
    hero.setPresence({ ...connected, news: { ...connected.news, unread: 2 } } as any)
    expect(observed.filter(b => b === 'done')).toHaveLength(1)
    expect(observed.filter(b => b === 'receive')).toHaveLength(2)
  })
  it('recovery keeps a delayed presence receipt fenced and exposes current permission and error facts', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); hero.setAttention(attention('working')); hero.setConverse([cc(1, true)])
    const pet = (await hero.ready)!, observed: string[] = []
    pet.machine.subscribe(s => { observed.push(s.behavior) })
    root.hidden = true; await Promise.resolve(); root.hidden = false; await Promise.resolve()
    hero.setTerminal([{ id: 's', hash: 'p' }])
    expect(pet.machine.snapshot().behavior).toBe('permission')
    hero.setAttention(attention('failed')); expect(pet.machine.snapshot().props).toContain('exclamation')
    pet.machine.notifyAnimationEnded()
    hero.setConverse([{ id: 2, role: 'error' }]); expect(pet.machine.snapshot().props).toContain('exclamation')
    pet.machine.notifyAnimationEnded(); hero.setTerminal([])
    hero.setPresence({ ...connected, presence: 'down' } as any)
    pet.machine.notifyAnimationEnded(); expect(pet.machine.snapshot().form).toBe('unlit')
    hero.setPresence({ ...connected, news: { ...connected.news, unread: 1 } } as any)
    pet.machine.notifyAnimationEnded()
    expect(pet.machine.snapshot().form).toBe('lit')
    expect(observed).not.toContain('receive'); expect(observed).not.toContain('done')
  })
  it('keeps canonical artwork when the motion catalog is unavailable', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: (async () => new Response('', { status: 503 })) as any, preload: () => {} } })
    expect(await hero.ready).toBeNull()
    expect(button.querySelector('.now-pet-stage')).toBeNull()
    expect(button.dataset.runtime).toBeUndefined()
    expect(button.querySelectorAll('img')).toHaveLength(2)
    hero.destroy(); warning.mockRestore(); expect(vi.getTimerCount()).toBe(0)
  })
  it('late image error events cannot restart the real pet after hero destruction', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: fetchManifest as any, preload: () => {} } })
    hero.setPresence(connected as any); const pet = await hero.ready
    const img = button.querySelector('.now-pet-sprite') as HTMLImageElement
    const before = img.src, warnings = [...pet!.warnings]
    hero.destroy(); expect(vi.getTimerCount()).toBe(0)
    img.dispatchEvent(new Event('error'))
    expect(vi.getTimerCount()).toBe(0)
    expect(img.src).toBe(before)
    expect(pet!.warnings).toEqual(warnings)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('destroy before a delayed manifest finishes leaves no runtime nodes or timers', async () => {
    vi.useFakeTimers(); const { root, button } = dom()
    let resolve!: (value: Response) => void
    const hero = mountNowHero({ root, button, petOptions: { fetchImpl: (() => new Promise<Response>(r => { resolve = r })) as any, preload: () => {} } })
    const img = button.querySelector('.now-pet-sprite') as HTMLImageElement
    hero.setPresence(connected as any); hero.destroy()
    resolve(new Response(JSON.stringify(manifest))); await hero.ready
    const before = img.src
    img.dispatchEvent(new Event('error'))
    expect(img.src).toBe(before)
    expect(button.querySelector('.now-pet-stage')).toBeNull()
    expect(button.dataset.runtime).toBeUndefined()
    expect(button.querySelectorAll('img')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
