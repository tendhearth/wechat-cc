import { join } from 'node:path'
import { test, expect, clickNav } from './fixtures'
const shots = join(process.cwd(), '../../.superpowers/now-hero-shots')
const pane = '.cc-now-pane', stage = '#now-cc .now-pet-stage', sprite = '#now-cc .now-pet-sprite'
async function openHome(page: import('@playwright/test').Page, url: string) {
  await page.goto(url)
  await expect(page.locator('main.dashboard')).toBeVisible()
  await expect(page.locator('#now-cc')).toHaveAttribute('data-runtime', 'ready')
  await expect(page.locator(stage)).toHaveAttribute('data-form', 'lit')
}
test.beforeEach(async ({ page, shim }) => {
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await shim.invoke('demo.unseed'); await shim.invoke('demo.seed', {})
})

test('home uses Light/Dark connection forms, one breathing layer and stable keyboard navigation', async ({ page, shimUrl }) => {
  let down = false
  await page.route('**/v1/workbench/attention', route => route.fulfill({ json: { tasks: [] } }))
  await page.route('**/v1/companion/presence', route => down ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } }))
  await openHome(page, shimUrl)
  await expect(page.locator(sprite)).toHaveAttribute('src', /canonical\/lit\/front\.png$/)
  const metrics = await page.locator('#now-cc').evaluate(el => {
    const b = el.getBoundingClientRect(), s = el.querySelector('.now-pet-sprite')!.getBoundingClientRect()
    return { width: b.width, spriteWidth: s.width, spriteHeight: s.height, clipped: getComputedStyle(el).overflow === 'hidden', canonicalVisible: [...el.querySelectorAll('.now-cc-light,.now-cc-dark')].filter(n => getComputedStyle(n).display !== 'none').length,
      animations: el.getAnimations({ subtree: true }).filter(a => (a as CSSAnimation).animationName === 'now-pet-breathe').length,
      paper: getComputedStyle(document.querySelector('.cc-now-pane')!).backgroundColor }
  })
  expect(metrics).toMatchObject({ width: 240, spriteWidth: 240, clipped: false, canonicalVisible: 0, animations: 1 })
  expect(metrics.spriteHeight).toBeGreaterThanOrEqual(240)
  expect(metrics.spriteHeight).toBeLessThan(245)
  expect(metrics.paper).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(shots, 'light-home.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('#now-cc')).toHaveCSS('width', '184px')
  await expect(page.locator(stage)).toHaveCSS('overflow', 'visible')
  await page.screenshot({ path: join(shots, 'light-home-small.png') })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator(stage)).toHaveAttribute('data-form', 'lit')
  await expect(page.locator(stage)).toHaveClass(/pet-motion-reduced/)
  await expect(page.locator(sprite)).toHaveCSS('animation-name', 'none')
  down = true; await clickNav(page, 'workbench'); await clickNav(page, 'overview')
  await expect(page.locator(pane)).toHaveAttribute('data-cc', 'away')
  await expect(page.locator(stage)).toHaveAttribute('data-form', 'unlit')
  await expect(page.locator(sprite)).toHaveAttribute('src', /\/(?:canonical|sprites|motion)\/unlit\//)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'sleep')
  await page.screenshot({ path: join(shots, 'dark-disconnected-home.png') })
  await page.locator('#now-cc').focus(); await page.keyboard.press('Enter')
  await expect(page.locator(pane)).toHaveAttribute('data-now', 'chat')
  await expect(page.locator(stage)).toHaveClass(/pet-paused/)
  await page.locator('#now-back').click()
  await expect(page.locator(stage)).toHaveAttribute('data-form', 'unlit')
})

