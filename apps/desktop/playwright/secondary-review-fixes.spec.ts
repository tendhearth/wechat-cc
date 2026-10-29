import { test, expect, clickNav } from './fixtures'
import { secondaryFixtures, owner } from './secondary-fixtures'
import type { Page } from '@playwright/test'

async function boot(page: Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')
}

for (const entry of ['review', 'archive', 'archive-navigation'] as const) test(`late ${entry} memory A cannot replace B's exact save identity or draft`, async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: owner })
  await secondaryFixtures(page)
  await boot(page, shimUrl)
  await clickNav(page, 'memory')
  await expect(page.locator('#memory-facts-edit')).toBeEnabled()
  await page.route('**/v1/memory/view', r => r.fulfill({ json: { ok: false } }))
  let lateA: import('@playwright/test').Route | undefined
  await page.route('**/v1/memory/file?**', route => {
    if (!lateA && new URL(route.request().url()).searchParams.get('path') === 'memory.md') lateA = route
    else void route.fallback()
  })
  const writes: unknown[] = []
  await page.route('**/v1/memory/file/write', route => {
    writes.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, bytesWritten: 26 } })
  })
  if (entry === 'review') await page.locator('#memory-facts-edit').click()
  else {
    await page.locator('#memory-sources-toggle').click()
    await page.locator('#memory-archive-toggle').click()
    await page.locator('.mem-file[data-path="memory.md"]').click()
  }
  await expect.poll(() => !!lateA).toBe(true)
  if (entry === 'archive-navigation') {
    await clickNav(page, 'todos')
    await clickNav(page, 'memory')
  }
  await page.locator('.mem-file[data-path="notes/raw.md"]').click()
  await expect(page.locator('#memory-content-path')).toContainText('notes/raw.md')
  await expect(page.locator('#memory-edit-btn')).toBeVisible()
  await page.locator('#memory-edit-btn').click()
  const draft = 'B 的草稿 / B draft stays exact'
  await page.locator('#memory-editor').fill(draft)
  await lateA!.fulfill({ json: { ok: true, content: 'A 的迟到原文', path: 'memory.md' } })
  if (entry === 'review') await expect(page.locator('#memory-facts-edit')).toBeEnabled()
  // Let the actual response and its continuation finish before pressing Save.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
  await expect(page.locator('#memory-editor')).toHaveValue(draft)
  await page.locator('#memory-save-btn').click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toEqual({ userId: owner, path: 'notes/raw.md', content: draft })
})

async function phoneFixture(page: Page, shimUrl: string, expired = false) {
  await page.route('**/review-phone.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><button id="opener">连接手机</button><button id="background">背景</button></body></html>' }))
  await page.goto(new URL('/review-phone.html', shimUrl).href)
  await page.evaluate(async initiallyExpired => {
    const { mountPhoneConnect } = await import('/modules/phone-connect.js')
    const w = window as any
    w.phoneTime = 1000
    w.phoneExpired = initiallyExpired
    w.phoneController = mountPhoneConnect({
      call: async (method: string) => method === 'GET' ? { ok: true, devices: [] } : { ok: true, state: 'ready', url: 'https://fixture.example/pair', expires_at: w.phoneExpired ? w.phoneTime - 1 : w.phoneTime + 1000 },
      renderQr: async () => '<svg width="220" height="220" viewBox="0 0 220 220"></svg>',
      flowDeps: { now: () => w.phoneTime, sleep: () => new Promise(resolve => { w.releasePhoneSleep = resolve }) },
    })
    document.getElementById('opener')!.addEventListener('click', () => w.phoneController.open())
  }, expired)
  await page.locator('#opener').click()
}

test('phone copy focus is rehomed inside after expiry removes the focused button', async ({ page, shimUrl }) => {
  await phoneFixture(page, shimUrl)
  await page.locator('#phone-connect-copy').focus()
  await page.evaluate(() => { const w = window as any; w.phoneTime = 3000; w.releasePhoneSleep() })
  await expect(page.locator('#phone-connect-renew')).toBeVisible()
  expect(await page.evaluate(() => !!document.activeElement?.closest('#phone-settings-modal'))).toBe(true)
  await expect(page.locator('#phone-connect-close')).toBeFocused()
})

