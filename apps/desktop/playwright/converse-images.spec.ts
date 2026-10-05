/**
 * 此刻里拖进 / 粘进截图一起发(2026-10-05,主人:「我直接拖进去截图去聊天，好像没办法」)。
 * 用真浏览器的 DataTransfer 造一次拖放与一次粘贴,看缩略图、移除、发送时带上 { mime, data_b64 }、
 * 自己那条消息里有图,以及不支持的格式会说一句而不是悄悄丢。
 */
import { test, expect } from './fixtures'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function openNow(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await expect(page.locator('#converse-input')).toBeVisible()
}

/** 在 selector 上派发一次带文件的拖放(或粘贴)。 */
async function dispatchFiles(page: import('@playwright/test').Page, selector: string, kind: 'drop' | 'paste', files: Array<{ name: string; type: string; b64: string }>) {
  await page.evaluate(({ selector, kind, files }) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), c => c.charCodeAt(0))], f.name, { type: f.type }))
    const target = document.querySelector(selector)!
    if (kind === 'paste') target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    else {
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }
  }, { selector, kind, files })
}

test.beforeEach(async ({ shim }) => {
  await shim.invoke('demo.unseed')
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
})

test('drop and paste screenshots into 此刻, remove one, send the rest with the text', async ({ page, shimUrl }) => {
  await openNow(page, shimUrl)
  const sent: unknown[] = []
  page.on('request', req => {
    const body = req.postData()
    if (body && body.includes('"agent_converse"')) sent.push(JSON.parse(body))
  })

  // 落在此刻页的任何地方都算(这里故意丢在 CC 身上,不在输入框上)
  await dispatchFiles(page, '#now-cc', 'drop', [{ name: 'shot-1.png', type: 'image/png', b64: PNG }])
  await expect(page.locator('#converse-images .converse-image-chip')).toHaveCount(1)
  await dispatchFiles(page, '#converse-input', 'paste', [{ name: 'shot-2.png', type: 'image/png', b64: PNG }])
  await expect(page.locator('#converse-images .converse-image-chip')).toHaveCount(2)

  // 不支持的格式:说一句,不进列表
  await dispatchFiles(page, '#converse-input', 'drop', [{ name: 'notes.txt', type: 'text/plain', b64: btoa('hi') }])
  await expect(page.locator('#converse-image-note')).toContainText('只支持')
  await expect(page.locator('#converse-images .converse-image-chip')).toHaveCount(2)

  await page.locator('[data-remove-image]').first().click()
  await expect(page.locator('#converse-images .converse-image-chip')).toHaveCount(1)

  await page.locator('#converse-input').fill('帮我看看这张截图')
  await page.locator('#converse-send').click()
  await expect(page.locator('.converse-msg-user .converse-user-images img')).toHaveCount(1)
  await expect(page.locator('#converse-images')).toBeHidden()
  await expect.poll(() => sent.length).toBeGreaterThan(0)
  const args = (sent.at(-1) as { args?: { text?: string; images?: Array<{ mime: string; data_b64: string }> } }).args
  expect(args?.text).toBe('帮我看看这张截图')
  expect(args?.images).toEqual([{ mime: 'image/png', data_b64: PNG }])
})

test('an image alone (no text) can be sent', async ({ page, shimUrl }) => {
  await openNow(page, shimUrl)
  await dispatchFiles(page, '#converse-input', 'paste', [{ name: 'only.png', type: 'image/png', b64: PNG }])
  await page.locator('#converse-send').click()
  await expect(page.locator('.converse-msg-user .converse-user-images img')).toHaveCount(1)
})
