import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

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
  await page.route('**/v1/memory/topics?**', r => r.fulfill({ json: { topics: ids.map(id => ({ id, title: id, bubbleState: 'open', matterSummary: { waiting: 0, running: 0, total: 0 } })), revision: String(revision), nextCursor: null } }))
  await page.route('**/v1/subscribe/topics?**', r => r.fulfill({ json: { revision: String(revision), recentIds: ids, openIds: ids, hasMoreOpen: false } }))
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  const stage = page.locator('#now-cc .now-pet-stage'), sprite = stage.locator('.now-pet-sprite')
  await expect(page.locator('#now-cc')).toHaveAttribute('data-runtime', 'ready')
  await expect(stage).toHaveAttribute('data-form', 'lit')
  await expect(page.locator('[data-topic-id="baseline"]')).toBeVisible()
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
