import { test, expect } from './fixtures'

// 这条用例原本是一个"伪装成测试的人工看图脚本":硬编码 http://127.0.0.1:8000
// (那个端口上没有服务,CI 里必然 ERR_CONNECTION_REFUSED)、往 /tmp 存 5 张
// 没人会看的截图、并断言特定指针坐标上会出现哪一句具体文案。
//
// 最后一条断言(点击某坐标应出现"小螃蟹")尤其不可能稳定 —— 螃蟹是会自己移动
// 的,它的位置本来就不固定。
//
// 现在改为断言**稳定的不变量**:动画舞台会对指针作出反应。这仍然能抓到真正的
// 回归(舞台不再响应指针、提示不再出现),但不再和具体文案与生物的瞬时位置耦合。
test('animation lab responds to pointer', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.goto(new URL('animation-lab.html', shimUrl).href)

  const canvas = page.locator('#companion-stage')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('animation canvas is missing')

  const hint = page.locator('#stage-hint')

  // 空白区域:不该有提示
  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .36)
  await expect(hint).not.toHaveClass(/is-visible/)

  // 移到鱼群所在的高度:提示出现且有内容(不断言具体是哪句)
  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .5)
  await expect(hint).toHaveClass(/is-visible/)
  await expect(hint).not.toBeEmpty()
  const afterHover = (await hint.textContent())?.trim() ?? ''

  // 点一下:舞台状态应当变化(文案换了一句),证明它在响应交互而不只是常显
  await page.mouse.click(box.x + box.width * .72, box.y + box.height * .5)
  await expect(hint).not.toHaveText(afterHover)

  // 熊那一侧:它自己的气泡出现
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(page.locator('#bear-message')).toHaveClass(/is-visible/)
})