test('phone renew focus is rehomed during replacement without moving a still-valid close focus', async ({ page, shimUrl }) => {
  await phoneFixture(page, shimUrl, true)
  await page.locator('#phone-connect-renew').focus()
  await page.evaluate(() => { (window as any).phoneExpired = false })
  await page.keyboard.press('Enter')
  await expect(page.locator('#phone-connect-copy')).toBeVisible()
  await expect(page.locator('#phone-connect-close')).toBeFocused()
  await page.evaluate(() => { const w = window as any; w.phoneTime = 4000; w.releasePhoneSleep() })
  await expect(page.locator('#phone-connect-renew')).toBeVisible()
  await expect(page.locator('#phone-connect-close')).toBeFocused()
})

async function menuFixture(page: Page, shimUrl: string) {
  await page.route('**/review-menu.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><button id="previous">Previous</button><button id="opener" class="provider-switch">AI 服务</button><button id="next">Next</button><div id="provider-menu" hidden></div><button id="last">Last</button></body></html>' }))
  await page.goto(new URL('/review-menu.html', shimUrl).href)
  await page.evaluate(async () => {
    const { toggleProviderMenu } = await import('/modules/dashboard.js')
    document.getElementById('opener')!.addEventListener('click', () => {
      void toggleProviderMenu({ invokeApi: async () => ({ ok: true, registered: ['claude', 'codex'] }) }, { checks: { provider: { provider: 'claude' } } })
    })
  })
}
for (const key of ['Tab', 'Shift+Tab']) test(`portalled service menu ${key} follows the opener's document order`, async ({ page, shimUrl }) => {
  await menuFixture(page, shimUrl)
  await page.locator('#opener').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#provider-menu button').first()).toBeFocused()
  await page.keyboard.press(key)
  await expect(page.locator('#provider-menu')).toBeHidden()
  await expect(page.locator(key === 'Tab' ? '#next' : '#previous')).toBeFocused()
})
test('keyboard selecting the active service restores entry focus', async ({ page, shimUrl }) => {
  await menuFixture(page, shimUrl)
  await page.locator('#opener').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#provider-menu [data-provider="claude"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#provider-menu')).toBeHidden()
  await expect(page.locator('#opener')).toBeFocused()
})

test('memory and plugin static copy is concise Chinese while English record data is preserved', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: owner })
  await secondaryFixtures(page)
  await page.route('**/v1/memory/view', route => route.fulfill({ json: { ok: true, chatId: owner, path: 'memory.md', baseHash: 'a'.repeat(64), lines: [{ text: 'My real note stays in English.', origin: 'owner', assertionId: 'o1' }] } }))
  await boot(page, shimUrl)
  await clickNav(page, 'memory')
  await expect(page.locator('#memory-facts-edit')).toHaveText('纠正')
  await expect(page.locator('#memory-facts-edit')).toHaveAccessibleName('查看并纠正记忆')
  await expect(page.locator('.memory-facts-head p')).toHaveCount(0)
  await expect(page.locator('#memory-facts-search')).toHaveAccessibleName('查找记忆')
  await expect(page.locator('.memory-facts-search-label')).toHaveCount(0)
  await expect(page.locator('#memory-facts-records')).toContainText('My real note stays in English.')
  await expect(page.locator('.memory-profile-disclosure > summary')).toHaveText('CC 眼中的你 · 推测画像')
  await clickNav(page, 'sessions')
  await page.locator('article[data-pane="sessions"] [data-backstage-pane="plugins"]').click()
  const instructions = page.locator('.plugins-install-details')
  await expect(instructions).not.toHaveAttribute('open')
  await expect(instructions.locator('code')).toBeHidden()
  await expect(page.locator('article[data-pane="plugins"]')).toContainText('重启 CC 生效')
  await expect(page.locator('#plugins-list')).toContainText('尚未完成认证')
  await instructions.locator('summary').click()
  await expect(instructions.locator('code')).toBeVisible()
})
