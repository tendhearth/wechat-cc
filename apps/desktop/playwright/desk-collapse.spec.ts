import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { PRESENCE_OK, routePresenceTopic } from './presence-topic'
import { askingPlace, placeItem, routePlaces } from './roster-fixture'

test.use({ viewport: { width: 1280, height: 820 } })

const rail = (page: Page) => page.locator('#dash-global-rail')
const toggle = (page: Page) => page.locator('#desk-rail-toggle')
const cc = (page: Page) => page.locator('#topbar-cc')
const main = (page: Page) => page.locator('.dash-main')
const scroll = (page: Page) => page.locator('#converse-scroll')
const input = (page: Page) => page.locator('#converse-input')

async function platformShortcut(page: Page) {
  const mac = await page.locator('html').getAttribute('data-platform') === 'macos'
  return { mac, keys: mac ? 'Meta+b' : 'Control+b' }
}

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await routePresenceTopic(page, { presence: () => PRESENCE_OK })
  await page.route('**/v1/protocol/capabilities', route => route.fulfill({ json: { routes: 'v1', topics: 'v1' } }))
  await page.route('**/v1/matter/owner-chat/window**', route => route.fulfill({ json: {
    messages: Array.from({ length: 50 }, (_, i) => ({
      kind: i === 0 ? 'user' : 'text', text: `第 ${i} 条旧消息。`, messageId: `old-${i}`, createdAt: i + 1,
    })),
  } }))
  await page.route('**/v1/matter/owner-chat/work', route => route.fulfill({ json: { references: [], results: [] } }))
  await page.route('**/v1/matter/owner-chat/events**', route => route.fulfill({ json: { running: null, events: [], cursor: 0 } }))
})

const heading = (page: Page) => page.locator('.desk-heading')
const peeking = (page: Page) => page.locator('html[data-desk-peeking]')
const away = (page: Page) => page.mouse.move(1100, 420)

test('整个收起让出全宽，按钮位置固定，展开还原几何', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await expect(toggle(page)).toBeVisible()
  const { mac } = await platformShortcut(page)
  await expect(toggle(page)).toHaveAttribute('aria-controls', 'dash-global-rail')
  await expect(toggle(page)).toHaveAttribute('title', mac ? '收起左边 ⌘B' : '收起左边 Ctrl+B')
  const geometry = () => Promise.all([rail(page), main(page), scroll(page), toggle(page)].map(el => el.boundingBox()))
  const expanded = await geometry()
  expect(expanded[3]!.x).toBe(mac ? 84 : 4)
  await toggle(page).click()
  await expect(rail(page)).toBeHidden()
  await expect(toggle(page)).toHaveAccessibleName('展开左边')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  const [, right, talk, button] = await geometry()
  expect(right!.x).toBe(0)
  expect(right!.width).toBe(1280)
  expect(talk!.width).toBeLessThanOrEqual(780)
  expect(talk!.x + talk!.width / 2).toBeCloseTo(right!.width / 2)
  expect(button).toEqual(expanded[3])
  await page.mouse.move(button!.x + 5, button!.y + 5)
  await expect(rail(page)).toBeHidden()
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  expect(await geometry()).toEqual(expanded)
})

for (const [platform, keys, wrongKeys] of [
  ['MacIntel', 'Meta+b', 'Control+b'],
  ['Win32', 'Control+b', 'Meta+b'],
]) {
  test(`${platform} 快捷键、输入法、草稿、焦点和阅读位置`, async ({ page, shimUrl }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), platform)
    await routePlaces(page, [])
    await page.goto(shimUrl)
    await expect(toggle(page)).toBeVisible()
    const mac = platform === 'MacIntel'
    await input(page).fill('这句话还没发')
    await expect(scroll(page).locator('[data-converse-message]')).toHaveCount(50)
    await scroll(page).evaluate(el => { el.scrollTop = 400 })
    const position = () => scroll(page).evaluate(el => el.scrollTop)
    const before = await position()

    await input(page).dispatchEvent('keydown', { key: 'b', metaKey: mac, ctrlKey: !mac, isComposing: true })
    await page.keyboard.press(wrongKeys)
    await page.keyboard.press('Meta+Backslash')
    await page.keyboard.press('Control+Backslash')
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press(keys)
    await expect(rail(page)).toBeHidden()
    await expect(input(page)).toBeFocused()
    await expect(input(page)).toHaveValue('这句话还没发')
    expect(await position()).toBe(before)

    await toggle(page).click()
    await expect(rail(page)).toBeVisible()
    await expect(toggle(page)).toBeFocused()
    await expect(input(page)).toHaveValue('这句话还没发')
    expect(await position()).toBe(before)
  })
}

