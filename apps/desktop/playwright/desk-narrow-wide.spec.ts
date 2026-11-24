import { test, expect, clickNav } from './fixtures'
import { placeItem, placeRow, placeSession, rosterItem, routePlaces, routeRoster, terminalPlace } from './roster-fixture'

test.use({ viewport: { width: 760, height: 820 } })

const history = Array.from({ length: 50 }, (_, index) => ({
  kind: index === 0 ? 'user' : 'text',
  text: `第 ${index} 条消息，换窗口大小以后还能接着读。`,
  messageId: `old-${index}`,
  createdAt: index + 1,
}))

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: history } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { running: null, events: [], cursor: 0 } }))
})

test('760px 打开时收起左栏，正文和输入框完整，工具排成一行', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const rail = page.locator('#dash-global-rail')
  const toggle = page.locator('#desk-rail-toggle')
  await expect(page.locator('html')).toHaveAttribute('data-desk-wide', '')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(rail).toBeHidden()
  await expect(page.locator('.dash-main')).toHaveCSS('border-radius', '12px')
  await expect(page.locator('#converse-scroll [data-converse-message]').last()).toBeInViewport()
  await expect(page.locator('#converse-input')).toBeInViewport({ ratio: 1 })
  await page.locator('#converse-input').fill('这句话还没发')
  const tools = [
    page.locator('.conversation-add > summary'),
    page.locator('#converse-recipient-default'),
    page.getByRole('button', { name: '语音输入' }),
    page.getByRole('button', { name: '朗读回复' }),
    page.getByRole('button', { name: '发送消息' }),
  ]
  for (const tool of tools) await expect(tool).toBeInViewport({ ratio: 1 })
  const boxes = await Promise.all(tools.map(tool => tool.boundingBox()))
  const centers = boxes.map(box => box!.y + box!.height / 2)
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1)
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width)
  }
  await expect(page.locator('#converse-compose')).toBeInViewport({ ratio: 1 })
})

