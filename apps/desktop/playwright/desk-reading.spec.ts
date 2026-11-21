import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { placeItem, placeRow, rosterItem, routePlaces, routeRoster } from './roster-fixture'

test.use({ viewport: { width: 1280, height: 820 } })

const day = new Date(2026, 10, 18, 12).getTime()
const summary = '已把花园日记整理好了。'
const session = 'melu-terminal'
const row = (messageId: string, text: string, createdAt: number) => ({ kind: 'text', messageId, text, createdAt })
const recent = Array.from({ length: 35 }, (_, i) => row(`recent-${i}`, `最近的第 ${i} 条回复。`, day + i))
const old = row('old-rici', '前一天的菜谱回复。', day - 86_400_000)
const reading = (page: Page) => page.locator('#converse-scroll')
const earlier = (page: Page) => page.locator('#converse-earlier')
const select = (page: Page, name: string) => placeRow(page, name).locator('.place-row').click()

async function expectCentered(element: Locator, column: Locator) {
  await expect(element).toBeVisible()
  await expect.poll(async () => {
    const [box, target] = await Promise.all([element.boundingBox(), column.boundingBox()])
    return Math.abs(box!.x + box!.width / 2 - target!.x - target!.width / 2)
  }).toBeLessThanOrEqual(2)
}

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', {
    daemonAlive: true,
    cliSessions: [{ session_id: session, source: 'codex', displayName: 'Codex', status: 'idle',
      project: 'melu', last_summary: summary, last_event_at: day, pending: null }],
  })
  await routePlaces(page, [
    placeItem('rici', { unseen: true, moving: false, status: 'done', updatedAt: Date.now(), messageIds: ['recent-0', old.messageId] }),
    placeItem('melu', { line: summary, moving: false, status: 'done', updatedAt: Date.now(), sessionIds: [session] }),
  ])
  await routeRoster(page, [rosterItem(session, 'melu', {
    key: `terminal:${session}`, kind: 'terminal', status: 'replied', group: 'back', project: 'melu',
    updatedAt: day, terminal: { sessionId: session, code: 'melu', summary },
  })])
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { running: null, events: [], cursor: 0 } }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: recent, earlier: 'p1' } }))
})

test('地方名、首日日期和正文各在自己的位置', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  const name = placeRow(page, 'rici').locator('.place-name')
  const line = placeRow(page, 'rici').locator('.place-line')
  await expect(placeRow(page, 'rici')).toHaveAttribute('data-unseen', 'true')
  await expect(name).toHaveCSS('font-weight', '600')
  await expect(line).toHaveCSS('font-weight', '400')
  await expect(name).toHaveCSS('font-size', '15px')
  await expect(line).toHaveCSS('font-size', '13.5px')
  const scroll = reading(page)
  // 流最上面是「更早的对话」(翻到头才看得见),紧接着就是第一天的日期。
  await expect(scroll.locator(':scope > :first-child')).toHaveAttribute('id', 'converse-earlier')
  const first = scroll.locator(':scope > :nth-child(2)')
  await expect(first).toHaveClass('desk-message-date')
  // 打开时停在最新一条;翻到头才看得见第一天的日期。
  await expect(scroll.locator('[data-converse-message]').last()).toBeInViewport()
  await scroll.evaluate(node => { node.scrollTop = 0 })
  await expect(first).toBeInViewport()
  await expectCentered(first, scroll)
  await expect(page.locator('#desk-today')).toHaveCount(0)
  const title = page.locator('.desk-date-line')
  await expect.poll(() => title.evaluate(node => node.getBoundingClientRect().height)).toBe(0)
  const bubble = scroll.locator('.converse-bubble').first()
  const bodyOffset = async () => (await bubble.boundingBox())!.x - (await scroll.boundingBox())!.x
  expect(await bodyOffset()).toBe(104) // 56px 读栏内边距 + 原有 48px 头像位置
  await select(page, 'rici')
  await expect(placeRow(page, 'melu')).toHaveCSS('opacity', '1')
  await expect(title.getByRole('heading', { name: '只看 rici' })).toHaveText('rici')
  expect(await bodyOffset()).toBe(104)
  await title.getByRole('button', { name: '回到全部', exact: true }).click()
  await expect.poll(() => title.evaluate(node => node.getBoundingClientRect().height)).toBe(0)
})

