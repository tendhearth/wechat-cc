/**
 * 真 app 的 webview 里会静默失灵的两类东西(2026-10-05):
 *  - 外部链接(CC 回复里的 Markdown 链接、「去安装」…):统一交给系统浏览器,app 自己不被导航走;页内链接不管。
 *  - 原生 confirm():换成按钮上的「再点一次确认」(armConfirm)。
 * 浏览器里原生的 window.open / confirm 本来就能用,所以这里把它们换成记录器,证明代码不再依赖它们。
 */
import { test, expect } from './fixtures'

async function openDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
    const w = window as any
    w.__opened = []
    w.open = (url: string) => { w.__opened.push(url); return null }
    // 真 app 里 confirm() 恒为 false:让它在这里也这样,谁还在用就会失败。
    w.confirm = () => false
  })
}

test.beforeEach(async ({ shim }) => {
  await shim.invoke('demo.unseed')
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
})

test('an external link in a reply opens outside the app; the app stays put; in-page links are left alone', async ({ page, shimUrl }) => {
  // shim 和真 app 一样有 __TAURI__.core.invoke:链接应该走 open_url(交给系统浏览器)。
  const opened: string[] = []
  page.on('request', req => {
    const body = req.postData() ?? ''
    if (body.includes('"open_url"')) opened.push((JSON.parse(body).args as { url: string }).url)
  })
  await openDashboard(page, shimUrl)
  const before = page.url()
  await page.evaluate(() => {
    const host = document.querySelector('.cc-now-pane')!
    host.insertAdjacentHTML('beforeend', '<div id="qa-links"><a id="qa-ext" href="https://example.test/read" target="_blank" rel="noopener">查看网页</a> <a id="qa-plain" href="http://example.test/plain">没带 target</a> <a id="qa-hash" href="#nowhere">页内</a></div>')
  })
  await page.locator('#qa-ext').click()
  await page.locator('#qa-plain').click()
  await expect.poll(() => opened).toEqual(['https://example.test/read', 'http://example.test/plain'])
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([])
  expect(page.url().split('#')[0]).toBe(before.split('#')[0])
  await page.locator('#qa-hash').click()
  await page.waitForTimeout(200)
  expect(opened).toHaveLength(2)
})
