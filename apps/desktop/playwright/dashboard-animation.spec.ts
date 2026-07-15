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

  await page.mouse.move(box.x + box.width * .84, box.y + box.height * .64)
  await expect(page.locator('#stage-hint')).toContainText('点一点水草')
  await page.mouse.click(box.x + box.width * .84, box.y + box.height * .64)
  await expect(page.locator('#stage-hint')).toContainText('小螃蟹溜出去')
  await page.waitForTimeout(1750)
  await expect(page.locator('#crab-escape')).not.toHaveCSS('opacity', '0')

  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(page.locator('#bear-message')).toHaveText('我在这儿陪你看鱼。')
  await page.mouse.move(box.x + box.width * .62, box.y + box.height * .52)
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(page.locator('#bear-message')).toHaveText('今天的水光很好看呀。')

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
})