test('real attention snapshots express a round reply once, preserve permission priority and consume hidden progress', async ({ page, shimUrl }) => {
  let phase = 'working', waiting = false, reads = 0
  await page.route('**/v1/workbench/attention', route => {
    reads++
    return route.fulfill({ json: { tasks: waiting ? [{ id: 'a', title: '真实待处理', providerId: 'codex', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["p1"]' }] : [], progress: [{ id: 'a', phase }] } })
  })
  await openHome(page, shimUrl)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'working')
  await page.locator(stage).evaluate(el => {
    ;(window as any).__nowBehaviors = []
    new MutationObserver(records => { for (const r of records) (window as any).__nowBehaviors.push(r.oldValue, el.getAttribute('data-behavior')) }).observe(el, { attributes: true, attributeFilter: ['data-behavior'], attributeOldValue: true })
  })
  phase = 'replied'
  await expect.poll(() => page.evaluate(() => (window as any).__nowBehaviors)).toContain('done')
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  waiting = true; phase = 'working'
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'permission', { timeout: 6000 })
  await expect(page.locator('#now-waiting-title')).toHaveText('1 件事等你')
  const previousReads = reads; phase = 'replied'
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'permission')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator(stage)).toHaveAttribute('data-form', 'lit')
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'permission')
  await page.screenshot({ path: join(shots, 'permission-reduced-home.png') })
  waiting = false; phase = 'working'
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'working', { timeout: 6000 })
  await page.locator('#now-cc').click()
  await expect(page.locator(stage)).toHaveClass(/pet-paused/)
  const hiddenReads = reads; phase = 'replied'
  await expect.poll(() => reads).toBeGreaterThan(hiddenReads)
  await page.locator('#now-back').click()
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  await expect(page.locator(stage)).not.toHaveClass(/pet-paused/)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(page.locator(stage)).not.toHaveClass(/pet-motion-reduced/)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
})

test('late shared history only updates the bubble; visible local pending can receive its actual reply', async ({ page, shimUrl }) => {
  await page.route('**/v1/workbench/attention', route => route.fulfill({ json: { tasks: [] } }))
  await page.route('**/v1/matter/owner-chat', route => route.fulfill({ json: { events: [{ kind: 'text', text: '以前的真实回复', createdAt: 1234567890 }] } }))
  let deliver!: () => void
  await page.route('**/__invoke', async route => {
    if (route.request().postDataJSON().command !== 'agent_converse') return route.fallback()
    await new Promise<void>(r => { deliver = r })
    return route.fulfill({ json: { result: { reply: '这轮实际回复', attachments: [], narration: [] } } })
  })
  await openHome(page, shimUrl)
  await expect(page.locator('#now-cc-bubble')).toContainText('以前的真实回复')
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  await page.locator('#converse-input').fill('请回复'); await page.locator('#converse-send').click()
  await expect(page.locator(pane)).toHaveAttribute('data-now', 'chat')
  await expect(page.locator(stage)).toHaveClass(/pet-paused/)
  await page.locator('#now-back').click()
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'thinking')
  await expect.poll(() => typeof deliver).toBe('function'); deliver()
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'receive')
  await expect(page.locator('#now-cc-bubble')).toContainText('这轮实际回复')
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  await page.locator('#now-cc-bubble').click(); await expect(page.locator(pane)).toHaveAttribute('data-now', 'chat')
  // The authoritative client snapshot on return must also consume a reply that already arrived in chat.
  await page.locator(stage).evaluate(el => {
    ;(window as any).__hiddenReplyBehaviors = []
    new MutationObserver(records => { for (const r of records) (window as any).__hiddenReplyBehaviors.push(r.oldValue, el.getAttribute('data-behavior')) }).observe(el, { attributes: true, attributeFilter: ['data-behavior'], attributeOldValue: true })
  })
  deliver = undefined as any
  await page.locator('#converse-input').fill('留在对话里等这轮回复'); await page.locator('#converse-send').click()
  await expect.poll(() => typeof deliver).toBe('function'); deliver()
  await expect(page.locator('#converse-send')).toBeEnabled()
  await page.locator('#now-back').click()
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  expect(await page.evaluate(() => (window as any).__hiddenReplyBehaviors)).not.toContain('receive')
  expect(await page.evaluate(() => (window as any).__hiddenReplyBehaviors)).not.toContain('done')
})

