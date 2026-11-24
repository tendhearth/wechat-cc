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

  await page.setViewportSize({ width: 680, height: 820 })
  await expect(page.locator('html')).toHaveAttribute('data-desk-wide', '')
  await expect(rail).toBeHidden()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#converse-input')).toHaveValue('这句话还没发')
})

for (const [width, height] of [[390, 700], [550, 450]] as const) {
  test(`${width}×${height} 展开浮动左栏时输入框和发送仍完整可用`, async ({ page, shimUrl }) => {
    await page.setViewportSize({ width, height })
    await routePlaces(page, [])
    await page.route('**/__invoke', route => {
      if (route.request().postDataJSON().command !== 'agent_converse') return route.fallback()
      return route.fulfill({ json: { result: { reply: '已收到。' } } })
    })
    await page.goto(shimUrl)
    const rail = page.locator('#dash-global-rail')
    const toggle = page.locator('#desk-rail-toggle')
    const composer = page.locator('#converse-compose')
    const input = page.locator('#converse-input')
    const send = page.getByRole('button', { name: '发送消息' })
    const message = '这句话能从窄窗发送'
    await expect(rail).toBeHidden()
    await input.fill(message)
    const widthBefore = (await composer.boundingBox())!.width

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(rail).toHaveCSS('position', 'absolute')
    for (const locator of [composer, input, send]) await expect(locator).toBeInViewport({ ratio: 1 })
    expect((await composer.boundingBox())!.width).toBe(widthBefore)
    await page.keyboard.press('Escape')
    await expect(rail).toBeHidden()
    await expect(input).toHaveValue(message)
    await input.click()
    await expect(input).toBeFocused()

    await toggle.click()
    const posted = page.waitForRequest(request =>
      request.url().endsWith('/__invoke') && request.postDataJSON()?.command === 'agent_converse')
    await send.click()
    expect((await posted).postDataJSON().args.text).toBe(message)
    await expect(rail).toBeHidden()
    await expect(input).toHaveValue('')
  })
}

test('690×280 展开左栏时底部的更多可见，可以进入设置和后厨', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 690, height: 280 })
  await routePlaces(page, ['花园', '备份', '菜谱'].map(name => placeItem(name)))
  await page.goto(shimUrl)
  await page.locator('#desk-rail-toggle').click()
  const more = page.locator('.topbar-more > summary')
  const settings = page.getByRole('button', { name: '设置', exact: true })
  await expect(more).toBeInViewport({ ratio: 1 })
  await more.click()
  await expect(settings).toBeInViewport({ ratio: 1 })
  await settings.click()
  const drawer = page.locator('#settings-drawer')
  await expect(drawer).toHaveClass(/is-open/)
  await drawer.locator('#settings-close').click()
  await more.click()
  const backstage = page.getByRole('button', { name: '后厨' })
  await backstage.click()
  await expect(page.locator('article[data-pane="sessions"]')).toBeVisible()
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

for (const [width, height, decision, label] of [
  [760, 820, 'deny', '先不做'], [760, 820, 'allow', '允许这一步'],
  [550, 450, 'allow', '允许这一步'],
] as const) {
  test(`${width}px 的一件事能读到线，也能点纸片上的「${label}」`, async ({ page, shimUrl }) => {
    await page.setViewportSize({ width, height })
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
    const row = placeRow(page, '备份').locator('.place-row')
    if (width === 760) {
      await toggle.hover()
      await expect(page.locator('html')).toHaveAttribute('data-desk-peeking', '')
      await row.click()
      await page.mouse.move(690, 180)
    } else {
      await toggle.click()
      await row.click()
      await page.keyboard.press('Escape')
    }
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

test('在 760 到 900px 间调整窗口保留草稿、阅读锚点和选中的地方', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 760, height: 820 })
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
  await page.setViewportSize({ width: 820, height: 820 })
  await expect(page.locator('#thing-name')).toBeVisible()
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveValue('这句话还没发')
  await page.setViewportSize({ width: 900, height: 820 })
  await expect(page.locator('#thing-name')).toBeVisible()
  await expect(page.locator('#thing-name')).toHaveText('菜谱')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#topbar-cc').click()
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)
})
