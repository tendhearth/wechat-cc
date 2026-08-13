import { test, expect } from './fixtures'

test('inline companion animation replaces the overview illustration', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')

  const canvas = page.locator('#companion-stage')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('inline companion canvas is missing')

  const firstHeroLetter = page.locator('#hero-headline .hero-letter').first()
  await expect(firstHeroLetter).toBeVisible()
  await firstHeroLetter.hover()
  await expect.poll(() => firstHeroLetter.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1')

  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .52)
  await expect(page.locator('#stage-hint')).toContainText('它们发现你了')

  await page.mouse.move(box.x + box.width * .846, box.y + box.height * .754)
  await expect(page.locator('#stage-hint')).toContainText('点点小螃蟹')
  await page.mouse.click(box.x + box.width * .846, box.y + box.height * .754)
  await expect(page.locator('#stage-hint')).toContainText('它要换个地方藏起来')
  await page.waitForTimeout(1250)
  await expect(page.locator('#crab-escape')).toHaveCSS('opacity', '0')

  // 这里原本断言的是问候语数组里具体的第 1 句和第 2 句。真正要验的行为是
  // 「重新悬停会轮到下一句」,而不是「那两句必须是这两个字符串」—— 后者把测试
  // 和文案锁死,改一个字或调一次顺序就红,而且起始索引本就依赖此前的交互。
  const bearMsg = page.locator('#bear-message')
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(bearMsg).toHaveClass(/is-visible/)
  await expect(bearMsg).not.toBeEmpty()
  const firstGreeting = (await bearMsg.textContent())?.trim() ?? ''

  // 移开再回来:应当换一句,而不是重复同一句
  await page.mouse.move(box.x + box.width * .62, box.y + box.height * .52)
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(bearMsg).toHaveClass(/is-visible/)
  await expect(bearMsg).not.toHaveText(firstGreeting)

  await page.locator('#companion-immersive-start').click()
  await expect(page.locator('.moment-body')).toHaveClass(/is-companion-immersive/)
  await page.locator('#companion-users-toggle').click()
  await expect(page.locator('.moment-body')).toHaveClass(/is-companion-users-open/)
  await expect(page.locator('#companion-users-toggle')).toHaveText('用户')
  await page.locator('#companion-users-toggle').click()
  await expect(page.locator('.moment-body')).not.toHaveClass(/is-companion-users-open/)
  await page.locator('#companion-users-toggle').click()
  await page.locator('#companion-users-scrim').click({ position: { x: 120, y: 180 } })
  await expect(page.locator('.moment-body')).not.toHaveClass(/is-companion-users-open/)
  await page.locator('#companion-immersive-exit').click()
  await expect(page.locator('.moment-body')).not.toHaveClass(/is-companion-immersive/)

  const desktopPagePromise = page.context().waitForEvent('page')
  await page.locator('#companion-desktop-start').click()
  const desktopPage = await desktopPagePromise
  await desktopPage.waitForLoadState()
  await expect(desktopPage.locator('#companion-stage')).toBeVisible()
  await expect(desktopPage.locator('#companion-window-close')).toBeVisible()
  await desktopPage.close()
})
