import { test, expect, clickNav } from './fixtures'
import { PRESENCE_OK, routePresenceTopic } from './presence-topic'
import { askingPlace, placeItem, placeRow, rosterItem, routePlaces, routeRoster } from './roster-fixture'
import type { PermissionDisplay } from '../../../packages/protocol/src/permission-display'

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
  await expect(scroll.locator('.desk-message-date').first()).toHaveCSS('font-size', '12px')
  await expect(scroll.locator('.desk-speaker:visible')).toHaveCount(0)
  await expect(scroll.locator('.desk-speaker[data-speaker="you"]:visible svg')).toHaveCount(0)
  await expect(scroll.locator('.desk-speaker[data-speaker="cc"]:visible img')).toHaveCount(0)
  await expect(scroll.locator('.converse-msg[data-same-speaker] .desk-speaker')).toBeHidden()
  await expect(compose.locator('.desk-speaker')).toBeHidden()
  const userBubble = scroll.locator('.converse-msg-user .converse-bubble')
  await expect(userBubble).toHaveCSS('border-radius', '18px 18px 6px')
  await expect(userBubble).toHaveCSS('font-size', '15px')
  await expect(scroll.locator('.converse-msg-cc .converse-bubble').first()).toHaveCSS('font-size', '18.5px')
  const [left, right, talk, input, name, status, dashboard] = await Promise.all([
    rail, main, scroll, compose, row.locator('.place-name'), row.locator('.place-line'), page.locator('main.dashboard'),
  ].map(locator => locator.boundingBox()))
  expect(Math.abs(left!.width - 284)).toBeLessThanOrEqual(2)
  expect(left!.x).toBe(0)
  // The shim's development banner reserves its own row above the dashboard.
  expect(left!.y).toBe(dashboard!.y)
  expect(left!.y + left!.height).toBe(820)
  expect(left!.height).toBe(dashboard!.height)
  expect(right!.x).toBe(left!.x + left!.width)
  expect(right!.y - dashboard!.y).toBe(8)
  expect(dashboard!.x + dashboard!.width - right!.x - right!.width).toBe(8)
  expect(dashboard!.y + dashboard!.height - right!.y - right!.height).toBe(8)
  await expect(main).toHaveCSS('border-radius', '12px')
  await expect(main).toHaveCSS('background-color', 'rgb(253, 251, 247)')
  await expect(rail).toHaveCSS('border-right-width', '0px')
  expect(input!.width).toBe(712)
  expect(Math.abs(talk!.x + talk!.width / 2 - (right!.x + right!.width / 2))).toBeLessThanOrEqual(2)
  expect(input!.x).toBeGreaterThanOrEqual(right!.x)
  expect(input!.x + input!.width).toBeLessThanOrEqual(right!.x + right!.width)
  expect(input!.height).toBeGreaterThanOrEqual(48)
  expect(status!.y).toBeGreaterThanOrEqual(name!.y + name!.height)
  expect(status!.x - name!.x).toBe(10)
  const time = row.locator('.place-time')
  await expect(time).toHaveCSS('opacity', '0')
  await row.hover()
  await expect(time).toHaveCSS('opacity', '1')
  const more = rail.locator('.topbar-more')
  await expect(more.getByText('更多', { exact: true })).toBeVisible()
  await more.locator('summary').click()
  const [footer, menu] = await Promise.all([more.boundingBox(), more.locator(':scope > div').boundingBox()])
  expect(menu!.y + menu!.height).toBeLessThan(footer!.y)
  await more.locator('summary').click()
  await expect(page.getByRole('button', { name: /这周没动的/ })).toHaveCount(0)

  await page.locator('#topbar-cc').focus()
  await page.keyboard.press('Tab')
  const connections = rail.locator('.cc-home-details > summary')
  await expect(connections).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rail.locator('#now-connections')).toBeVisible()
  await expect(rail.locator('#companion-desktop-start')).toBeVisible()
  await page.keyboard.press('Enter')
  const nav = rail.getByRole('navigation', { name: '主导航' })
  for (const name of ['搜索', '本子', '记忆', '回忆']) {
    const entry = nav.getByRole('button', { name })
    await page.keyboard.press('Tab')
    await expect(entry).toBeFocused()
    await expect(entry).toHaveCSS('height', '30px')
    await expect(entry.locator('svg')).toHaveCSS('width', '16px')
  }
  await expect(rail.getByText('项目', { exact: true })).toBeVisible()
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
    waiting: { itemKey: 'matter:deadbeef', kind: 'permission', matterId: 'deadbeef', requestId: 'req-1', summary: '旧表留着吗？', count: 1, cwd: '/offline/project' } })
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
  await expect(card).toHaveCSS('border-radius', '14px')
  await expect(card).toHaveCSS('box-shadow', /0px 0px 0px 0\.5px,.*0px 1px 2px 0px/)
  await expect(card.locator('.desk-waiting-question')).toHaveCSS('font-size', '15.5px')
  await expect(card.getByRole('button', { name: '允许这一步', exact: true })).toHaveCSS('background-color', 'rgb(79, 107, 79)')
  await expect(page.locator('#desk-waiting .desk-speaker:visible')).toHaveCount(0)
  const deny = card.getByRole('button', { name: '先不做' })
  await expect(deny).toHaveCSS('background-color', 'rgb(255, 254, 251)')
  await expect(deny).toHaveCSS('text-decoration-line', 'none')
  await expect(deny).not.toHaveCSS('box-shadow', 'none')
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
  await card.getByRole('button', { name: '允许这一步', exact: true }).click()
  expect(decisions).toEqual([{ id: 'deadbeef', requestId: 'req-1', decision: 'allow' }])
  await expect(card).toHaveCount(0)
  await expect(placeRow(page, 'rici')).toHaveAttribute('data-waiting', 'false')
  await page.locator('#topbar-cc').click()
  await expect(page.locator('.desk-date-line')).toBeHidden()
  await expect(clear).toBeHidden()
})

