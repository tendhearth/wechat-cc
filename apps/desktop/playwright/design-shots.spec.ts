// 设计验收出图(spec 2026-10-01 §7)。只有设了 WECHAT_CC_DESIGN_SHOTS 才跑,CI 跳过。
import { join } from 'node:path'
import { test, expect, clickNav } from './fixtures'

const OUT = process.env.WECHAT_CC_DESIGN_SHOTS
// 面板 / 抽屉有滑入动画,等它停稳再拍,别拍到半路。
const settle = (page: any) => page.waitForTimeout(700)
test.skip(!OUT, 'set WECHAT_CC_DESIGN_SHOTS=<dir> to capture design screenshots')

async function boot(page: any, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode && document.documentElement.dataset.mode !== 'loading', { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function mockNow(page: any) {
  await page.route('**/v1/matter/owner-chat', (r: any) => r.fulfill({ json: { events: [
    { kind: 'user', text: '帮我看看下周出差', createdAt: Date.now() - 3_600_000 },
    { kind: 'text', text: '行程的几个备选方案整理好了，你看看？', createdAt: Date.now() - 1_800_000 } ] } }))
  await page.route('**/v1/workbench/attention**', (r: any) => r.fulfill({ json: { tasks: [
    { id: 't1', title: '让作品集在手机上更好看', providerId: 'claude', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["p1"]' },
    { id: 't2', title: '整理下周出差安排', providerId: 'claude', pendingPermissionCount: 0, pendingQuestionCount: 1, attentionKey: '["q1"]' } ] } }))
}

for (const [label, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 760, height: 1100 }]] as const) {
  test(`design shots · ${label}`, async ({ page, shimUrl, shim }) => {
    await page.setViewportSize(size)
    await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
    await mockNow(page)
    await boot(page, shimUrl)
    await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'here', { timeout: 25_000 })
    await expect(page.locator('#now-cc-bubble')).toBeVisible({ timeout: 10_000 })
    await settle(page)
    await page.screenshot({ path: join(OUT!, `d01-now-here-${label}.png`) })
    await page.locator('#now-cc').click()
    await settle(page)
    await page.screenshot({ path: join(OUT!, `d02-now-chat-${label}.png`) })
    // 一起做 面板会把全局侧栏收成 inert(要点开关才出),所以它放在最后拍;编号仍按侧栏顺序。
    const panes = ['workbench', 'recollections', 'memory', 'todos', 'a2a-agents', 'sessions'] as const
    for (const pane of [...panes.slice(1), panes[0]]) {
      await clickNav(page, pane)
      await settle(page)
    await page.screenshot({ path: join(OUT!, `d${String(panes.indexOf(pane) + 3).padStart(2, '0')}-${pane}-${label}.png`) })
    }
    await page.locator('#workbench-nav-toggle').click()
    await clickNav(page, 'overview')
    await page.locator('#settings-open').click()
    await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
    await settle(page)
    await page.screenshot({ path: join(OUT!, `d09-settings-${label}.png`) })
  })
}
test('design shots · away', async ({ page, shimUrl, shim }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await shim.invoke('demo.seed', { chat_id: 'test_chat', presenceDown: true })
  await mockNow(page)
  await boot(page, shimUrl)
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'away', { timeout: 25_000 })
  await settle(page)
    await page.screenshot({ path: join(OUT!, 'd10-now-away-wide.png') })
})
