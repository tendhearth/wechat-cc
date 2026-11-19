import { test, expect, clickNav } from './fixtures'
import { askingPlace, placeItem, placeRow, routePlaces } from './roster-fixture'

test.use({ viewport: { width: 1280, height: 820 } })

const weekAgo = () => Date.now() - 8 * 86_400_000

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: [
    { kind: 'user', text: '菜谱怎么整理？', messageId: 'question', createdAt: 1 },
    { kind: 'text', text: '菜谱已经整理好了。', messageId: 'rici-reply', createdAt: 2 },
    { kind: 'text', text: '我把顺序也排过了。', messageId: 'rici-more', createdAt: 3 },
  ] } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { running: null, events: [], cursor: 0 } }))
})

test('宽窗两栏、地方两层、同一列说话和输入，记忆留在右边', async ({ page, shimUrl }) => {
  await routePlaces(page, [placeItem('rici'), placeItem('leni')])
  await page.goto(shimUrl)
  const rail = page.locator('#dash-global-rail')
  const main = page.locator('.dash-main')
  const heading = page.locator('.desk-heading')
  const scroll = page.locator('#converse-scroll')
  const compose = page.locator('.converse-compose')
  const row = placeRow(page, 'rici')
  await expect(row).toBeVisible()
  await expect(heading).toHaveCSS('height', '44px')
  await expect(scroll.locator('.desk-speaker:visible').first()).toHaveText('你')
  await expect(scroll.locator('.converse-msg[data-same-speaker] .desk-speaker')).toBeHidden()
  const [left, right, talk, input, name, status, dashboard] = await Promise.all([
    rail, main, scroll, compose, row.locator('.place-name'), row.locator('.place-line'), page.locator('main.dashboard'),
  ].map(locator => locator.boundingBox()))
  expect(Math.abs(left!.width - 270)).toBeLessThanOrEqual(2)
  expect(left!.x).toBe(0)
  // The shim's development banner reserves its own row above the dashboard.
  expect(left!.y).toBe(dashboard!.y)
  expect(left!.y + left!.height).toBe(820)
  expect(left!.height).toBe(dashboard!.height)
  expect(talk!.width).toBeLessThanOrEqual(720)
  expect(Math.abs(talk!.x + talk!.width / 2 - (right!.x + right!.width / 2))).toBeLessThanOrEqual(2)
  expect(input!.x).toBeGreaterThanOrEqual(right!.x)
  expect(input!.x + input!.width).toBeLessThanOrEqual(right!.x + right!.width)
  expect(input!.height).toBeGreaterThanOrEqual(58)
  expect(status!.y).toBeGreaterThanOrEqual(name!.y + name!.height)
  await expect(page.getByRole('button', { name: /这周没动的/ })).toHaveCount(0)

  await page.locator('#topbar-cc').focus()
  await page.keyboard.press('Tab')
  const connections = rail.locator('.cc-home-details > summary')
  await expect(connections).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rail.locator('#now-connections')).toBeVisible()
  await expect(rail.locator('#companion-desktop-start')).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(row.locator('.place-row')).toBeFocused()

  await clickNav(page, 'memory')
  await expect(rail).toBeVisible()
  await expect(row).toBeVisible()
  await expect(rail.getByRole('button', { name: '记忆' })).toHaveAttribute('aria-current', 'page')
  await expect(main.locator('article[data-pane="memory"]')).toBeVisible()
  await page.locator('#topbar-cc').click()
  await expect(heading).toContainText('和 CC')
  await expect(page.locator('#converse-input')).toBeVisible()
})