test('unavailable motion catalog retains canonical pictures and working navigation', async ({ page, shimUrl }) => {
  await page.route('**/assets/pet/cc-v1/manifest.json', route => route.fulfill({ status: 503, body: '' }))
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible()
  await expect(page.locator(pane)).toHaveAttribute('data-cc', 'here')
  await expect(page.locator('#now-cc .now-cc-light')).toBeVisible()
  await expect(page.locator('#now-cc .now-cc-dark')).toBeHidden()
  await expect(page.locator('#now-cc .now-pet-stage')).toHaveCount(0)
  expect(await page.locator('#now-cc .now-cc-light').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
  await page.locator('#now-cc').click(); await expect(page.locator(pane)).toHaveAttribute('data-now', 'chat')
})

test('a home snapshot reconciles suspended quiet without celebrating work completed during quiet', async ({ page, shimUrl }) => {
  await page.addInitScript(() => {
    const wallNow = Date.now
    ;(window as any).__quietWallOffset = 0
    Date.now = () => wallNow() + (window as any).__quietWallOffset
    localStorage.setItem('cc.companion.motion.v1', JSON.stringify({ quietUntil: wallNow() + 3_600_000 }))
  })
  let complete = false
  await page.route('**/v1/workbench/attention', async route => {
    if (complete) await page.evaluate(() => { (window as any).__quietWallOffset = 3_600_001 })
    return route.fulfill({ json: { tasks: [], progress: [{ id: 'a', phase: complete ? 'replied' : 'working' }] } })
  })
  await openHome(page, shimUrl)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'working')
  await expect(page.locator('#now-cc')).toHaveAttribute('data-motion', 'reduced')
  await page.locator(stage).evaluate(el => {
    ;(window as any).__quietBehaviors = []
    new MutationObserver(records => { for (const r of records) (window as any).__quietBehaviors.push(r.oldValue, el.getAttribute('data-behavior')) }).observe(el, { attributes: true, attributeFilter: ['data-behavior'], attributeOldValue: true })
  })
  complete = true
  await expect(page.locator('#now-cc')).toHaveAttribute('data-motion', 'full', { timeout: 6000 })
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('done')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('receive')
})


for (const recovery of ['pane', 'system']) test(`${recovery} recovery consumes a delayed fresh attention completion before the next live round`, async ({ page, shimUrl }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window)
    // Accelerate only the existing attention poller, keeping its request/subscriber path intact.
    window.setTimeout = ((fn: any, ms: number, ...args: any[]) => timeout(fn, ms === 3000 ? 100 : ms, ...args)) as any
  })
  let phase = 'working', hold = false, held = false, release!: () => void, replies = 0
  const gate = new Promise<void>(r => { release = r })
  await page.route('**/v1/workbench/attention', async route => {
    if (hold) { held = true; await gate }
    replies++
    return route.fulfill({ json: { tasks: [], progress: [{ id: 'a', phase }] } })
  })
  await openHome(page, shimUrl)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'working')
  if (recovery === 'pane') await page.locator('#now-cc').click()
  else await page.emulateMedia({ reducedMotion: 'reduce' })
  hold = true; await expect.poll(() => held).toBe(true)
  await page.locator(stage).evaluate(el => {
    const seen: string[] = []; (window as any).__recoveryBehaviors = seen
    new MutationObserver(records => {
      for (const b of [...records.map(r => r.oldValue), el.getAttribute('data-behavior')]) if (b && seen.at(-1) !== b) seen.push(b)
    }).observe(el, { attributes: true, attributeFilter: ['data-behavior'], attributeOldValue: true })
  })
  if (recovery === 'pane') await page.locator('#now-back').click()
  else await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(page.locator(stage)).not.toHaveClass(/pet-paused|pet-motion-reduced/)
  phase = 'replied'; hold = false; release()
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  expect(await page.evaluate(() => (window as any).__recoveryBehaviors)).not.toContain('done')
  phase = 'working'; await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'working')
  phase = 'replied'
  await expect.poll(() => page.evaluate(() => (window as any).__recoveryBehaviors.filter((b: string) => b === 'done').length)).toBe(1)
  await expect(page.locator(stage)).toHaveAttribute('data-behavior', 'idle')
  const before = replies; await expect.poll(() => replies).toBeGreaterThan(before)
  expect(await page.evaluate(() => (window as any).__recoveryBehaviors.filter((b: string) => b === 'done').length)).toBe(1)
})
