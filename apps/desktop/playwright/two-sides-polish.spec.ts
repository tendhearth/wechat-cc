import { test, expect, clickNav } from './fixtures'
import { askingPlace, placeItem, placeRow, routePlaces } from './roster-fixture'
import { PRESENCE_OK } from './presence-topic'

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: [
    { kind: 'user', text: '刚才说到哪儿了？', messageId: 'question', createdAt: 1 },
    { kind: 'text', text: '菜谱已经整理好了。', messageId: 'rici-reply', createdAt: 2 },
    { kind: 'text', text: '今天天气不错。', messageId: 'other-reply', createdAt: 3 },
  ] } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { running: null, events: [], cursor: 0 } }))
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
})

test('地方标签、筛选提示与输入框一起切换，草稿随时可以继续写', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 690, height: 820 })
  await routePlaces(page, [placeItem('rici', { messageIds: ['question', 'rici-reply'] }), placeItem('leni')])
  await page.goto(shimUrl)
  const scroll = page.locator('#converse-scroll')
  const input = page.locator('#converse-input')
  const clear = page.locator('#converse-place-clear')
  const rici = placeRow(page, 'rici')
  const label = scroll.getByRole('button', { name: 'rici', exact: true })
  await expect(scroll.locator('.converse-msg-user .converse-place-label')).toHaveCount(0)
  await expect(label).toHaveCount(1)
  await expect(label.locator('..')).toContainText('菜谱已经整理好了。')
  await expect(page.locator('#converse-recipient-default')).toHaveText('CC ›')
  await expect(input).toHaveAttribute('placeholder', '随便说，CC 自己分得清')
  await input.fill('还没写完')
  await label.click()
  await expect(rici.locator('.place-row')).toHaveAttribute('aria-pressed', 'true')
  await expect(clear).toHaveText('只看 rici · 回到全部')
  await expect(label).toHaveCount(0)
  await expect(scroll).not.toContainText('今天天气不错。')
  await expect(input).toHaveAttribute('placeholder', '说说 rici 的事')
  await expect(input).toHaveValue('还没写完')
  await expect(page.locator('#converse-recipient')).toHaveText('rici ›')
  await clear.click()
  await expect(clear).toBeHidden()
  await expect(rici.locator('.place-row')).toHaveAttribute('aria-pressed', 'false')
  await expect(scroll).toContainText('今天天气不错。')

  await placeRow(page, 'leni').locator('.place-row').click()
  await expect(scroll.locator('.converse-place-empty')).toHaveText('最近还没聊过 leni 的事。')
  await expect(scroll.locator('.converse-place-empty')).toHaveCSS('padding-top', /^(?!0px)\d+px$/)
  await page.locator('#converse-recipient').click()
  await expect(clear).toBeHidden()
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('placeholder', '随便说，CC 自己分得清')
  await expect(input).toHaveValue('还没写完')
})

