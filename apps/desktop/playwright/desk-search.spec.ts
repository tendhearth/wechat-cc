import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { placeItem, routePlaces, routeRoster, rosterItem } from './roster-fixture'
import { PRESENCE_OK, routePresenceTopic } from './presence-topic'

test.use({ viewport: { width: 1280, height: 820 } })

const place = placeItem('花园', { sessionIds: ['garden-terminal'] })
const task = { id: 'aabbccdd', title: '花园交办', path: '/offline/garden', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }
const chat = { messageId: 'garden-chat', kind: 'text', text: 'CC 记住了花园', createdAt: 10 }
const hit = { sessionId: 'garden-terminal', placeKey: place.key, project: place.name, source: 'codex', who: 'you', at: 10,
  snippet: '终端里提到花园', matchStart: 5, matchLength: 2 }
const search = (page: Page) => page.locator('#wb-search')
const part = (page: Page, key: string) => page.locator(`[data-desk-search-section="${key}"]`)
const row = (page: Page, key: string) => part(page, key).getByRole('option')
const query = (url: string) => new URL(url).searchParams
const windowResult = (messages: unknown[] = [], earlier: string | null = null, anchor: string | null = null) => ({ messages, earlier, anchor, later: null })

async function shortcut(page: Page) {
  await page.keyboard.press((await page.locator('html').getAttribute('data-platform')) === 'macos' ? 'Meta+k' : 'Control+k')
}

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await routePresenceTopic(page, { presence: () => PRESENCE_OK })
  await routePlaces(page, [place])
  await routeRoster(page, [rosterItem(hit.sessionId, '花园终端', {
    key: 'terminal:' + hit.sessionId, kind: 'terminal', group: 'back', status: 'replied',
    terminal: { sessionId: hit.sessionId, code: 'garden' }, waiting: undefined,
  })])
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { events: [], cursor: 0, running: null } }))
  await page.route('**/v1/matter/owner-chat/window**', route => {
    const params = query(route.request().url())
    return route.fulfill({ json: params.has('anchor') ? windowResult([chat], null, chat.messageId)
      : params.has('before') ? windowResult([{ ...chat, messageId: 'old', kind: 'user', text: '早些时候的花园' }])
        : params.get('q') === '花园' ? windowResult([chat], 'earlier') : windowResult() })
  })
  await page.route('**/v1/terminal/search?*', route => route.fulfill({ json: { ok: true, hits: query(route.request().url()).get('q') === '花园' ? [hit] : [] } }))
  await page.route('**/v1/cli/sessions**', route => route.fulfill({ json: { ok: true, sessions: [{
    session_id: hit.sessionId, source: 'codex', displayName: 'Codex', status: 'idle', pending: null, stale: false, project: place.name,
  }] } }))
  await page.route('**/v1/cli/activity**', route => route.fulfill({ json: { ok: true, items: [{ id: 'step', kind: 'you', text: '找到指定会话的原话', at: 10 }], earlier: null } }))
  await page.route(/\/v1\/workbench(?:\?.*)?$/, route => {
    const q = query(route.request().url()).get('q')
    return route.fulfill({ json: { tasks: !q || q === '花园' ? [task] : [], providers: [{ id: 'codex', displayName: 'Codex' }],
      projects: [{ id: 'garden', name: '花园', path: task.path, providerId: 'codex' }], defaultProvider: 'codex', canWechat: false } })
  })
  await page.route('**/v1/workbench/task?*', route => route.fulfill({ json: { task, runId: 'run', events: [], permissions: [], artifacts: [], questions: [] } }))
})

test('四段按顺序显示，可以跨段选中，并回到原项目、会话和对话', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await expect(page.locator('#topbar-search')).toBeVisible()
  await shortcut(page)
  await expect(page.locator('.desk-search-section-title')).toHaveText(['交办的事1'])
  await expect(search(page)).toBeFocused()
  await search(page).fill('花园')
  await expect(page.locator('.desk-search-section-title')).toHaveText(['项目1', '会话里说过的1', '和 CC 的对话1', '交办的事1'])
  await expect(part(page, 'terminals').locator('strong')).toHaveText('花园')
  await expect(part(page, 'chat').locator('strong')).toHaveText('花园')
  await search(page).press('ArrowDown')
  await expect(search(page)).toHaveAttribute('aria-activedescendant', await row(page, 'projects').getAttribute('id') ?? '')
  await search(page).press('ArrowDown')
  await expect(row(page, 'terminals')).toHaveAttribute('aria-selected', 'true')
  await search(page).press('ArrowUp')
  await search(page).press('Enter')
  await expect(page.locator('#thing-name')).toHaveText('花园')

  await shortcut(page)
  await expect(search(page)).toHaveValue('花园')
  await row(page, 'terminals').click()
  await expect(page.locator('#thing-thread .thing-terminal:visible')).toContainText('找到指定会话的原话')
  await shortcut(page)
  await page.getByRole('button', { name: '再往前找' }).click()
  await expect(row(page, 'chat')).toHaveCount(2)
  await row(page, 'chat').first().click()
  await expect(page.locator('#converse-scroll [data-converse-message]:focus')).toContainText(chat.text)

  await shortcut(page)
  await expect(search(page)).toHaveValue('花园')
  await search(page).press('Escape')
  await expect(search(page)).toHaveValue('')
  await expect(page.locator('.desk-search-section-title')).toHaveText(['交办的事1'])
  await search(page).press('Escape')
  await expect(page.locator('#converse-input')).toBeVisible()
})

