// 「连接手机」(plan 7a):设置抽屉的弹层。驱动 test-shim(DRY_RUN)的 /v1/phone/* 演示路由。
import { test, expect, reveal } from './fixtures'

const URL1 = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
const ready = () => ({ ok: true, state: 'ready', url: URL1, expires_at: Date.now() + 600_000 })
const dev = (id: string, label?: string) => ({ id, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), ...(label ? { label } : {}) })

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function openConnect(page: import('@playwright/test').Page) {
  await reveal(page, '#open-phone-settings')
  await expect(page.locator('#open-phone-settings')).toHaveText('连接手机')
  await page.locator('#open-phone-settings').click()
  await expect(page.locator('#phone-connect-title')).toHaveText('连接手机')
}

test('出码 → 手机配上 → 「已连上 Tendhearth · iPhone」;请求带 enable_remote', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [ready()], devices: [[dev('old')], [dev('old')], [dev('old'), dev('new1', 'Tendhearth · iPhone')]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-qr')).toBeVisible()
  await expect(page.locator('#phone-connect-note')).toHaveText('用手机相机扫一下。10 分钟内有效，只能用一次。')
  await expect(page.locator('#phone-connect-paired')).toHaveText('已连上 Tendhearth · iPhone', { timeout: 15_000 })
  await expect(page.locator('#phone-connect-close')).toHaveText('完成')
  const calls = await shim.invoke('mock.phone-calls') as { result: { calls: unknown[] } }
  expect(calls.result.calls[0]).toEqual({ enable_remote: true })
  await page.locator('#phone-connect-close').click()
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
})

test('中继没开通 ⇒ 说明,不出码', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-notice')).toHaveText('手机连接服务还没开通')
  await expect(page.locator('#phone-connect-qr')).toHaveCount(0)
})

test('正在打开隧道 ⇒ 等一下 ⇒ 出码', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'starting' }, ready()], devices: [[]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-starting')).toHaveText('正在打开手机连接，CC 会重启一下。')
  await expect(page.locator('#phone-connect-qr')).toBeVisible({ timeout: 10_000 })
})

test('页面上再也没有「手机扫码改设置」', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  expect(await page.content()).not.toContain('手机扫码改设置')
})