test('悬停按钮只浮出左栏，移入保持、离开延迟收回，Esc 立即收回', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await away(page)
  const geometry = () => Promise.all([main(page).boundingBox(), scroll(page).boundingBox()])
  const before = await geometry()
  await toggle(page).hover()
  await expect(rail(page)).toBeVisible()
  await expect(rail(page)).toHaveCSS('position', 'absolute')
  await expect(rail(page)).toHaveCSS('width', '304px')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  const { mac } = await platformShortcut(page)
  await expect(toggle(page)).toHaveAttribute('title', mac ? '展开左边 ⌘B' : '展开左边 Ctrl+B')
  expect(await geometry()).toEqual(before)
  await expect.poll(async () => (await rail(page).boundingBox())?.x).toBe(0)
  const box = await rail(page).boundingBox()
  expect(box!.y).toBe(before[0]!.y)
  expect(box!.x + box!.width).toBeGreaterThan(before[0]!.x)

  await cc(page).hover()
  const now = Date.now()
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now + 1000)
  await expect(rail(page)).toBeVisible()
  await away(page)
  await page.clock.runFor(250)
  await expect(rail(page)).toBeVisible()
  await page.clock.runFor(51)
  expect(await rail(page).isVisible()).toBe(false)
  expect(await geometry()).toEqual(before)

  const button = await toggle(page).boundingBox()
  await page.mouse.move(button!.x + 12, button!.y + 10)
  await expect(rail(page)).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await rail(page).isVisible()).toBe(false)
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
})

test('从左缘浮出可筛选和进本子，离开仍留在本子页', async ({ page, shimUrl }) => {
  await routePlaces(page, [placeItem('菜谱')])
  await page.goto(shimUrl)
  await toggle(page).click()
  const top = await heading(page).boundingBox()
  await page.mouse.move(2, top!.y + top!.height + 40)
  await expect(peeking(page)).toHaveCount(1)
  const row = rail(page).locator('.place-row').filter({ hasText: '菜谱' })
  await row.click()
  await expect(page.locator('#desk-place-clear')).toHaveText('只看 菜谱 · 回到全部')
  const notebook = rail(page).getByRole('button', { name: '本子', exact: true })
  await notebook.click()
  await expect(page.locator('#notebook-pane')).toBeVisible()
  await expect(notebook).toHaveAttribute('aria-current', 'page')
  await away(page)
  await expect(rail(page)).toBeHidden()
  await expect(page.locator('#notebook-pane')).toBeVisible()
  const [right, paper] = await Promise.all([main(page).boundingBox(), page.locator('.notebook-header').boundingBox()])
  expect(paper!.width).toBeLessThanOrEqual(780)
  expect(paper!.x + paper!.width / 2).toBeCloseTo(right!.x + right!.width / 2)

  const write = page.getByRole('textbox', { name: '接着写' })
  await write.fill('本子里的草稿')
  for (const visible of [true, false]) {
    await page.keyboard.press((await platformShortcut(page)).keys)
    if (visible) await expect(rail(page)).toBeVisible()
    else await expect(rail(page)).toBeHidden()
    await expect(write).toBeFocused()
    await expect(write).toHaveValue('本子里的草稿')
  }
})

test('浮出后点按钮固定展开，移开后右栏仍被推开', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await away(page)
  await toggle(page).hover()
  await expect(peeking(page)).toHaveCount(1)
  await toggle(page).click()
  await away(page)
  await expect(peeking(page)).toHaveCount(0)
  await expect(toggle(page)).toHaveAccessibleName('收起左边')
  await expect(rail(page)).toHaveCSS('position', 'static')
  expect((await main(page).boundingBox())!.x).toBe(304)
})