test('空段收起，失败能重读，旧回包和组字不打断新结果', async ({ page, shimUrl }) => {
  const seen: string[] = []
  let releaseOld!: () => void
  const old = new Promise<void>(resolve => { releaseOld = resolve })
  let failed = false
  await page.route('**/v1/terminal/search?*', async route => {
    const q = query(route.request().url()).get('q')!
    seen.push(q)
    if (q === '旧') {
      await old
      return route.fulfill({ json: { ok: true, hits: [{ ...hit, snippet: '过期的结果' }] } })
    }
    if (q === '花园' && !failed) {
      failed = true
      return route.fulfill({ status: 503, json: { error: 'unavailable' } })
    }
    return route.fulfill({ json: { ok: true, hits: q === '花园' ? [hit] : [] } })
  })
  await page.goto(shimUrl)
  await page.locator('#topbar-search').click()
  await search(page).fill('旧')
  await expect.poll(() => seen).toEqual(['旧'])
  await search(page).dispatchEvent('compositionstart')
  await search(page).fill('花')
  await page.waitForTimeout(350)
  expect(seen).toEqual(['旧'])
  await search(page).fill('花园')
  await search(page).dispatchEvent('compositionend')
  await expect(part(page, 'terminals')).toContainText('这一段暂时没能读取。')
  await expect(row(page, 'projects')).toHaveCount(1)
  await expect(row(page, 'chat')).toHaveCount(1)
  await part(page, 'terminals').getByRole('button', { name: '重新读取' }).click()
  await expect(row(page, 'terminals')).toContainText(hit.snippet)
  const oldReply = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/v1/terminal/search' && url.searchParams.get('q') === '旧'
  })
  releaseOld()
  await oldReply
  await expect(row(page, 'terminals')).toContainText(hit.snippet)
  await search(page).fill('这一词没有')
  await expect(page.getByText('没有找到「这一词没有」。')).toBeVisible()
  await expect(page.locator('.desk-search-section-title:visible')).toHaveCount(0)
})

test('窄窗口仍然提交后只搜交办的事', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 800, height: 820 })
  const queried: string[] = []
  page.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname === '/v1/terminal/search' || url.searchParams.has('q')) queried.push(url.pathname)
  })
  await page.goto(shimUrl)
  await page.locator('#topbar-search').click()
  await search(page).fill('花园')
  await page.waitForTimeout(350)
  expect(queried).toEqual([])
  await search(page).press('Enter')
  await expect.poll(() => queried).toContain('/v1/workbench')
  expect(queried.every(path => path === '/v1/workbench')).toBe(true)
  await expect(page.locator('.desk-search-section-title')).toHaveCount(0)
})

test('旧后台的对话搜索回退，交办读取失败可单独复试', async ({ page, shimUrl }) => {
  await page.route('**/v1/matter/owner-chat/window**', route => query(route.request().url()).has('q')
    ? route.fulfill({ status: 404, json: { error: 'not_found' } }) : route.fallback())
  await page.route('**/v1/matter/owner-chat/search?*', route => route.fulfill({ json: { hits: [chat] } }))
  let failed = false
  await page.route(/\/v1\/workbench(?:\?.*)?$/, route => {
    if (failed || query(route.request().url()).get('q') !== '花园') return route.fallback()
    failed = true
    return route.fulfill({ status: 503, json: { error: 'unavailable' } })
  })
  await page.goto(shimUrl)
  await page.locator('#topbar-search').click()
  await search(page).fill('花园')
  const tasks = page.locator('.desk-search-tasks')
  await expect(tasks).toContainText('这一段暂时没能读取。')
  await expect(row(page, 'chat')).toContainText(chat.text)
  await expect(row(page, 'terminals')).toContainText(hit.snippet)
  await tasks.getByRole('button', { name: '重新读取' }).click()
  await expect(tasks.locator('[data-task-id="aabbccdd"]')).toBeVisible()
})