const commandLines = Array.from({ length: 10 }, (_, i) => `printf line-${i + 1}`)
const waitingPreviews: Array<[string, PermissionDisplay['body']]> = [
  ['短命令', { kind: 'command', command: 'printf sample' }],
  ['目录未知的短命令', { kind: 'command', command: 'printf sample' }],
  ['十行命令', { kind: 'command', command: commandLines.join('\n') }],
  ['改文件', { kind: 'edit', path: '/offline/project/sample.txt', changes: [{ before: 'first', after: 'second' }] }],
]

for (const [label, body] of waitingPreviews) {
  test(`宽窗等待纸片画出${label}`, async ({ page, shimUrl }) => {
    const task = { id: 'deadbeef', title: '校对示例', path: '/offline/project', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2 }
    const display = { body }
    const cwd = label === '目录未知的短命令' ? undefined : task.path
    const permission = { id: 'p1', taskId: task.id, tool: body.kind === 'edit' ? 'Edit' : 'Bash',
      description: '校对示例？', display, cwd, createdAt: 1 }
    await routePlaces(page, [placeItem('示例', { matterIds: [task.id], status: 'waiting', moving: false,
      waiting: { itemKey: `matter:${task.id}`, kind: 'permission', matterId: task.id, requestId: permission.id, summary: permission.description,
        count: 1, tool: permission.tool, display, cwd: permission.cwd },
    })])
    await routeRoster(page, [rosterItem(task.id, task.title)])
    await page.route('**/v1/matter?id=*', route => route.fulfill({ json: { matter: { ...task, kind: 'task' } } }))
    await page.route(/\/v1\/workbench(?:\?.*)?$/, route => route.fulfill({ json: { tasks: [task], projects: [], providers: [{ id: 'codex', displayName: 'Codex' }] } }))
    await page.route('**/v1/workbench/task?*', route => route.fulfill({
      json: { task, runId: 'example-run', events: [], artifacts: [], questions: [], permissions: [permission] },
    }))
    await page.goto(shimUrl)
    await expect(placeRow(page, '示例')).toBeVisible()
    const card = page.locator('#desk-waiting .desk-waiting-card')
    const panel = card.locator(`.approval-panel[data-kind="${body.kind}"]`)
    await expect(panel).toBeVisible()
    if (!cwd) {
      await expect(card.getByText('在 /offline/project', { exact: true })).toHaveCount(0)
      await expect(card.getByRole('button', { name: '允许这一步', exact: true })).toHaveCount(0)
      await expect(card.getByRole('button', { name: '先不做', exact: true })).toBeEnabled()
      await card.getByRole('button', { name: '打开看全再定' }).click()
      await expect(page.locator('#thing-name')).toHaveText('示例')
      await expect(page.locator('#thing-thread .wb-permission')).toBeVisible()
      return
    }
    await expect(card.getByText('在 /offline/project', { exact: true })).toBeVisible()
    if (label === '十行命令') {
      expect(await panel.locator('.approval-source').textContent() === commandLines.slice(0, 4).join('\n')).toBe(true)
      await expect(card.getByRole('button', { name: '还有 6 行' })).toBeVisible()
      await expect(card.getByRole('button', { name: '允许这一步', exact: true })).toHaveCount(0)
      await card.getByRole('button', { name: '打开看全再定' }).click()
      await expect(page.locator('#thing-name')).toHaveText('示例')
      const full = page.locator('#thing-thread .wb-permission')
      await full.getByText('还有 2 行 · 看全部', { exact: true }).click()
      await expect(full.getByText('printf line-10', { exact: false })).toBeVisible()
    } else {
      await expect(card.getByRole('button', { name: '允许这一步', exact: true })).toBeEnabled()
      if (body.kind === 'edit') {
        expect(await panel.locator('.approval-path').textContent() === 'sample.txt').toBe(true)
        await expect(panel.locator('[data-line="deleted"]')).toHaveCount(1)
        await expect(panel.locator('[data-line="added"]')).toHaveCount(1)
      } else {
        expect(await panel.locator('.approval-source').textContent() === 'printf sample').toBe(true)
      }
    }
  })
}

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
  const glow = () => page.locator('#topbar-cc').evaluate(el => {
    const style = getComputedStyle(el, '::before')
    return [style.content, style.animationName]
  })
  const waiting = placeRow(page, 'rici')
  const moving = placeRow(page, 'melu')
  await expect(page.locator('#desk-cc-presence')).toHaveText('CC 在家')
  await expect(situation).toHaveText('两件要你定，一件在做。')
  await expect(situation).toBeVisible()
  await expect(figure).toHaveCSS('width', '46px')
  await expect.poll(glow).toEqual(['none', 'none'])
  await expect(moving.locator('.place-dot')).toHaveCSS('animation-name', 'none')
  await expect(moving.locator('.place-dot')).toHaveCSS('outline-width', '3px')
  await expect(moving.locator('.place-dot')).toHaveCSS('width', '6px')
  await expect(waiting.locator('.place-dot')).toHaveCSS('animation-name', 'none')
  await expect(waiting.locator('.place-dot')).toHaveCSS('background-color', 'rgb(79, 107, 79)')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(glow).toEqual(['none', 'none'])
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
  for (const edge of ['top', 'right', 'bottom', 'left']) await expect(compose).toHaveCSS(`border-${edge}-width`, '0px')
  await expect(compose).toHaveCSS('border-radius', '20px')
  await expect(compose).not.toHaveCSS('box-shadow', 'none')
  // 功能按钮一个不少、也没多:更多(交办 / 项目 / 会话 / 搜索)、语音、朗读、发送
  for (const id of ['converse-mic', 'converse-voice-toggle', 'converse-send']) {
    await compose.locator('#' + id).click({ trial: true })
  }
  await expect(compose.locator('#desk-attach')).toHaveCount(0)
  const send = compose.locator('#converse-send')
  await expect(send).toHaveCSS('width', '30px')
  await expect(send).toHaveCSS('height', '30px')
  await expect(send).toHaveCSS('color', 'rgb(168, 159, 148)')
  await compose.locator('#converse-input').fill('写')
  await expect(send).toHaveCSS('background-color', 'rgb(79, 107, 79)')
  const [draft, plus, recipient, sendBox] = await Promise.all([
    compose.locator('textarea'), compose.locator('.conversation-add summary'), compose.locator('#converse-recipient-default'), send,
  ].map(locator => locator.boundingBox()))
  expect(draft!.y + draft!.height).toBeLessThan(plus!.y)
  expect(plus!.x + plus!.width).toBeLessThan(recipient!.x)
  expect(recipient!.x + recipient!.width).toBeLessThan(sendBox!.x)
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
  await expect(lines('归档')).toHaveText(['这件要你定 · 归档', summary, '我只看了这条请求，意见是：' + note.ccOpinion, '为什么来问你：' + note.questionReason])
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
  places = [placeItem('归档', { ...archive, waiting: { ...waiting, ccOpinion: '先别删。这是唯一一份备份。', questionReason: '删了回不来' } }), recipe]
  await expect(cards.filter({ hasText: '归档' }).locator('.desk-waiting-opinion')).toContainText('先别删')
  await expect(answer).toBeFocused()
})

