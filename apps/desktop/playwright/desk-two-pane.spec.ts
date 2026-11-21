import { test, expect, clickNav } from './fixtures'
import { PRESENCE_OK, routePresenceTopic } from './presence-topic'
import { askingPlace, placeItem, placeRow, routePlaces } from './roster-fixture'

test.use({ viewport: { width: 1280, height: 820 } })

const datePattern = /^[一二三四五六七八九十]+月[一二三四五六七八九十]+日 周[一二三四五六日]$/

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
  await expect(heading).toHaveCSS('height', '30px')
  await expect(heading).toBeEmpty()
  await expect(heading).toHaveCSS('border-bottom-width', '0px')
  const date = page.locator('.desk-date-line')
  await expect(date).toBeHidden()
  await expect(scroll.locator('.desk-message-date').first()).toBeVisible()
  // 说话的人用头像:你的是「还没画」的铅笔稿,CC 的是它自己那一张
  await expect(scroll.locator('.desk-speaker:visible').first()).toHaveAttribute('data-speaker', 'you')
  await expect(scroll.locator('.desk-speaker[data-speaker="you"]:visible svg').first()).toBeVisible()
  const ccFace = scroll.locator('.desk-speaker[data-speaker="cc"]:visible img').first()
  await expect(ccFace).toBeVisible()
  expect(await ccFace.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
  await expect(scroll.locator('.converse-msg[data-same-speaker] .desk-speaker')).toBeHidden()
  const [left, right, talk, input, name, status, dashboard] = await Promise.all([
    rail, main, scroll, compose, row.locator('.place-name'), row.locator('.place-line'), page.locator('main.dashboard'),
  ].map(locator => locator.boundingBox()))
  expect(Math.abs(left!.width - 304)).toBeLessThanOrEqual(2)
  expect(left!.x).toBe(0)
  // The shim's development banner reserves its own row above the dashboard.
  expect(left!.y).toBe(dashboard!.y)
  expect(left!.y + left!.height).toBe(820)
  expect(left!.height).toBe(dashboard!.height)
  expect(talk!.width).toBeLessThanOrEqual(780)
  expect(Math.abs(talk!.x + talk!.width / 2 - (right!.x + right!.width / 2))).toBeLessThanOrEqual(2)
  expect(input!.x).toBeGreaterThanOrEqual(right!.x)
  expect(input!.x + input!.width).toBeLessThanOrEqual(right!.x + right!.width)
  expect(input!.height).toBeGreaterThanOrEqual(48)
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
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await expect(page.locator('#converse-input')).toBeVisible()
})

