import { test, expect } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
})

test('quiet and reduced motion retain current activity and pending permission without stale Dark activity', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', {})
  await page.setViewportSize({ width: 240, height: 250 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    ;(window as any).__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      const response = await fetch('/__invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })
      const value = await response.json()
      if (value.error) throw new Error(value.error)
      return value.result
    } } }
  })
  let phase = 'thinking'
  let pending = false
  await page.route('**/v1/companion/pet', route => route.fulfill({ json: {
    owner_last_contact_at: null, last_done_at: null,
    turn: { phase, since: '2026-10-29T10:00:00Z' },
    pending_permissions: pending ? [{ hash: 'test-permission', prompt: 'private prompt', since: '2026-10-29T10:00:00Z', expires_at: '2026-10-30T10:00:00Z' }] : [],
  } }))
  await page.goto(new URL('companion-window.html?lab', shimUrl).href)
  const stage = page.locator('#pet-stage')
  const status = page.locator('#pet-connection')
  await expect(stage).toHaveAttribute('aria-label', 'CC，已连接，想一想')
  await page.getByText('陪伴设置', { exact: true }).click()
  await expect(status).toHaveText('已连接 · 想一想')
  await page.getByRole('button', { name: '安静一小时' }).click()
  await expect(stage).toHaveAttribute('aria-label', 'CC，已连接，想一想')
  phase = 'working'
  await expect(status).toHaveText('已连接 · 正在做')
  await expect(stage).toHaveAttribute('aria-label', 'CC，已连接，正在做')

  // Observe DOM announcements across another identical real bridge tick.
  await page.evaluate(() => {
    ;(window as any).__statusMutations = 0
    new MutationObserver(records => { (window as any).__statusMutations += records.length }).observe(document.getElementById('pet-connection')!, { childList: true, subtree: true, characterData: true })
    ;(window as any).__ariaMutations = 0
    new MutationObserver(records => { (window as any).__ariaMutations += records.length }).observe(document.getElementById('pet-stage')!, { attributes: true, attributeFilter: ['aria-label'] })
  })
  const repeated = await page.waitForResponse('**/v1/companion/pet')
  await repeated.finished()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect.poll(() => page.evaluate(() => [(window as any).__statusMutations, (window as any).__ariaMutations])).toEqual([0, 0])

  pending = true
  await expect(status).toHaveText('已连接 · 等你决定')
  await expect(stage).toHaveAttribute('aria-label', 'CC，已连接，等你决定')
  await expect(page.getByRole('checkbox', { name: '减少动作' })).toBeChecked()
  await expect(page.getByRole('button', { name: '恢复动作' })).toBeVisible()
  await shim.invoke('demo.seed', { presenceDown: true })
  // Resume uses the existing pollers to re-observe connection immediately.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(status).toHaveText('暂时联系不上')
  await expect(stage).toHaveAttribute('aria-label', 'CC，暂时联系不上')
  await expect(page.getByRole('button', { name: '找 CC', exact: true })).toBeVisible()
})