test('CC 停止时空对话提示实情，保留草稿，恢复后可以发送', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: false, presenceDown: true })
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: { messages: [] } }))
  await routePlaces(page, [])
  await page.goto(shimUrl)
  const empty = page.locator('.converse-empty')
  const input = page.locator('#converse-input')
  const send = page.locator('#converse-send')
  await expect(page.locator('#desk-cc-presence')).toHaveText('CC 没在运行')
  await expect(empty.getByRole('heading')).toHaveText('CC 没在运行')
  await expect(empty.getByRole('img')).toHaveAttribute('src', /\/unlit\/front\.png$/)
  await expect(empty).toContainText('它起来之前，这里说的话送不出去。')
  await expect(empty.getByRole('button', { name: '叫 CC 起来' })).toBeEnabled()
  await expect(empty.locator('.converse-starter')).toHaveCount(0)
  await expect(input).toHaveAttribute('placeholder', 'CC 没在运行')
  await input.fill('回来再发')
  await input.press('Enter')
  await expect(input).toHaveValue('回来再发')
  await expect(send).toBeDisabled()

  await shim.invoke('demo.seed', { daemonAlive: true })
  await expect(empty.getByRole('heading')).toHaveText('CC 在这儿', { timeout: 10_000 })
  await expect(empty.locator('.converse-starter')).toHaveCount(3)
  await expect(input).not.toHaveAttribute('placeholder', 'CC 没在运行')
  await expect(input).toHaveValue('回来再发')
  await expect(send).toBeEnabled()
})