test('全局等待卡片钉在上方、切换地方仍可回答、回答后刷新', async ({ page, shimUrl }) => {
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
  const card = cards.filter({ hasText: '这件要你定 · rici' })
  const date = page.locator('.desk-date-line')
  const clear = page.locator('#desk-place-clear')
  const scroll = page.locator('#converse-scroll')
  await expect(cards).toHaveCount(2)
  await expect(card).toContainText('旧表留着吗？')
  await expect(card).toBeVisible()
  for (const edge of ['top', 'right', 'bottom', 'left']) await expect(card).toHaveCSS(`border-${edge}-width`, '0px')
  await expect(card).not.toHaveCSS('box-shadow', 'none')
  const deny = card.getByRole('button', { name: '不允许' })
  await expect(deny).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(deny).toHaveCSS('text-decoration-line', 'underline')
  await expect(date).toBeHidden()
  const [cardBox, scrollBox] = await Promise.all([card.boundingBox(), scroll.boundingBox()])
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(scrollBox!.y)
  await expect(scroll.locator('.desk-waiting-card')).toHaveCount(0)
  await expect(placeRow(page, 'rici').locator('.place-ask')).toHaveCount(0)
  await page.getByRole('button', { name: '还有 1 件等你定' }).click()
  await expect(cards).toHaveCount(3)
  await page.getByRole('button', { name: '收起其余等你定的' }).click()
  await expect(cards).toHaveCount(2)

  // 进别的地方的页:别处等你定的纸条不跟过来压在正文上面(左栏的圆点还在)。
  await placeRow(page, 'leni').locator('.place-row').click()
  await expect(cards).toHaveCount(0)
  await expect(placeRow(page, 'rici')).toHaveAttribute('data-waiting', 'true')
  await expect(clear).toBeHidden()
  await expect(page.locator('#thing-name')).toHaveText('leni')
  await page.locator('#topbar-cc').click()
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await placeRow(page, 'rici').locator('.place-row').click()
  await expect(clear).toBeHidden()
  await expect(page.locator('#thing-name')).toHaveText('rici')
  await expect(cards).toHaveCount(1)
  await card.getByRole('button', { name: '允许', exact: true }).click()
  expect(decisions).toEqual([{ id: 'deadbeef', requestId: 'req-1', decision: 'allow' }])
  await expect(card).toHaveCount(0)
  await expect(placeRow(page, 'rici')).toHaveAttribute('data-waiting', 'false')
  await page.locator('#topbar-cc').click()
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await expect(clear).toBeHidden()
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
    kind: i === 0 ? 'user' : 'text', text: `第 ${i} 条旧消息，用来确认换宽度后还能接着读。`, messageId: `old-${i}`, createdAt: i + 1,
  }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: history } }))
  await routePlaces(page, [placeItem('rici', { messageIds: history.map(row => row.messageId) })])
  await page.goto(shimUrl)
  const row = placeRow(page, 'rici').locator('.place-row')
  const input = page.locator('#converse-input')
  const scroll = page.locator('#converse-scroll')
  const clear = page.locator('#converse-place-clear')
  const rail = page.locator('#dash-global-rail')
  await input.fill('这句话还没发')
  await expect(scroll.locator('[data-converse-message]')).toHaveCount(50)
  // 让上边缘落在一条消息的中间。流里多了第一天的日期行以后,原来的 400 正好落在两条消息的缝上,换版式时差一个像素就认成上一条。
  await scroll.evaluate(el => {
    const row = el.querySelectorAll('[data-converse-message]')[8]!.getBoundingClientRect()
    el.scrollTop += row.top + row.height / 2 - el.getBoundingClientRect().top
  })
  const anchor = () => scroll.evaluate(el => {
    const y = el.getBoundingClientRect().top
    const first = Array.from(el.children).find(node => node.getBoundingClientRect().bottom > y)
    return first?.getAttribute('data-converse-message')
  })
  const before = await anchor()
  await row.click()
  await expect(page.locator('#thing-thread')).toBeVisible()
  await page.setViewportSize({ width: 800, height: 820 })
  await expect(rail).toHaveCSS('height', '72px')
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await expect(page.locator('.desk-heading')).toBeHidden()
  await expect(scroll.locator('.converse-msg-user .converse-bubble')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  for (const edge of ['top', 'right', 'bottom', 'left']) await expect(page.locator('.converse-compose')).toHaveCSS(`border-${edge}-width`, '1px')
  await expect(clear).toBeVisible()
  await expect(clear).toHaveText('只看 rici · 回到全部')
  const [top, places, talk] = await Promise.all([rail, page.locator('.places-strip'), scroll].map(locator => locator.boundingBox()))
  expect(places!.y).toBeGreaterThanOrEqual(top!.y + top!.height)
  expect(places!.y + places!.height).toBeLessThanOrEqual(talk!.y)
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)

  await page.setViewportSize({ width: 900, height: 820 })
  await expect(rail).toHaveCSS('width', '304px')
  await page.setViewportSize({ width: 1280, height: 820 })
  await expect(clear).toBeHidden()
  await expect(page.locator('#desk-place-clear')).toBeHidden()
  await expect(page.locator('#thing-name')).toHaveText('rici')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#topbar-cc').click()
  await expect(input).toHaveValue('这句话还没发')
  await expect.poll(anchor).toBe(before)

})