test('内滚地方条靠下的菜单可 Tab 到达、完整显示、关闭和操作，中文数据能条件轮询', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 690, height: 760 })
  const names = ['甲地', '乙地', '丙地', '丁地', '戊地', '己地', '庚地']
  await routePlaces(page, names.map(name => placeItem(name)))
  await page.route('**/v1/places/move', route => route.fulfill({ json: { ok: true } }))
  const rerender = page.waitForResponse(response => response.url().endsWith('/v1/places')
    && /^[0-9a-f]{16}$/.test(response.request().headers()['if-none-match'] ?? ''))
  await page.goto(shimUrl)
  const strip = page.locator('#places-root')
  const first = placeRow(page, '甲地')
  const firstMore = first.locator('.place-more')
  await expect(strip).toHaveAttribute('data-more-below', '')
  const fade = () => page.locator('.places-strip').evaluate(el => getComputedStyle(el, '::after').backgroundImage)
  expect(await fade()).toContain('linear-gradient')
  await expect(strip).toHaveCSS('max-height', '253px')
  await expect(first.locator('.place-row')).toHaveCSS('min-height', '46px')
  await expect(firstMore).toHaveCSS('opacity', '0')
  const normal = await first.evaluate(el => getComputedStyle(el).backgroundColor)
  await first.hover()
  await expect(firstMore).toHaveCSS('opacity', '1')
  expect(await first.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(normal)
  await first.locator('.place-row').click()
  await page.locator('#converse-input').hover()
  await page.locator('#converse-input').focus()
  await expect(firstMore).toHaveCSS('opacity', '1')
  expect(await first.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(
    await page.locator('.dash-window').evaluate(el => getComputedStyle(el).backgroundColor),
  )
  const selectedColors = await first.locator('.place-row').evaluate(el =>
    [el, el.querySelector('.place-name')!, el.querySelector('.place-line')!].map(node => getComputedStyle(node).color),
  )
  expect(new Set(selectedColors).size).toBe(1)
  expect((await rerender).status()).toBe(304)
  await expect(strip.locator('.places-stale')).toHaveCount(0)

  // 倒数第二行仍有三项。滚到底后它靠近滚动容器下边缘。
  const row = placeRow(page, '己地')
  await strip.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(strip).not.toHaveAttribute('data-more-below', '')
  expect(await fade()).toBe('none')
  await row.locator('.place-row').focus()
  await page.keyboard.press('Tab')
  const more = row.locator('.place-more')
  await expect(more).toBeFocused()
  await expect(more).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  const menu = row.locator('.place-actions')
  await expect(menu).toBeVisible()
  const stripBox = (await strip.boundingBox())!
  const actions = menu.getByRole('button')
  await expect(actions).toHaveText(['往上挪', '往下挪', '收起这一行'])
  await expect.poll(async () => {
    const bottom = (await actions.last().boundingBox())!
    return bottom.y + bottom.height
  }).toBeGreaterThan(stripBox.y + stripBox.height)
  for (const action of await actions.all()) {
    await expect(action).toBeInViewport({ ratio: 1 })
    await action.click({ trial: true })
  }
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await more.click()
  await page.locator('#converse-input').click()
  await expect(menu).toBeHidden()
  await more.click()
  const move = page.waitForRequest(request => request.url().endsWith('/v1/places/move'))
  await actions.first().click()
  expect((await move).postDataJSON()).toEqual({ key: placeItem('己地').key, to: 4 })
})

test('窗口底部空间不足时菜单向上翻，实际末行仍能操作', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 690, height: 270 })
  await routePlaces(page, ['甲地', '乙地', '丙地', '丁地', '戊地', '己地'].map(name => placeItem(name)))
  await page.goto(shimUrl)
  const row = placeRow(page, '己地')
  const more = row.locator('.place-more')
  await expect(row).toBeAttached()
  await page.locator('#places-root').evaluate(el => { el.scrollTop = el.scrollHeight })
  await more.click()
  const menu = row.locator('.place-actions')
  const actions = menu.getByRole('button')
  await expect(actions).toHaveText(['往上挪', '收起这一行'])
  // 菜单整块在视口里、不压住「⋯」；下面放不下时必须翻到上面（不同平台字体行高不同，按实际几何判）。
  await expect.poll(async () => {
    const [popup, anchor] = await Promise.all([menu.boundingBox(), more.boundingBox()])
    const viewport = page.viewportSize()!
    if (!popup || !anchor) return 'missing'
    if (popup.y < 0 || popup.y + popup.height > viewport.height) return 'outside viewport'
    const above = popup.y + popup.height <= anchor.y, below = popup.y >= anchor.y + anchor.height
    if (!above && !below) return 'covers anchor'
    if (!above && viewport.height - (anchor.y + anchor.height) < popup.height) return 'should flip up'
    return 'ok'
  }).toBe('ok')
  for (const action of await actions.all()) await action.click({ trial: true })
})