test('CC 停止时已有对话和决定仍可读，发送和决定等恢复', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: false, presenceDown: true })
  await routePlaces(page, [
    askingPlace('访谈', 'aaaa0001'),
    placeItem('归档', {
      waiting: { kind: 'permission', itemKey: 'matter:deadbeef', matterId: 'deadbeef', requestId: 'req-1', summary: '保留备份吗？', count: 1 },
    }),
  ])
  await page.goto(shimUrl)
  const note = page.locator('#converse-offline-note')
  await expect(note).toContainText('CC 没在运行，现在说的话送不出去。')
  await expect(note.getByRole('button', { name: '叫它起来' })).toBeVisible()
  await expect(page.locator('#converse-scroll [data-converse-message]').first()).toBeVisible()
  await expect(page.locator('#converse-scroll')).toHaveCSS('mask-image', /linear-gradient.*16px/)
  await expect(page.locator('#converse-send')).toBeDisabled()
  const cards = page.locator('.desk-waiting-card')
  const buttons = cards.getByRole('button').and(page.locator('button:not([data-wake-cc])'))
  const wakeButtons = cards.getByRole('button', { name: '叫它起来' })
  await expect(buttons).toHaveCount(3)
  await expect(wakeButtons).toHaveCount(2)
  for (const button of await buttons.all()) {
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', 'CC 没在运行')
  }
  await shim.invoke('demo.seed', { daemonAlive: true })
  await expect(note).toBeHidden({ timeout: 10_000 })
  await expect(wakeButtons).toHaveCount(0)
  await expect(page.locator('#converse-send')).toBeEnabled()
  for (const button of await buttons.all()) {
    await expect(button).toBeEnabled()
    await expect(button).not.toHaveAttribute('title', 'CC 没在运行')
  }
})

