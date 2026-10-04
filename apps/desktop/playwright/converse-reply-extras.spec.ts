/**
 * 「跟 CC 说」显示整个回复对象(回复交付,2026-10-04):过程(灰、默认收起)在回复之上,
 * 语音 / 表情 / 文件在回复之下。shim 的 agent_converse 在 DRY_RUN 下回演示回复对象(test-shim.ts)。
 *
 * 截图:设 WECHAT_CC_DESIGN_SHOTS=<dir> 时把这一轮存成 converse-reply-extras-*.png(与 design-shots.spec.ts 同一个开关)。
 */
import { join } from 'node:path'
import { test, expect } from './fixtures'

const SHOTS = process.env.WECHAT_CC_DESIGN_SHOTS

async function openChat(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => {
    const m = document.documentElement.dataset.mode
    return m !== undefined && m !== 'loading'
  }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
  await page.locator('#now-cc').click()
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-now', 'chat')
}

test.beforeEach(async ({ shim }) => {
  await shim.invoke('demo.unseed')
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
})

test('reply object: collapsed 过程 above the reply, voice / sticker / file below; voice plays, file reveals by ref', async ({ page, shimUrl, shim }) => {
  await openChat(page, shimUrl)
  await page.locator('#converse-input').fill('明天上午有空吗')
  await page.locator('#converse-send').click()

  const cc = page.locator('.converse-msg-cc').last()
  await expect(cc.locator('.converse-bubble')).toContainText('明天上午十点前都空着')

  // 过程:默认收起,说清没发到微信;展开看得到两段
  const process = cc.locator('details.converse-process')
  await expect(process).not.toHaveAttribute('open')
  await expect(process.locator('summary')).toHaveText(/过程 · 2 段/)
  await expect(process.locator('summary')).toHaveAttribute('title', /没有发到微信/)
  await expect(process.locator('.converse-process-lines li').first()).toBeHidden()
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'converse-reply-extras-collapsed.png') })
  await process.locator('summary').click()
  await expect(process).toHaveAttribute('open', '')
  await expect(process.locator('.converse-process-lines li')).toHaveText(['我先看一下明天的日程。', '再对一下已经设好的提醒,免得撞上。'])

  // 过程在回复之上,附件在回复之下
  const order = await cc.evaluate(el => {
    const p = el.querySelector('.converse-process')!, b = el.querySelector('.converse-bubble')!, a = el.querySelector('.converse-attachments')!
    return [!!(p.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)]
  })
  expect(order).toEqual([true, true])

  // 朗读按钮贴着正文最后一行:在正文那一行里、在附件块之上,底边与正文底边对齐
  const replay = cc.locator('.converse-cc-line > .voice-replay-btn')
  await expect(replay).toHaveCount(1)
  await expect(cc.locator('.voice-replay-btn')).toHaveCount(1)
  const [rb, bb, ab] = await Promise.all([replay.boundingBox(), cc.locator('.converse-bubble').boundingBox(), cc.locator('.converse-attachments').boundingBox()])
  expect(Math.abs((rb!.y + rb!.height) - (bb!.y + bb!.height))).toBeLessThanOrEqual(8)
  expect(rb!.y + rb!.height).toBeLessThanOrEqual(ab!.y)
  // 展开指示与文字同一层级:看得见、不是一个小点
  const marker = await process.locator('summary').evaluate(el => { const s = getComputedStyle(el, '::before'); return { w: parseFloat(s.borderLeftWidth), h: parseFloat(s.borderTopWidth) * 2 } })
  expect(marker.w).toBeGreaterThanOrEqual(6)
  expect(marker.h).toBeGreaterThanOrEqual(8)

  // 附件:语音一行、本地表情是图(在 CSP 下用 data: 显示得出来)、联网表情只写情绪、文件名 + 在访达中显示
  await expect(cc.locator('.converse-att-voice')).toContainText('明天上午十点前都空着。')
  const sticker = cc.locator('img.converse-att-sticker')
  await expect(sticker).toBeVisible()
  expect(await sticker.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
  await expect(cc.locator('.converse-att-sticker-label')).toHaveText(/表情 · 加油/)
  await expect(cc.locator('.converse-att-file .converse-att-name')).toHaveText('明天的安排.md')
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'converse-reply-extras-open.png') })

  await cc.locator('.converse-att-play').click()
  await cc.locator('.converse-att-reveal').click()
  await expect.poll(async () => ((await shim.invoke('mock.converse-calls')) as { result: { reveal: string[] } }).result.reveal).toEqual(['rf1'])
  // 播放失败 / 读不了都不该冒出错误行
  await expect(page.locator('.converse-error-line')).toHaveCount(0)
})

test('an attachments-only turn renders the sticker as the CC line, without a blank bubble or a "no text" note', async ({ page, shimUrl }) => {
  await openChat(page, shimUrl)
  await page.locator('#converse-input').fill('只要表情')
  await page.locator('#converse-send').click()
  const cc = page.locator('.converse-msg-cc').last()
  await expect(cc.locator('img.converse-att-sticker')).toBeVisible()
  await expect(cc.locator('.converse-bubble')).toHaveCount(0)
  await expect(page.locator('.converse-system-line')).toHaveCount(0)
})