for (const width of [690, 520]) {
  test(`答复按钮的位置，窗口宽 ${width}px`, async ({ page, shimUrl }) => {
    const line = '要不要先把这份笔记里提到的旧菜谱保留一份，再继续整理剩下的记录？'.repeat(5)
    await page.setViewportSize({ width, height: 800 })
    await routePlaces(page, [askingPlace('rici', 'deadbeef', line)])
    await page.goto(shimUrl)
    await expect(page.locator('main.dashboard')).toBeVisible()
    const row = placeRow(page, 'rici')
    const button = row.getByRole('button', { name: '去回答' })
    const status = row.locator('.place-line')
    await expect(status).toHaveText(line)
    await expect(button).toBeVisible()
    const [ask, sentence, name, time] = await Promise.all(
      [button, status, row.locator('.place-name'), row.locator('.place-time')].map(item => item.boundingBox()),
    )
    if (width === 690) {
      // 690px 保留名字、现状和时间的一行，答复按钮单独排在下一行。
      expect(ask!.height).toBe(44)
      expect(ask!.y).toBeGreaterThanOrEqual(sentence!.y + sentence!.height)
      expect(ask!.x).toBeCloseTo(sentence!.x, 0)
      expect(Math.abs((time!.y + time!.height / 2) - (sentence!.y + sentence!.height / 2))).toBeLessThan(6)
      expect(sentence!.x).toBeGreaterThan(name!.x + name!.width)
      await expect(status).toHaveCSS('text-overflow', 'ellipsis')
    } else {
      // 窄窗口：按钮在第二层，左缘对齐现状那一列；现状两行再省略。
      expect(ask!.height).toBe(44)
      expect(ask!.x).toBeCloseTo(sentence!.x, 0)
      expect(ask!.y).toBeGreaterThan(sentence!.y)
      expect(sentence!.y).toBeGreaterThan(name!.y + name!.height)
      expect(sentence!.y).toBeGreaterThan(time!.y)
      expect(sentence!.width).toBeGreaterThan(220)
      await expect(status).toHaveCSS('-webkit-line-clamp', '2')
    }
  })
}

test('输入框随内容增长再收回，语音键留可访问名称，回复朗读按需出现', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const input = page.locator('#converse-input')
  await expect(page.locator('main.dashboard')).toBeVisible()
  await expect(input).toBeVisible()
  await expect(input).toHaveCSS('resize', 'none')
  const height = () => input.evaluate(el => el.getBoundingClientRect().height)
  const initial = await height()
  await input.fill('第一行\n第二行\n第三行')
  expect(await height()).toBeGreaterThan(initial)
  await input.fill('更多文字\n'.repeat(24))
  const cap = await input.evaluate(el => {
    const css = getComputedStyle(el)
    const padding = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom)
    return { height: el.clientHeight, scroll: el.scrollHeight, eight: parseFloat(css.lineHeight) * 8 + padding }
  })
  expect(cap.height).toBeCloseTo(cap.eight, 0)
  expect(cap.scroll).toBeGreaterThan(cap.height)
  await input.fill('')
  expect(await height()).toBe(initial)

  const mic = page.getByRole('button', { name: '语音输入' })
  const voice = page.getByRole('button', { name: '朗读回复' })
  await expect(mic).toHaveAttribute('title', '语音输入')
  await expect(voice).toHaveAttribute('title', '自动朗读 CC 的回复')
  for (const button of [mic, voice]) {
    await expect(button).toHaveText('')
    await expect(button.locator('svg')).toHaveCount(1)
  }
  await expect(voice).toHaveAttribute('aria-pressed', 'false')
  await voice.click()
  await expect(voice).toHaveAttribute('aria-pressed', 'true')
  const reply = page.locator('.converse-msg-cc').filter({ hasText: '菜谱已经整理好了。' })
  const replay = reply.getByRole('button', { name: '朗读这条回复' })
  await expect(replay).toHaveCSS('opacity', '0')
  await reply.hover()
  await expect(replay).toHaveCSS('opacity', '1')
  await input.hover()
  await replay.focus()
  await expect(replay).toHaveCSS('opacity', '1')
})

test('审批等待不再给头像叠感叹号，连接异常仍会显示', async ({ page, shimUrl }) => {
  let presence = 'ok'
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await routePlaces(page, [askingPlace('rici', 'deadbeef')])
  await page.route('**/v1/companion/presence', route => route.fulfill({ json: { ...PRESENCE_OK, presence } }))
  await page.route('**/v1/workbench/attention', route => route.fulfill({ json: { tasks: [{
    id: 'deadbeef', title: '审批', providerId: 'codex', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["p1"]',
  }] } }))
  await page.goto(shimUrl)
  const avatar = page.locator('#topbar-cc')
  const stage = avatar.locator('.now-pet-stage')
  const mark = stage.locator('[data-prop="exclamation"]')
  await expect(page.locator('#topbar-presence')).toHaveText('CC 在家')
  await expect(stage).toHaveAttribute('data-behavior', 'permission')
  await expect(mark).toHaveCSS('visibility', 'hidden')
  presence = 'degraded'
  // 在家状态 20 秒轮询一次；切走再回到说话页会立即重读。
  await clickNav(page, 'workbench')
  await clickNav(page, 'overview')
  await expect(page.locator('#topbar-presence')).toHaveText('CC 在家 · 有功能没起来', { timeout: 15_000 })
  await expect(mark).toBeVisible()
})