test('一件事的等你定纸条可以就地叫 CC 起来，失败后可以重试', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: false, presenceDown: true })
  await routePlaces(page, [askingPlace('访谈', 'aaaa0001')])
  let releaseStart!: () => void
  const startResponse = new Promise<void>(resolve => { releaseStart = resolve })
  let starts = 0
  await page.route('**/__invoke', async route => {
    const { command, args } = route.request().postDataJSON()
    if (command !== 'wechat_cli_json' || args?.args?.[0] !== 'service' || args.args[1] !== 'start') {
      return route.fallback()
    }
    starts++
    await startResponse
    return route.fulfill({ json: { error: '模拟启动失败' } })
  })
  await page.goto(shimUrl)
  await placeRow(page, '访谈').locator('.place-row').click()
  await expect(page.locator('#thing-name')).toHaveText('访谈')
  const card = page.locator('#thing-thread #desk-waiting .desk-waiting-card')
  const note = card.locator('.desk-offline-note')
  const wake = note.locator('button[data-wake-cc]')
  const answer = card.getByRole('button', { name: '去回答' })
  try {
    await expect(answer).toBeDisabled()
    await expect(note).toBeVisible()
    await expect(note).toContainText('CC 没在运行，叫它起来以后才能回答。')
    await expect(wake).toHaveText('叫它起来')
    await wake.click()
    await expect(wake).toHaveText('在叫…')
    await expect(wake).toBeDisabled()
    await expect.poll(() => starts).toBe(1)
  } finally {
    releaseStart()
  }
  await expect(note.getByRole('status')).toHaveText('没叫起来，再点一次试试。')
  await expect(note.getByRole('status')).toBeVisible()
  await expect(wake).toHaveText('叫它起来')
  await expect(wake).toBeEnabled()
  await wake.click()
  await expect.poll(() => starts).toBe(2)
  await expect(wake).toBeEnabled()

  await shim.invoke('demo.seed', { daemonAlive: true })
  await expect(note).toBeHidden({ timeout: 10_000 })
  await expect(answer).toBeEnabled()
})

test('宽窗次要页面共用纸底，内容栏留在纸内', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  const paper = page.locator('.dash-main')
  await expect(paper).toHaveCSS('background-color', 'rgb(253, 251, 247)')
  for (const [name, column, max] of [
    ['notebook', '.notebook-header', 712], ['memory', '.memory-profile-overview', 712],
    ['recollections', 'header', 860], ['atelier', '.atelier-gallery', 860],
    ['todos', '.todos-head', 712], ['sessions', '.dialogue-page', 960],
  ] as const) {
    await clickNav(page, name)
    const pane = paper.locator(`:scope > [data-pane="${name}"]`)
    await expect(pane).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const content = pane.locator(column).first()
    await expect(content).toBeVisible()
    const [bounds, body] = await Promise.all([paper.boundingBox(), content.boundingBox()])
    expect(body!.width).toBeLessThanOrEqual(max)
    expect(body!.x - bounds!.x).toBeGreaterThanOrEqual(36)
    expect(bounds!.x + bounds!.width - body!.x - body!.width).toBeGreaterThanOrEqual(36)
    await expect.poll(() => pane.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  }
  for (const [name, column] of [
    ['sessions', '.dialogue-page'], ['plugins', '.a2a-agents-body'], ['logs', '.logs-body'],
  ] as const) {
    if (name !== 'sessions') await paper.locator(`[role="tab"][data-backstage-pane="${name}"]:visible`).click()
    const pane = paper.locator(`:scope > [data-pane="${name}"]`)
    const title = pane.getByRole('heading', { name: '后厨', exact: true, level: 1 })
    await expect(title).toBeVisible()
    const [heading, tabs, body] = await Promise.all([
      title, pane.getByRole('tablist', { name: '后厨视图' }), pane.locator(column),
    ].map(locator => locator.boundingBox()))
    expect(heading!.x).toBeCloseTo(tabs!.x, 0)
    expect(heading!.x).toBeCloseTo(body!.x, 0)
    await expect(pane).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect.poll(() => pane.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    if (name === 'sessions') {
      await expect(pane.locator('.dialogue-sidebar')).toHaveCSS('width', '260px')
      const views = pane.locator('#dialogue-views button')
      await expect(views).toHaveCount(4)
      expect(await views.evaluateAll(buttons => buttons.map(button => {
        const text = document.createRange()
        text.selectNodeContents(button)
        return text.getClientRects().length
      }))).toEqual([1, 1, 1, 1])
    } else {
      await expect(pane.locator(column)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
  }
})

test('更多打开设置后收起，两个菜单都能按 Esc 或点外关闭并还原焦点', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  const more = page.locator('.topbar-more')
  const add = page.locator('.conversation-add')
  for (const menu of [more, add]) {
    const trigger = menu.locator('summary')
    await trigger.click()
    await expect(menu).toHaveAttribute('open', '')
    await page.keyboard.press('Escape')
    await expect(menu).not.toHaveAttribute('open', '')
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(menu).toHaveAttribute('open', '')
    await page.locator('#converse-scroll').click()
    await expect(menu).not.toHaveAttribute('open', '')
    await expect(trigger).toBeFocused()
  }
  await more.locator('summary').click()
  await more.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await expect(more).not.toHaveAttribute('open', '')
})