test('900px 以内保留手动选择，跨过 900px 后重新采用默认状态', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const rail = page.locator('#dash-global-rail')
  const toggle = page.locator('#desk-rail-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  for (const width of [800, 760, 899]) {
    await page.setViewportSize({ width, height: 820 })
    await expect(rail).toHaveCSS('width', '284px')
    await expect(page.locator('html[data-desk-collapsed]')).toHaveCount(0)
  }
  await page.setViewportSize({ width: 900, height: 820 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.setViewportSize({ width: 800, height: 820 })
  await expect(rail).toBeHidden()
  await toggle.click()
  await toggle.click()
  await page.mouse.move(680, 200)
  await page.setViewportSize({ width: 760, height: 820 })
  await expect(rail).toBeHidden()
  await page.setViewportSize({ width: 900, height: 820 })
  await expect(rail).toHaveCSS('width', '284px')
})

for (const [decision, label] of [['deny', '先不做'], ['allow', '允许这一步']] as const) {
  test(`760px 的一件事能读到线，也能点纸片上的「${label}」`, async ({ page, shimUrl }) => {
    const id = 'backup'
    const pending = { actionable: true, tool: 'Read', summary: '读备份目录？', hash: 'req-1' }
    const place = terminalPlace('备份', id, pending.summary, {
      sessions: [placeSession(id, 'waiting', 2)],
      waiting: { itemKey: `terminal:${id}`, kind: 'terminal', sessionId: id,
        requestId: pending.hash, summary: pending.summary, count: 1 },
    })
    await routePlaces(page, [place])
    await routeRoster(page, [rosterItem(id, '备份', {
      key: `terminal:${id}`, kind: 'terminal', terminal: { sessionId: id, code: id }, waiting: undefined,
    })])
    await page.route('**/v1/cli/sessions**', route => route.fulfill({ json: { ok: true, sessions: [
      { session_id: id, source: 'codex', displayName: 'Codex', status: 'waiting', pending, stale: false, project: '备份' },
    ] } }))
    await page.route('**/v1/cli/activity**', route => route.fulfill({ json: { ok: true, earlier: null, items: [
      { id: 'reply', kind: 'said', text: '找到需要核对的目录。', at: Date.now() },
    ] } }))
    await page.route('**/v1/cli/decide', route => route.fulfill({ json: { ok: true } }))
    await page.goto(shimUrl)
    const toggle = page.locator('#desk-rail-toggle')
    await expect(toggle.locator('.topbar-waiting-dot')).toBeVisible()
    await toggle.hover()
    await expect(page.locator('html')).toHaveAttribute('data-desk-peeking', '')
    await placeRow(page, '备份').locator('.place-row').click()
    await page.mouse.move(690, 180)
    await expect(page.locator('#dash-global-rail')).toBeHidden()
    await expect(page.locator('#thing-thread .thing-scroll').getByText('找到需要核对的目录。')).toBeInViewport()
    const card = page.locator('#thing-thread .thing-waiting')
    await expect(card).toContainText('读备份目录？')
    for (const name of ['先不做', '允许这一步']) {
      const button = card.getByRole('button', { name, exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      await expect(button).toBeEnabled()
    }
    const request = page.waitForRequest('**/v1/cli/decide')
    await card.getByRole('button', { name: label, exact: true }).click()
    expect((await request).postDataJSON()).toEqual({ session_id: id, hash: pending.hash, decision })
    await expect(card).toBeHidden()
  })
}

test('后厨会话按纸面宽度分栏，760px 时会话列表在原话上方', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const toggle = page.locator('#desk-rail-toggle')
  await toggle.click()
  await clickNav(page, 'sessions')
  const sidebar = page.locator('.dialogue-sidebar')
  const stage = page.locator('.dialogue-stage')
  await expect(page.locator('#dialogue-timeline')).toBeVisible()
  const arrangement = async () => {
    const [left, right] = await Promise.all([sidebar.boundingBox(), stage.boundingBox()])
    if (!left || !right) return 'missing'
    if (Math.abs(left.x - right.x) < 1 && left.y + left.height <= right.y) return 'stacked'
    if (Math.abs(left.y - right.y) < 1 && left.x + left.width <= right.x) return 'side-by-side'
    return 'overlap'
  }
  await expect.poll(arrangement).toBe('stacked')
  await toggle.click()
  await page.mouse.move(690, 180)
  await expect.poll(arrangement).toBe('stacked')
  await page.setViewportSize({ width: 800, height: 820 })
  await expect.poll(arrangement).toBe('side-by-side')
  await toggle.click()
  await expect.poll(arrangement).toBe('stacked')
})

test('穿过 700px 回到桌面版时保留草稿、阅读锚点和选中的地方', async ({ page, shimUrl }) => {
  await routePlaces(page, [placeItem('菜谱', { messageIds: history.map(row => row.messageId) })])
  await page.goto(shimUrl)
  const input = page.locator('#converse-input')
  const scroll = page.locator('#converse-scroll')
  const messages = scroll.locator('[data-converse-message]')
  const row = placeRow(page, '菜谱').locator('.place-row')
  await input.fill('这句话还没发')
  await expect(messages).toHaveCount(history.length)
  await scroll.evaluate(el => {
    const anchor = el.querySelectorAll('[data-converse-message]')[8]!.getBoundingClientRect()
    el.scrollTop += anchor.top + anchor.height / 2 - el.getBoundingClientRect().top
  })
  const anchor = () => scroll.evaluate(el => {
    const top = el.getBoundingClientRect().top
    return [...el.querySelectorAll('[data-converse-message]')]
      .find(message => message.getBoundingClientRect().bottom > top)?.getAttribute('data-converse-message')
  })
  const before = await anchor()
  expect(before).toBe(await messages.nth(8).getAttribute('data-converse-message'))
  await page.locator('#desk-rail-toggle').click()
  await row.click()
  await expect(page.locator('#thing-name')).toHaveText('菜谱')
  await page.setViewportSize({ width: 690, height: 820 })
  await expect(page.locator('#converse-place-clear')).toHaveText('只看 菜谱 · 回到全部')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)
  await page.setViewportSize({ width: 700, height: 820 })
  await expect(page.locator('#thing-name')).toBeVisible()
  await expect(page.locator('#thing-name')).toHaveText('菜谱')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#topbar-cc').click()
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)
})