test('两栏的拖拽区：两侧空白各起一次拖拽，空地方返回 CC 的按钮照常点', async ({ page, shimUrl }) => {
  await routePlaces(page, [placeItem('rici'), placeItem('leni')])
  await page.goto(shimUrl)
  await expect(page.locator('.desk-heading')).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __dragCalls: number; __TAURI__: { window: { getCurrentWindow: () => unknown } } }
    w.__dragCalls = 0
    w.__TAURI__.window.getCurrentWindow = () => ({ startDragging: async () => { w.__dragCalls += 1 } })
  })
  const calls = () => page.evaluate(() => (window as unknown as { __dragCalls: number }).__dragCalls)
  // 左栏顶上的空白
  await page.locator('.desk-rail-titlebar').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(calls).toBe(1)
  // 右栏顶部的空白
  await page.locator('.desk-heading').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(calls).toBe(2)
  // 空地方可回 CC，点击时不会拖窗口。
  await placeRow(page, 'rici').locator('.place-row').click()
  const clear = page.getByRole('button',{name:'去和 CC 说',exact:true})
  await expect(clear).toBeVisible()
  await expect(clear).toHaveText('去和 CC 说')
  await expect(page.locator('#thing-name')).toHaveText('rici')
  await clear.dispatchEvent('mousedown', { button: 0 })
  await clear.click()
  await expect(page.locator('#thing-thread')).toBeHidden()
  expect(await calls()).toBe(2)
})


test('CC 用新鲜数据说现状，状态点和选中行跟随列表', async ({ page, shimUrl }) => {
  await routePresenceTopic(page, { presence: () => PRESENCE_OK })
  let places: ReturnType<typeof placeItem>[] | {status:number} = [
    askingPlace('rici', 'aaaa0001'), askingPlace('leni', 'aaaa0002'), placeItem('melu'),
  ]
  await routePlaces(page, () => places)
  await page.goto(shimUrl)
  const situation = page.locator('#desk-cc-situation')
  const figure = page.locator('#topbar-cc .topbar-figure')
  // 呼吸的光挂在这一行上:活的 CC 和静态图谁在显示都有
  const breathing = () => page.locator('#topbar-cc').evaluate(el => getComputedStyle(el, '::before').animationName)
  const waiting = placeRow(page, 'rici')
  const moving = placeRow(page, 'melu')
  await expect(page.locator('#desk-cc-presence')).toHaveText('CC 在家')
  await expect(situation).toHaveText('两件要你定，一件在做。')
  await expect(situation).toBeVisible()
  await expect(figure).toHaveCSS('width', '60px')
  await expect.poll(breathing).not.toBe('none')
  await expect(moving.locator('.place-dot')).not.toHaveCSS('animation-name', 'none')
  await expect(waiting.locator('.place-dot')).toHaveCSS('animation-name', 'none')
  await expect(waiting.locator('.place-dot')).toHaveCSS('background-color', 'rgb(79, 107, 79)')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(breathing).toBe('none')
  await expect(moving.locator('.place-dot')).toHaveCSS('animation-name', 'none')
  await waiting.locator('.place-row').click()
  await expect(moving).toHaveCSS('opacity', '1')
  await page.locator('#topbar-cc').click()
  await expect(moving).toHaveCSS('opacity', '1')
  places = []
  await expect(situation).toHaveText('都安静，没有要你管的。', { timeout: 10_000 })
  places = {status:503}
  await expect(situation).toBeHidden({ timeout: 10_000 })
  await expect(page.locator('#desk-cc-presence')).toHaveText('家里的电脑暂时连不上')
})

