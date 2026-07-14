import { test, expect } from '@playwright/test'

test('animation lab responds to fish and bear pointer zones', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.goto('http://127.0.0.1:8000/animation-lab.html')
  const canvas = page.locator('#companion-stage')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('animation canvas is missing')

  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .36)
  await expect(page.locator('#stage-hint')).not.toHaveClass(/is-visible/)

  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .5)
  await expect(page.locator('#stage-hint')).toContainText('它们发现你了')
  await page.waitForTimeout(1600)
  await page.screenshot({ path: '/tmp/animation-lab-pointer.png' })

  await page.mouse.click(box.x + box.width * .72, box.y + box.height * .5)
  await expect(page.locator('#stage-hint')).toContainText('一下躲开了')
  await page.waitForTimeout(250)
  await page.screenshot({ path: '/tmp/animation-lab-scatter.png' })

  await page.mouse.move(box.x + box.width * .50, box.y + box.height * .70)
  await page.waitForTimeout(360)
  await page.screenshot({ path: '/tmp/animation-lab-lotus-closed.png' })

  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(page.locator('#bear-message')).toHaveClass(/is-visible/)
  await page.waitForTimeout(360)
  await page.screenshot({ path: '/tmp/animation-lab-bear-wave.png' })

  await page.mouse.move(box.x + box.width * .46, box.y + box.height * .34)
  await page.waitForTimeout(360)
  await page.screenshot({ path: '/tmp/animation-lab-bear-leave-wave.png' })

  await page.mouse.click(box.x + box.width * .84, box.y + box.height * .64)
  await expect(page.locator('#stage-hint')).toContainText('小螃蟹')
  await page.waitForTimeout(1880)
  await page.screenshot({ path: '/tmp/animation-lab-crab-escape.png' })
})
