import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../../../src/lib/read-json-file'
import { fillMobileTemplate, inlineScriptJson } from '../../../src/features/phone/mobile-page-template'

// Same synthetic facts against immutable before/after product snapshots.
// The left case deliberately moves CC within the page to exercise actual relative geometry.
test('captures evidence-driven gaze and a bounded text response', async ({ page, shim, shimUrl }) => {
  test.setTimeout(65000)
  const out = process.env.WECHAT_CC_DESIGN_SHOTS, capture = process.env.CC_UI_CAPTURE_PHASE ?? 'after'
  test.skip(!out, 'mini lab evidence only')
  await mkdir(out!, { recursive: true })
  await shim.invoke('demo.unseed'); await shim.invoke('demo.seed', {})
  let running = false, text = '', cursor = 0, revision = 0
  let ids = ['baseline']
  await page.route('**/__dev_reload.js', r => r.fulfill({ contentType: 'application/javascript', body: '' }))
  await page.route('**/v1/protocol/capabilities', r => r.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/window**', r => r.fulfill({ json: { messages: [], earlier: null, later: null } }))
  await page.route('**/v1/matter/owner-chat/work**', r => r.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/workbench/attention', r => r.fulfill({ json: { tasks: [], progress: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', r => r.fulfill({ json: { running: running ? { turnId: 'actual' } : null, events: text ? [{ id: 'fragment', turnId: 'actual', kind: 'agent_message', text, cursor: ++cursor, createdAt: Date.now() }] : [], cursor } }))
  await page.route('**/v1/memory/topics?**', r => r.fulfill({ json: { topics: ids.map(id => ({ id, title: `${id} ${revision}`, bubbleState: 'open', matterSummary: { waiting: 0, running: 0, total: 0 } })), revision: String(revision), nextCursor: null } }))
  await page.route('**/v1/subscribe/topics?**', r => r.fulfill({ json: { revision: String(revision), recentIds: ids, openIds: ids, hasMoreOpen: false } }))
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  const stage = page.locator('#now-cc .now-pet-stage'), sprite = stage.locator('.now-pet-sprite')
  await expect(page.locator('#now-cc')).toHaveAttribute('data-runtime', 'ready')
  await expect(stage).toHaveAttribute('data-form', 'lit')
  await expect(page.locator('[data-topic-id="baseline"]')).toBeVisible()
  // Topics can arrive before main has mounted its hero. Establish a fresh
  // readable baseline after the hero is ready, without inventing a new ID.
  revision++
  await expect(page.locator('[data-topic-id="baseline"]')).toContainText('baseline 1')
  const shot = (name: string) => page.screenshot({ path: join(out!, `desktop-${name}-${capture}.png`) })
  await shot('idle')
  await page.locator('#converse-input').fill('主人正在输入')
  await expect(stage).toHaveAttribute('data-cc-phase', 'listening')
  if (capture === 'after') await expect(sprite).toHaveAttribute('src', /attention\/lit\/input-up/)
  await shot('input-up'); await page.locator('#converse-input').blur()
  running = true; await expect(stage).toHaveAttribute('data-cc-phase', 'thinking')
  text = '新到的真实文本片段'; await expect(stage).toHaveAttribute('data-cc-phase', 'speaking')
  if (capture === 'after') await expect(sprite).toHaveAttribute('src', /attention\/lit\/speaking\/00[12]/)
  await shot('speaking-000'); await page.waitForTimeout(100); await shot('speaking-001')
  running = false; text = ''; await expect(stage).toHaveAttribute('data-cc-phase', 'idle')
  ids.push('right'); revision++
  if (capture === 'after') await expect(sprite).toHaveAttribute('src', /attention\/lit\/right/)
  else await expect(stage).toHaveAttribute('data-behavior', 'look')
  await shot('topic-right')
  await page.waitForTimeout(12500)
  await page.addStyleTag({ content: '#now-cc { transform: translateX(500px); }' })
  ids.push('left'); revision++
  if (capture === 'after') await expect(sprite).toHaveAttribute('src', /attention\/lit\/left/)
  else await expect(stage).toHaveAttribute('data-behavior', 'look')
  await shot('topic-left')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('#converse-input').fill('减少动态仍可输入')
  await expect(stage).toHaveAttribute('data-cc-phase', 'idle')
  if (capture === 'after') await expect(sprite).not.toHaveAttribute('src', /attention\//)
  await shot('reduced-static')
})

test('PWA reads the same live activity contract and keeps idle/reduced/failed reads static', async ({ page, shimUrl }) => {
  test.skip(process.env.CC_UI_CAPTURE_PHASE === 'before', 'PWA reader is introduced in this batch')
  const out = process.env.WECHAT_CC_DESIGN_SHOTS
  test.skip(!out, 'mini lab evidence only')
  await mkdir(out!, { recursive: true })
  let running = false, text = '', failed = false, cursor = 0
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const art = readJsonFile<{ lit: { base64: string }; unlit: { base64: string } }>(fileURLToPath(new URL('../../../src/features/phone/mobile-presence-art.json', import.meta.url)))
  const mobilePage = readJsonFile<{ phone: string }>(fileURLToPath(new URL('../../../src/features/phone/mobile-page.generated.json', import.meta.url)))
  await page.route(`${shimUrl}/**`, route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/m') return route.fulfill({ contentType: 'text/html', body: fillMobileTemplate(mobilePage.phone, { TOKEN_JSON: inlineScriptJson('dDEVICE'), REMOTE_JSON: inlineScriptJson(null) }) })
    if (path === '/m/sw.js') return route.fulfill({ contentType: 'application/javascript', body: '' })
    if (path === '/v1/home') return route.fulfill({ json: { ok: true, synced_at: new Date().toISOString(), presence: { presence: 'ok', activity: { kind: 'idle', label: '' } }, work: { focus: null, partial: false } } })
    if (path === '/v1/phone/art/presence') return route.fulfill({ json: { ok: true, mime: 'image/png', lit: art.lit.base64, unlit: art.unlit.base64 } })
    if (path === '/v1/matters') return route.fulfill({ json: { matters: [], nextCursor: null } })
    if (path === '/v1/matter/owner-chat/page') return route.fulfill({ json: { ok: true, conversation: 'v1', matterId: 'owner', messages: [], hasMore: false, pending: null } })
    if (path === '/v1/matter/owner-chat/events') return failed ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { running: running ? { turnId: 'actual' } : null, cursor: ++cursor, events: text ? [{ id: 'fragment', turnId: 'actual', kind: 'agent_message', text }] : [] } })
    return route.fulfill({ status: 404, json: { ok: false } })
  })
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${shimUrl}/m`)
  const cc = page.locator('#small-cc')
  await expect(cc).toHaveClass(/lit/); await expect(page.locator('#conversation')).toBeVisible()
  await expect.poll(() => cc.locator('.cc-header-light').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  await expect(cc).toHaveAttribute('data-cc-phase', 'idle')
  await page.screenshot({ path: join(out!, 'pwa-idle-before.png') })
  await page.locator('#chat-input').fill('主人正在输入'); await expect(cc).toHaveAttribute('data-cc-phase', 'listening')
  await page.screenshot({ path: join(out!, 'pwa-listening-after.png') }); await page.locator('#chat-input').blur()
  running = true; await expect(cc).toHaveAttribute('data-cc-phase', 'thinking')
  await page.screenshot({ path: join(out!, 'pwa-thinking-after.png') })
  text = '只由新片段触发文字回应'; await expect(cc).toHaveAttribute('data-cc-phase', 'speaking')
  await expect(cc).toHaveAttribute('data-cc-response', 'acting')
  await page.screenshot({ path: join(out!, 'pwa-speaking-000.png') }); await page.waitForTimeout(250)
  await page.screenshot({ path: join(out!, 'pwa-speaking-250.png') })
  await expect(cc).toHaveAttribute('data-cc-phase', 'thinking')
  await page.emulateMedia({ reducedMotion: 'reduce' }); text += '，减少动态'
  await expect(cc).toHaveAttribute('data-cc-phase', 'speaking'); await expect(cc).toHaveAttribute('data-cc-response', 'static')
  await expect(cc.locator('.cc-header-light')).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: join(out!, 'pwa-reduced-static.png') })
  failed = true; await expect(cc).toHaveAttribute('data-cc-phase', 'idle')
  await page.screenshot({ path: join(out!, 'pwa-failed-read-static.png') })
  expect(errors).toEqual([])
})
