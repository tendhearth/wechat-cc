import { test, expect, reveal } from './fixtures'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
async function shot(page: import('@playwright/test').Page, name: string) {
  const out = process.env.WECHAT_CC_SECONDARY_SHOTS
  if (out) { mkdirSync(out, { recursive: true }); await page.screenshot({ path: join(out, name + '.png'), animations: 'disabled' }) }
}

const ready = () => ({ ok: true, state: 'ready', url: `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`, expires_at: Date.now() + 600_000, check_code: 'USZ-YAY' })
// Rust render_qr_svg dimensions; the dry shim's 77px placeholder hides overflow.
const nativeQr = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220"><rect width="220" height="220" fill="white"/><path d="M20 20H80V80H20Z M140 20H200V80H140Z M20 140H80V200H20Z" fill="black"/></svg>'
async function boot(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => !!document.documentElement.dataset.mode && document.documentElement.dataset.mode !== 'loading')
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function insideViewport(locator: import('@playwright/test').Locator, page: import('@playwright/test').Page) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const size = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
}

test('real 220px phone QR scrolls at 760×280 with close/copy reachable and modal focus restored', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'secondary_completion', phone: { link: [ready()], devices: [[]] } })
  await page.route('**/__invoke', async route => {
    if (route.request().postDataJSON().command === 'render_qr_svg') return route.fulfill({ json: { result: nativeQr } })
    return route.continue()
  })
  await page.setViewportSize({ width: 760, height: 280 })
  await boot(page, shimUrl)
  await reveal(page, '#open-phone-settings')
  await page.locator('#open-phone-settings').click()
  await expect(page.locator('#phone-connect-qr svg')).toHaveAttribute('width', '220')
  await insideViewport(page.locator('#phone-settings-modal .qr-card'), page)
  await shot(page, 'phone-qr-760x280')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#phone-settings-modal'))).toBe(true)
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('#phone-settings-modal'))).toBe(true)
  }
  await page.locator('#settings-open').evaluate((el: HTMLElement) => el.focus())
  expect(await page.evaluate(() => !!document.activeElement?.closest('#phone-settings-modal'))).toBe(true)
  await page.locator('#phone-connect-copy').scrollIntoViewIfNeeded()
  await insideViewport(page.locator('#phone-connect-copy'), page)
  await page.locator('#phone-connect-close').scrollIntoViewIfNeeded()
  await insideViewport(page.locator('#phone-connect-close'), page)
  await shot(page, 'phone-qr-actions-760x280')
  await page.keyboard.press('Escape')
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
  await expect(page.locator('#open-phone-settings')).toBeFocused()
})

for (const viewport of [{ width: 1400, height: 850 }, { width: 760, height: 280 }]) {
  test(`AI service menu fits ${viewport.width}×${viewport.height} and keyboard reaches every option`, async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'secondary_completion' })
    await page.setViewportSize(viewport)
    await boot(page, shimUrl)
    await reveal(page, '.provider-switch')
    await page.locator('.provider-switch').click()
    const menu = page.locator('#provider-menu')
    await expect(menu).toBeVisible()
    await insideViewport(menu, page)
    await shot(page, `provider-${viewport.width}x${viewport.height}`)
    await expect(menu.locator('button').first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.locator('button').last()).toBeFocused()
    await insideViewport(menu.locator('button').last(), page)
    await page.keyboard.press('Home')
    await expect(menu.locator('button').first()).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(menu.locator('button').last()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(page.locator('.provider-switch')).toBeFocused()
  })
}

test('service menu survives the real background refresh and returns keyboard focus to its entry', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'secondary_completion' })
  await boot(page, shimUrl)
  await reveal(page, '.provider-switch')
  await page.locator('.provider-switch').click()
  await expect(page.locator('#provider-menu')).toBeVisible()
  // The production doctor interval is 5s; a rebuilt account row used to detach
  // the opener while a keyboard user was still choosing a service.
  await page.waitForTimeout(5500)
  await page.setViewportSize({ width: 760, height: 280 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))))
  await insideViewport(page.locator('#provider-menu'), page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.provider-switch')).toBeFocused()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
})

test('phone loading, request error, expiry and renewal keep the same reachable close action', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'secondary_completion', phone: { link: [ready()], devices: [[]] } })
  await page.route('**/__invoke', async route => {
    if (route.request().postDataJSON().command === 'render_qr_svg') return route.fulfill({ json: { result: nativeQr } })
    return route.continue()
  })
  let pending: import('@playwright/test').Route | undefined
  await page.route('**/v1/phone/link', route => { pending = route })
  await page.setViewportSize({ width: 760, height: 280 })
  await boot(page, shimUrl)
  await reveal(page, '#open-phone-settings')
  await page.locator('#open-phone-settings').click()
  await expect.poll(() => !!pending).toBe(true)
  await expect(page.locator('#phone-connect-close')).toBeFocused()
  await shot(page, 'phone-loading-760x280')
  await pending!.fulfill({ status: 503, json: { error: 'temporary_unavailable' } })
  await expect(page.locator('#phone-connect-error')).toBeVisible()
  await shot(page, 'phone-error-760x280')
  await page.keyboard.press('Escape')
  await page.unroute('**/v1/phone/link')
  await shim.invoke('demo.seed', { chat_id: 'secondary_completion', phone: { link: [{ ...ready(), expires_at: Date.now() + 1200 }], devices: [[]] } })
  await page.locator('#open-phone-settings').click()
  await expect(page.locator('#phone-connect-qr')).toBeVisible()
  await expect(page.locator('#phone-connect-renew')).toBeVisible({ timeout: 7000 })
  await shot(page, 'phone-expired-760x280')
  await shim.invoke('demo.seed', { chat_id: 'secondary_completion', phone: { link: [ready()], devices: [[]] } })
  await page.locator('#phone-connect-renew').click()
  await expect(page.locator('#phone-connect-qr')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#open-phone-settings')).toBeFocused()
})