test('收起后等待绿点用 CC 的同一计数，展开只在 CC 上显示', async ({ page, shimUrl }) => {
  let places = [askingPlace('菜谱', 'aaaa0001')]
  await routePlaces(page, () => places)
  await page.goto(shimUrl)
  const dot = toggle(page).locator('.topbar-waiting-dot')
  await expect(cc(page).locator('.topbar-waiting-dot')).toBeVisible()
  await expect(dot).toBeHidden()
  await toggle(page).click()
  await expect(dot).toBeVisible()
  await expect(main(page).locator('.desk-waiting-card')).toBeVisible()
  places = []
  await expect(dot).toBeHidden({ timeout: 10_000 })
})

test('键盘聚焦按钮不会浮出，隐藏的左栏不可 Tab，浮栏内的键盘焦点使它保持', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await away(page)
  await page.keyboard.press('Tab')
  expect(await rail(page).evaluate(el => el.contains(document.activeElement))).toBe(false)
  await page.keyboard.press('Shift+Tab')
  await expect(toggle(page)).toBeFocused()
  await expect(rail(page)).toBeHidden()

  await toggle(page).hover()
  await expect(rail(page)).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(cc(page)).toBeFocused()
  const now = Date.now()
  await page.clock.install({ time: now })
  await away(page)
  await page.clock.runFor(350)
  await expect(rail(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(toggle(page)).toBeFocused()
  expect(await rail(page).isVisible()).toBe(false)
  await page.keyboard.press('Space')
  await expect(rail(page)).toBeVisible()
  await expect(peeking(page)).toHaveCount(0)
})

test('刷新记住两种状态，800px 下忽略收起选择和快捷键', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await page.reload()
  await expect(rail(page)).toBeHidden()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  await toggle(page).click()
  await page.reload()
  await expect(rail(page)).toHaveCSS('width', '304px')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await toggle(page).click()
  await page.setViewportSize({ width: 800, height: 820 })
  await expect(rail(page)).toHaveCSS('height', '72px')
  await expect(toggle(page)).toBeHidden()
  const geometry = () => Promise.all([rail(page), main(page), scroll(page)].map(el => el.boundingBox()))
  const before = await geometry()
  await page.keyboard.press((await platformShortcut(page)).keys)
  await expect(page.locator('html[data-desk-collapsed]')).toHaveCount(0)
  expect(await geometry()).toEqual(before)
  await page.setViewportSize({ width: 900, height: 820 })
  await expect(rail(page)).toBeHidden()
})

test('减少动态效果时浮出没有动画或过渡', async ({ page, shimUrl }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await away(page)
  await toggle(page).hover()
  await expect(rail(page)).toBeVisible()
  await expect(rail(page)).toHaveCSS('animation-name', 'none')
  await expect(rail(page)).toHaveCSS('transition-duration', '0s')
})

test.describe('无悬停设备', () => {
  test.use({ hasTouch: true, isMobile: true })
  test('不会浮出，按钮仍可固定展开', async ({ page, shimUrl }) => {
    await routePlaces(page, [])
    await page.goto(shimUrl)
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    await toggle(page).tap()
    await away(page)
    await toggle(page).hover()
    await expect(rail(page)).toBeHidden()
    await toggle(page).tap()
    await expect(rail(page)).toBeVisible()
  })
})

test('收起时标题条仍可拖，左边缘从标题条下面开始，按钮不触发拖拽', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await page.evaluate(() => {
    const w = window as unknown as { __dragCalls: number; __TAURI__: { window: { getCurrentWindow: () => unknown } } }
    w.__dragCalls = 0
    w.__TAURI__.window.getCurrentWindow = () => ({ startDragging: async () => { w.__dragCalls += 1 } })
  })
  const calls = () => page.evaluate(() => (window as unknown as { __dragCalls: number }).__dragCalls)
  const box = await heading(page).boundingBox()
  await page.mouse.move(2, box!.y + box!.height / 2)
  await expect(rail(page)).toBeHidden()
  await page.mouse.click(2, box!.y + box!.height / 2)
  await page.mouse.click(450, box!.y + box!.height / 2)
  await expect.poll(calls).toBe(2)
  await toggle(page).dispatchEvent('mousedown', { button: 0 })
  expect(await calls()).toBe(2)
})
