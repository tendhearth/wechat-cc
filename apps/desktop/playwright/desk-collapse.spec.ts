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
  return { mac, keys: mac ? 'Meta+Backslash' : 'Control+Backslash' }
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

test('书脊宽 64，右栏变宽，恢复后几何一致', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await expect(page.getByRole('button', { name: '收起左边' })).toBeVisible()
  await expect(toggle(page)).toHaveAttribute('aria-controls', 'places-root')
  await expect(toggle(page)).toHaveText('‹')
  const geometry = () => Promise.all([rail(page), main(page), scroll(page)].map(el => el.boundingBox()))
  const expanded = await geometry()
  await toggle(page).click()
  // 收起后书脊上的 CC 叫「CC，展开左边」,名字里也带这四个字;这里要的是箭头那个按钮。
  await expect(page.getByRole('button', { name: '展开左边', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle(page)).toHaveText('›')
  const [spine, right, talk] = await geometry()
  expect(spine!.width).toBe(64)
  expect(right!.width).toBeGreaterThan(expanded[1]!.width)
  expect(talk!.width).toBeLessThanOrEqual(780)
  expect(talk!.x + talk!.width / 2).toBeCloseTo(right!.x + right!.width / 2)
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  expect(await geometry()).toEqual(expanded)
})

test('快捷键保留草稿和输入焦点，组字中忽略，按钮保留阅读位置', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await expect(toggle(page)).toBeVisible()
  const { mac, keys } = await platformShortcut(page)
  await input(page).fill('这句话还没发')
  await expect(scroll(page).locator('[data-converse-message]')).toHaveCount(50)
  await scroll(page).evaluate(el => { el.scrollTop = 400 })
  const position = () => scroll(page).evaluate(el => el.scrollTop)
  const before = await position()

  await input(page).dispatchEvent('keydown', { key: '\\', metaKey: mac, ctrlKey: !mac, isComposing: true })
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press(keys)
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(input(page)).toBeFocused()
  await expect(input(page)).toHaveValue('这句话还没发')
  expect(await position()).toBe(before)

  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle(page)).toBeFocused()
  await expect(input(page)).toHaveValue('这句话还没发')
  expect(await position()).toBe(before)
})