test('只有终端会话的地方也有入口，回到全部时清掉引用', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await expect(earlier(page)).toBeVisible()
  await select(page, 'melu')
  const card = reading(page).locator(`[data-terminal-reference="${session}"]`)
  await expect(card.locator('[data-terminal-title]')).toHaveText(summary)
  await expect(reading(page).locator('.converse-place-empty')).toHaveCount(0)
  await expect(earlier(page)).toBeHidden()
  await expect(page.locator('#converse-latest')).toBeHidden()
  await card.locator('summary').click()
  await card.getByRole('button', { name: '看过程、接着说或停止' }).click()
  await expect(page.locator('#roster-aside .roster-terminal')).toBeVisible()
  await page.locator('#desk-place-clear').click()
  await expect(card).toHaveCount(0)
})

test('筛选后继续跨过无关页，找到才停，查找期间按钮禁用', async ({ page, shimUrl }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requests: string[] = []
  await page.route('**/v1/matter/owner-chat/window**', async route => {
    const before = new URL(route.request().url()).searchParams.get('before')
    if (!before) return route.fulfill({ json: { messages: recent, earlier: 'p1' } })
    requests.push(before)
    if (before === 'p1') {
      await held
      return route.fulfill({ json: { messages: [row('other', '别处的话。', day - 60_000)], earlier: 'p2' } })
    }
    return route.fulfill({ json: { messages: [old], earlier: null } })
  })
  await page.goto(shimUrl)
  await select(page, 'rici')
  await expect(earlier(page)).toBeVisible()
  await earlier(page).click()
  try {
    await expect(earlier(page)).toBeDisabled()
    await expect(earlier(page)).toHaveText('在往前找…')
    await expect.poll(() => requests.slice()).toEqual(['p1'])
  } finally {
    release()
  }
  await expect(reading(page).getByText(old.text)).toBeVisible()
  await expect(reading(page).getByText('别处的话。')).toHaveCount(0)
  await expect(earlier(page)).toBeHidden()
  expect(requests).toEqual(['p1', 'p2'])
})

test('全部对话往上加一页而阅读锚点不跳，收栏后按钮仍居中', async ({ page, shimUrl }) => {
  await page.route('**/v1/matter/owner-chat/window**', route => {
    const before = new URL(route.request().url()).searchParams.has('before')
    return route.fulfill({ json: before ? { messages: [old], earlier: null } : { messages: recent, earlier: 'p1' } })
  })
  await page.goto(shimUrl)
  const scroll = reading(page)
  const visibleRows = scroll.locator('[data-converse-message]')
  await expect(visibleRows).toHaveCount(recent.length)
  // 打开时停在最新一条;「更早的对话」在流的最上面,不压在正文上。
  await expect(visibleRows.last()).toBeInViewport()
  await expect(earlier(page)).not.toBeInViewport()
  await scroll.evaluate(node => { node.scrollTop = 0 })
  await expectCentered(earlier(page), scroll)
  await page.locator('#desk-rail-toggle').click()
  await expect(page.locator('#desk-rail-toggle')).toHaveAttribute('aria-expanded', 'false')
  await scroll.evaluate(node => { node.scrollTop = 0 })
  await expectCentered(earlier(page), scroll)
  const anchor = await scroll.evaluate(node => {
    const y = node.getBoundingClientRect().top
    const message = Array.from(node.querySelectorAll('[data-converse-message]')).find(child => child.getBoundingClientRect().bottom > y)!
    return { id: message.getAttribute('data-converse-message'), y: message.getBoundingClientRect().top }
  })
  await earlier(page).click()
  await expect(visibleRows.first()).toContainText(old.text)
  await expect(earlier(page)).toBeHidden()
  const y = await scroll.evaluate((node, id) =>
    node.querySelector(`[data-converse-message="${id}"]`)!.getBoundingClientRect().top, anchor.id)
  expect(Math.abs(y - anchor.y)).toBeLessThanOrEqual(2)
  await expect(page.locator('#converse-latest')).toBeHidden()
})

test('800px 保留原顶栏、上方地方列表和窄窗筛选条', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 800, height: 820 })
  await page.goto(shimUrl)
  await expect(page.locator('#dash-global-rail')).toHaveCSS('height', '72px')
  await expect(page.locator('#desk-rail-toggle')).toBeHidden()
  await select(page, 'rici')
  await expect(page.locator('#converse-place-clear')).toHaveText('只看 rici · 回到全部')
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await expect(reading(page).locator('.desk-message-date').first()).toBeHidden()
  const [places, scroll] = await Promise.all([page.locator('.places-strip').boundingBox(), reading(page).boundingBox()])
  expect(places!.y + places!.height).toBeLessThanOrEqual(scroll!.y)
})