test('地方名与正文同起一行，跨天有日期，输入工具留在线上', async ({ page, shimUrl }) => {
  await routePlaces(page, [placeItem('rici', { messageIds: ['rici-reply'] })])
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: [
    { kind: 'user', text: '昨天的问题。', messageId: 'question', createdAt: 1 },
    { kind: 'text', text: '菜谱已经整理好了。', messageId: 'rici-reply', createdAt: 86_400_001 },
    { kind: 'text', text: '顺序也排过了。', messageId: 'rici-more', createdAt: 86_400_002 },
  ] } }))
  await page.goto(shimUrl)
  const scroll = page.locator('#converse-scroll')
  await expect(scroll.locator('.desk-message-date')).toHaveCount(2)
  await expect(scroll.locator('.desk-message-date')).toHaveText([datePattern, datePattern])
  const label = scroll.locator('.desk-inline-place')
  await expect(label).toHaveText('rici')
  await expect(label).toBeVisible()
  expect(await label.evaluate(el => {
    const text = el.nextSibling!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const left = el.getBoundingClientRect(), right = range.getBoundingClientRect()
    return left.right < right.x && left.top < right.bottom && left.bottom > right.top
  })).toBe(true)
  await label.click()
  const clear = page.locator('#desk-place-clear')
  await expect(clear).toBeHidden()
  await expect(page.locator('#thing-name')).toHaveText('rici')
  await expect(label).toBeHidden()
  await page.locator('#topbar-cc').click()

  const compose = page.locator('.converse-compose')
  for (const edge of ['top', 'right', 'left']) await expect(compose).toHaveCSS(`border-${edge}-width`, '0px')
  await expect(compose).toHaveCSS('border-bottom-width', '1px')
  // 功能按钮一个不少、也没多:更多(交办 / 项目 / 会话 / 搜索)、语音、朗读、发送
  for (const id of ['converse-mic', 'converse-voice-toggle', 'converse-send']) {
    await compose.locator('#' + id).click({ trial: true })
  }
  await expect(compose.locator('#desk-attach')).toHaveCount(0)
  const send = compose.locator('#converse-send')
  await expect(send).not.toHaveCSS('color', 'rgb(79, 107, 79)')
  await compose.locator('#converse-input').fill('写')
  await expect(send).toHaveCSS('color', 'rgb(79, 107, 79)')
})

test('宽窗跨午夜仍按消息当天标注日期', async ({ page, shimUrl }) => {
  await page.clock.install({ time: new Date(2026, 10, 19, 23, 59) })
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: [
    { kind: 'text', text: '留给明天的话。', messageId: 'yesterday', createdAt: new Date(2026, 10, 19, 23, 50).getTime() },
  ] } }))
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const date = page.locator('#converse-scroll .desk-message-date')
  await expect(date).toHaveText('十一月十九日 周四')
  await page.clock.fastForward(60_000)
  await expect(date).toHaveText('十一月十九日 周四')
  await expect(page.locator('#desk-today')).toHaveCount(0)
})

test('等待纸条有 CC 意见时只多两行', async ({ page, shimUrl }) => {
  const summary = '要删掉唯一一份旧备份吗？'
  const waiting = { itemKey: 'matter:deadbeef', kind: 'permission', matterId: 'deadbeef', requestId: 'req-1', summary, count: 1 }
  const note = { ccOpinion: '先别删。这是唯一一份备份。', questionReason: '删了回不来' }
  await routePlaces(page, [
    placeItem('归档', { status: 'waiting', moving: false, line: summary, waiting: { ...waiting, ...note } }),
    askingPlace('菜谱', 'aaaa0001'),
  ])
  await page.goto(shimUrl)
  const cards = page.locator('.desk-waiting-card')
  const lines = (name: string) => cards.filter({ hasText: name }).locator(':scope > div:not(.place-ask)')
  await expect(lines('归档')).toHaveText(['这件要你定 · 归档', summary, '我的意见(只看了这条请求)：' + note.ccOpinion, '为什么来问你：' + note.questionReason])
  await expect(lines('菜谱')).toHaveText(['这件要你定 · 菜谱', '要你回答一个问题'])
})

test('另一张等待纸条收到意见时保留去回答的键盘焦点', async ({ page, shimUrl }) => {
  const waiting = { itemKey: 'matter:deadbeef', kind: 'permission', matterId: 'deadbeef', requestId: 'req-1', summary: '要删旧备份吗？', count: 1 }
  const archive = placeItem('归档', { status: 'waiting', moving: false, line: waiting.summary, waiting })
  const recipe = askingPlace('菜谱', 'aaaa0001')
  let places = [archive, recipe]
  await routePlaces(page, () => places)
  await page.goto(shimUrl)

  const cards = page.locator('.desk-waiting-card')
  const answer = cards.filter({ hasText: '菜谱' }).getByRole('button', { name: '去回答' })
  await answer.focus()
  await expect(answer).toBeFocused()
  places = [{ ...archive, waiting: { ...waiting, ccOpinion: '先别删。这是唯一一份备份。', questionReason: '删了回不来' } }, recipe]
  await expect(cards.filter({ hasText: '归档' }).locator('.desk-waiting-opinion')).toContainText('先别删')
  await expect(answer).toBeFocused()
})