test('CC 沿用等待绿点，隐藏的现状与地方行不进键盘顺序，右边纸条还在', async ({ page, shimUrl }) => {
  const quiet = placeItem('旧事', { updatedAt: Date.now() - 8 * 86_400_000, moving: false, status: 'done' })
  const pending = askingPlace('菜谱', 'aaaa0001')
  let places = [pending, quiet]
  await routePlaces(page, () => places)
  await page.goto(shimUrl)
  const situation = page.locator('#desk-cc-situation')
  const waiting = cc(page).locator('.topbar-waiting-dot')
  const list = rail(page).locator('.places-strip')
  const quietToggle = list.locator('.desk-quiet-toggle')
  await expect(situation).toBeVisible()
  await expect(quietToggle).toBeVisible()
  await expect(waiting).toBeHidden()
  await toggle(page).click()
  await expect(cc(page).locator('.topbar-figure img:visible, .now-pet-sprite:visible').first()).toBeVisible()
  await expect(waiting).toBeVisible()
  await expect(cc(page)).toHaveAccessibleName(/有 1 件在等你/)
  await expect(situation).toBeHidden()
  await expect(list.locator('.place-row').first()).toBeHidden()
  await expect(quietToggle).toBeHidden()
  await expect(main(page).locator('.desk-waiting-card')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(cc(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(rail(page).getByRole('button', { name: '本子', exact: true })).toBeFocused()
  places = [quiet]
  await expect(waiting).toBeHidden({ timeout: 10_000 })
})

test('书脊导航竖排，当前页用墨色，点 CC 只展开', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  const nav = rail(page).getByRole('navigation', { name: '主导航' })
  const buttons = ['本子', '记忆', '回忆', '搜索'].map(name => nav.getByRole('button', { name, exact: true }))
  for (const button of buttons) {
    await expect(button).toHaveCSS('writing-mode', 'vertical-rl')
    await expect(button).toHaveCSS('text-orientation', 'upright')
  }
  const more = nav.locator('summary')
  await expect(more).toHaveAccessibleName('更多')
  await more.click()
  await expect(nav.getByRole('button', { name: '设置' })).toBeVisible()
  await more.click()
  const [notebook, memory, recollections, search] = buttons
  const colors = await nav.evaluate(el => {
    const styles = getComputedStyle(el)
    return ['--th-ink', '--th-ink-soft'].map(token => {
      const probe = document.createElement('span')
      probe.style.color = styles.getPropertyValue(token).trim()
      el.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
  })
  await notebook.click()
  await expect(page.locator('#notebook-pane')).toBeVisible()
  await expect(notebook).toHaveAttribute('aria-current', 'page')
  await expect(notebook).toHaveCSS('color', colors[0])
  await expect(memory).toHaveCSS('color', colors[1])
  const [right, paper] = await Promise.all([main(page), page.locator('.notebook-header')].map(el => el.boundingBox()))
  expect(paper!.width).toBeLessThanOrEqual(780)
  expect(paper!.x + paper!.width / 2).toBeCloseTo(right!.x + right!.width / 2)
  const write = page.getByRole('textbox', { name: '接着写' })
  await write.fill('本子里的草稿')
  const { keys } = await platformShortcut(page)
  for (const expanded of ['true', 'false']) {
    await page.keyboard.press(keys)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', expanded)
    await expect(write).toBeFocused()
    await expect(write).toHaveValue('本子里的草稿')
  }

  await memory.click()
  await expect(main(page).locator('article[data-pane="memory"]')).toBeVisible()
  await expect(memory).toHaveAttribute('aria-current', 'page')
  await expect(memory).toHaveCSS('color', colors[0])
  await expect(notebook).toHaveCSS('color', colors[1])
  await recollections.click()
  await expect(recollections).toHaveAttribute('aria-current', 'page')
  await search.click()
  await expect(search).toHaveAttribute('aria-current', 'page')
  await memory.click()
  await cc(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(memory).toHaveAttribute('aria-current', 'page')
  await expect(main(page).locator('article[data-pane="memory"]')).toBeVisible()
})

test('刷新记住两种状态，800px 下忽略收起选择和快捷键', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await page.reload()
  await expect(rail(page)).toHaveCSS('width', '64px')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  await toggle(page).click()
  await page.reload()
  await expect(rail(page)).toHaveCSS('width', '304px')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await toggle(page).click()
  await page.setViewportSize({ width: 800, height: 820 })
  await expect(rail(page)).toHaveCSS('height', '72px')
  await expect(page.getByRole('button', { name: /左边/ })).toHaveCount(0)
  const before = await Promise.all([rail(page), main(page), scroll(page)].map(el => el.boundingBox()))
  await page.keyboard.press((await platformShortcut(page)).keys)
  await expect(page.locator('html')).not.toHaveAttribute('data-desk-collapsed', '')
  expect(await Promise.all([rail(page), main(page), scroll(page)].map(el => el.boundingBox()))).toEqual(before)
  await page.setViewportSize({ width: 900, height: 820 })
  await expect(rail(page)).toHaveCSS('width', '64px')
})

test('书脊顶上的空白可拖，开关和 CC 不触发拖拽', async ({ page, shimUrl }) => {
  await routePlaces(page, [])
  await page.goto(shimUrl)
  await toggle(page).click()
  await page.evaluate(() => {
    const w = window as unknown as { __dragCalls: number; __TAURI__: { window: { getCurrentWindow: () => unknown } } }
    w.__dragCalls = 0
    w.__TAURI__.window.getCurrentWindow = () => ({ startDragging: async () => { w.__dragCalls += 1 } })
  })
  const calls = () => page.evaluate(() => (window as unknown as { __dragCalls: number }).__dragCalls)
  const titlebar = rail(page).locator('.desk-rail-titlebar')
  await expect(titlebar).toBeVisible()
  const box = await titlebar.boundingBox()
  await page.mouse.move(box!.x + 12, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  await expect.poll(calls).toBe(1)
  await toggle(page).dispatchEvent('mousedown', { button: 0 })
  await cc(page).dispatchEvent('mousedown', { button: 0 })
  expect(await calls()).toBe(1)
})
