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

test('内滚地方条靠下的菜单可 Tab 到达、完整显示、关闭和操作，中文数据能条件轮询', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 900, height: 560 })
  const names = ['甲地', ...Array.from({ length: 13 }, (_, i) => `地方${i + 1}`), '己地', '庚地']
  // 末行占两行摘要，为倒数第二行菜单留出向下展开并越过滚动区的空间。
  await routePlaces(page, names.map(name => name === '庚地'
    ? placeItem(name, { line: '已经核对这一批结果，剩下的内容会在整理完以后一起带回来。'.repeat(3) })
    : placeItem(name)))
  await page.route('**/v1/places/move', route => route.fulfill({ json: { ok: true } }))
  const rerender = page.waitForResponse(response => response.url().endsWith('/v1/places')
    && /^[0-9a-f]{16}$/.test(response.request().headers()['if-none-match'] ?? ''))
  await page.goto(shimUrl)
  const strip = page.locator('#places-root')
  const first = placeRow(page, '甲地')
  const firstMore = first.locator('.place-more')
  const places = page.locator('.places-strip')
  await expect(places).toHaveAttribute('data-more-below', '')
  const fade = () => page.locator('.places-strip').evaluate(el => getComputedStyle(el, '::after').backgroundImage)
  expect(await fade()).toContain('linear-gradient')
  expect(await strip.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(firstMore).toHaveCSS('opacity', '0')
  const normal = await first.evaluate(el => getComputedStyle(el).backgroundColor)
  await first.hover()
  await expect(firstMore).toHaveCSS('opacity', '1')
  expect(await first.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(normal)
  await first.locator('.place-row').click()
  await expect(page.locator('#thing-name')).toHaveText('甲地')
  await expect(first.locator('.place-row')).toHaveAttribute('aria-pressed', 'true')
  await expect(firstMore).toHaveCSS('opacity', '1')
  await page.locator('#topbar-cc').click()
  expect((await rerender).status()).toBe(304)
  await expect(strip.locator('.places-stale')).toHaveCount(0)

  // 倒数第二行仍有三项。滚到底后它靠近滚动容器下边缘。
  const row = placeRow(page, '己地')
  await strip.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(places).not.toHaveAttribute('data-more-below', '')
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
  expect((await move).postDataJSON()).toEqual({ key: placeItem('己地').key, to: names.length - 3 })
})

test('窗口底部空间不足时菜单向上翻，实际末行仍能操作', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 900, height: 470 })
  await routePlaces(page, [...Array.from({ length: 10 }, (_, i) => `地方${i + 1}`), '己地'].map(name => placeItem(name)))
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
  await expect(page.locator('#desk-cc-presence')).toHaveText('CC 在家')
  await expect(stage).toHaveAttribute('data-behavior', 'permission')
  await expect(mark).toHaveCSS('visibility', 'hidden')
  presence = 'degraded'
  // 在家状态 20 秒轮询一次；切走再回到说话页会立即重读。
  await clickNav(page, 'workbench')
  await clickNav(page, 'overview')
  await expect(page.locator('#desk-cc-presence')).toHaveText('CC 在家 · 有功能没起来', { timeout: 15_000 })
  await expect(mark).toBeVisible()
})
