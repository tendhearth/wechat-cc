import { test, expect, clickRevealed } from './fixtures'

// 鱼缸画布(「进入这一刻」「浮到桌面」的舞台)2026-10-01 主人拍板退休。浮窗桌宠本身还在:
// 唯一入口是此刻页右上连接面板里的「浮到桌面」按钮。动画实验室(animation-lab.html)另有用例。
test('浮到桌面 opens the floating CC pet window', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true, presence: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } })
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')

  await expect(page.locator('#companion-stage')).toHaveCount(0)
  const desktopPagePromise = page.context().waitForEvent('page')
  await clickRevealed(page, '#companion-desktop-start')
  const desktopPage = await desktopPagePromise
  await desktopPage.waitForLoadState()
  await expect(desktopPage.locator('#pet-stage')).toBeVisible()
  await expect(desktopPage.locator('#companion-window-close')).toBeVisible()
  await desktopPage.close()
})
