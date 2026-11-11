import { test, expect } from './fixtures'

test('Codex confirmation and changed definitions update automatically in connections', async ({ page, shimUrl, shim }) => {
  const seed = async (state: 'untrusted' | 'trusted' | 'changed') => shim.invoke('demo.seed', { chat_id: 'test_chat', connections: {
    generatedAt: Date.now(), sources: [], computers: [{ id: 'home', label: 'UI lab', online: true, since: null, version: null }], recent: [], outputs: [], capabilities: [{
      id: 'terminal', name: '终端里的 Codex', state: state === 'trusted' ? 'ok' : 'needs_you', code: `terminal.codex_${state}`,
      reason: state === 'trusted' ? 'Codex 已连接，开工时也知道项目近况。' : `${state === 'changed' ? 'Codex 需要重新确认一次' : 'Codex 还差一步'}：在 Codex 里输入 /hooks，审阅并信任 wechat-cc —— 之后 Codex 开工时也知道项目近况。`,
    }],
  } })
  await seed('untrusted')
  await page.clock.install()
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.mode && document.documentElement.dataset.mode !== 'loading')
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await page.locator('.cc-home-details > summary').click()
  const row = page.locator('#now-connections .nc-capability')
  await expect(row).toContainText('Codex 还差一步')
  await expect(row).toContainText('/hooks')
  await expect(row.locator('button')).toHaveCount(0)
  await expect(row.locator('.dot')).toHaveClass(/bad/)
  await seed('trusted'); await page.clock.fastForward(30_001)
  await expect(row).toContainText('Codex 已连接')
  await expect(row.locator('.dot')).toHaveClass(/ok/)
  await seed('changed'); await page.clock.fastForward(30_001)
  await expect(row).toContainText('Codex 需要重新确认一次')
  await expect(row.locator('.dot')).toHaveClass(/bad/)
})