test('等待卡片钉在上方、跟地方筛选联动、回答后刷新', async ({ page, shimUrl }) => {
  const waiting = placeItem('rici', { status: 'waiting', moving: false, line: '旧表留着吗？',
    waiting: { itemKey: 'matter:deadbeef', kind: 'permission', matterId: 'deadbeef', requestId: 'req-1', summary: '旧表留着吗？', count: 1 } })
  let rici = waiting
  await routePlaces(page, () => [rici, placeItem('leni'), askingPlace('melu', 'aaaa0001'), askingPlace('ranu', 'aaaa0002')])
  const decisions: unknown[] = []
  await page.route('**/v1/matter/permission', route => {
    decisions.push(route.request().postDataJSON())
    rici = placeItem('rici')
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto(shimUrl)
  const cards = page.locator('.desk-waiting-card')
  const card = cards.filter({ hasText: 'rici 等你定' })
  const heading = page.locator('.desk-heading')
  const scroll = page.locator('#converse-scroll')
  await expect(cards).toHaveCount(2)
  await expect(card).toContainText('旧表留着吗？')
  const [cardBox, headingBox, scrollBox] = await Promise.all([card.boundingBox(), heading.boundingBox(), scroll.boundingBox()])
  expect(cardBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height)
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(scrollBox!.y)
  await expect(scroll.locator('.desk-waiting-card')).toHaveCount(0)
  await expect(placeRow(page, 'rici').locator('.place-ask')).toHaveCount(0)
  await page.getByRole('button', { name: '还有 1 件等你定' }).click()
  await expect(cards).toHaveCount(3)
  await page.getByRole('button', { name: '收起其余等你定的' }).click()
  await expect(cards).toHaveCount(2)

  await placeRow(page, 'leni').locator('.place-row').click()
  await expect(cards).toHaveCount(0)
  await expect(heading.locator('strong')).toHaveText('leni')
  await heading.getByRole('button', { name: '回到全部' }).click()
  await expect(heading.locator('strong')).toHaveText('和 CC')
  await placeRow(page, 'rici').locator('.place-row').click()
  await expect(heading.locator('strong')).toHaveText('rici')
  await expect(heading).toContainText('旧表留着吗？ ·')
  await expect(cards).toHaveCount(1)
  await card.getByRole('button', { name: '允许', exact: true }).click()
  expect(decisions).toEqual([{ id: 'deadbeef', requestId: 'req-1', decision: 'allow' }])
  await expect(card).toHaveCount(0)
  await expect(placeRow(page, 'rici')).toHaveAttribute('data-waiting', 'false')
  await page.locator('#topbar-cc').click()
  await expect(heading.locator('strong')).toHaveText('和 CC')
  await expect(heading.getByRole('button', { name: '回到全部' })).toBeHidden()
})

test('一周没动的地方默认收起，展开仍按原顺序，未读和正在动的保留', async ({ page, shimUrl }) => {
  const old = { updatedAt: weekAgo(), moving: false, status: 'done' }
  await routePlaces(page, [
    placeItem('rici', old), placeItem('leni'), placeItem('melu', old),
    placeItem('ranu', { ...old, unseen: true }), placeItem('cc', { ...old, moving: true }),
  ])
  await page.goto(shimUrl)
  const names = page.locator('#places-root .place:visible .place-name')
  const toggle = page.locator('.desk-quiet-toggle')
  await expect(names).toHaveText(['leni', 'ranu', 'cc'])
  await expect(toggle).toHaveText('这周没动的 2 处')
  await toggle.click()
  await expect(names).toHaveText(['rici', 'leni', 'melu', 'ranu', 'cc'])
  await expect(toggle).toHaveText('收起这周没动的')
  await toggle.click()
  await expect(names).toHaveText(['leni', 'ranu', 'cc'])
})

test('跨过 900px 保留筛选、草稿和滚动锚点，800px 还用原顶栏和筛选条', async ({ page, shimUrl }) => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    kind: 'text', text: `第 ${i} 条旧消息，用来确认换宽度后还能接着读。`, messageId: `old-${i}`, createdAt: i + 1,
  }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: history } }))
  await routePlaces(page, [placeItem('rici', { messageIds: history.map(row => row.messageId) })])
  await page.goto(shimUrl)
  const row = placeRow(page, 'rici').locator('.place-row')
  const input = page.locator('#converse-input')
  const scroll = page.locator('#converse-scroll')
  const clear = page.locator('#converse-place-clear')
  const rail = page.locator('#dash-global-rail')
  await row.click()
  await input.fill('这句话还没发')
  await expect(scroll.locator('[data-converse-message]')).toHaveCount(50)
  await scroll.evaluate(el => { el.scrollTop = 400 })
  const anchor = () => scroll.evaluate(el => {
    const y = el.getBoundingClientRect().top
    const first = Array.from(el.children).find(node => node.getBoundingClientRect().bottom > y)
    return first?.getAttribute('data-converse-message')
  })
  const before = await anchor()
  await page.setViewportSize({ width: 800, height: 820 })
  await expect(rail).toHaveCSS('height', '72px')
  await expect(clear).toBeVisible()
  await expect(clear).toHaveText('只看 rici · 回到全部')
  const [top, places, talk] = await Promise.all([rail, page.locator('.places-strip'), scroll].map(locator => locator.boundingBox()))
  expect(places!.y).toBeGreaterThanOrEqual(top!.y + top!.height)
  expect(places!.y + places!.height).toBeLessThanOrEqual(talk!.y)
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)

  await page.setViewportSize({ width: 900, height: 820 })
  await expect(rail).toHaveCSS('width', '270px')
  await page.setViewportSize({ width: 1280, height: 820 })
  await expect(clear).toBeHidden()
  await expect(page.locator('#desk-conversation-title')).toHaveText('rici')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)
})
