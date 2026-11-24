import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { PRESENCE_OK, routePresenceTopic } from './presence-topic'
import { placeItem, placeSession, placeRow, routePlaces, routeRoster, rosterItem, terminalPlace } from './roster-fixture'

test.use({ viewport: { width: 1280, height: 820 } })

const back = (page: Page) => page.locator('#desk-back')
const forward = (page: Page) => page.locator('#desk-forward')
const row = (page: Page, name: string) => placeRow(page, name).locator('.place-row')
const input = (page: Page) => page.locator('#converse-input')

async function expectHistory(page: Page, canBack: boolean, canForward: boolean) {
  await (canBack ? expect(back(page)).toBeEnabled() : expect(back(page)).toBeDisabled())
  await (canForward ? expect(forward(page)).toBeEnabled() : expect(forward(page)).toBeDisabled())
}

async function shortcuts(page: Page) {
  return await page.locator('html').getAttribute('data-platform') === 'macos'
    ? { back: 'Meta+[', forward: 'Meta+]' }
    : { back: 'Alt+ArrowLeft', forward: 'Alt+ArrowRight' }
}

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await routePresenceTopic(page, { presence: () => PRESENCE_OK })
  await routePlaces(page, [placeItem('菜谱'), placeItem('花园')], { writable: true })
})

test('从全部到两个地方，逐条后退和前进', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await expect(back(page)).toBeVisible()
  await expectHistory(page, false, false)
  await row(page, '菜谱').click()
  await expectHistory(page, true, false)
  await row(page, '花园').click()
  await expectHistory(page, true, false)
  await back(page).click()
  await expect(row(page, '菜谱')).toHaveAttribute('aria-pressed', 'true')
  await expectHistory(page, true, true)
  await expect(back(page)).toBeFocused()
  await back(page).click()
  for (const name of ['菜谱', '花园']) await expect(row(page, name)).toHaveAttribute('aria-pressed', 'false')
  await expectHistory(page, false, true)
  await expect(back(page)).toBeFocused()
  await forward(page).click()
  await expect(row(page, '菜谱')).toHaveAttribute('aria-pressed', 'true')
  await expectHistory(page, true, true)
  await forward(page).click()
  await expect(row(page, '花园')).toHaveAttribute('aria-pressed', 'true')
  await expectHistory(page, true, false)
})

test('本子后退回地方，新导航清掉前进记录', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await row(page, '菜谱').click()
  await page.getByRole('button', { name: '本子', exact: true }).click()
  await expect(page.locator('#notebook-pane')).toBeVisible()
  await back(page).click()
  await expect(page.locator('#thing-name')).toHaveText('菜谱')
  await expect(row(page, '菜谱')).toHaveAttribute('aria-pressed', 'true')
  await expectHistory(page, true, true)
  await row(page, '花园').click()
  await expectHistory(page, true, false)
})

test('快捷键保留 CC 草稿和历史按钮焦点，组字时忽略', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await input(page).fill('还没发的话')
  await row(page, '菜谱').click()
  await row(page, '花园').click()
  const keys = await shortcuts(page)
  const mac = keys.back.startsWith('Meta')
  await back(page).focus()
  await back(page).dispatchEvent('keydown', { key: mac ? '[' : 'ArrowLeft', metaKey: mac, altKey: !mac, isComposing: true })
  await expect(row(page, '花园')).toHaveAttribute('aria-pressed', 'true')
  for (const [key, place] of [[keys.back, '菜谱'], [keys.forward, '花园']] as const) {
    await page.keyboard.press(key)
    await expect(row(page, place)).toHaveAttribute('aria-pressed', 'true')
    await expect(input(page)).toHaveValue('还没发的话')
    await expect(back(page)).toBeFocused()
  }
})

test('收起左栏时箭头仍可点，悬停不浮出', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await row(page, '菜谱').click()
  await page.locator('#desk-rail-toggle').click()
  const rail = page.locator('#dash-global-rail')
  await expect(rail).toBeHidden()
  for (const button of [back(page), forward(page)]) {
    await button.hover()
    await expect(rail).toBeHidden()
    await button.click()
    await expect(rail).toBeHidden()
  }
  await expectHistory(page, true, false)
})

for (const width of [1280]) {
  test(`${width}px 收起一行再放回原位`, async ({ page, shimUrl }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto(shimUrl)
    await row(page, '菜谱').hover()
    await placeRow(page, '菜谱').locator('.place-more').click()
    await page.getByRole('button', { name: '收起这一行' }).click()
    await expect(row(page, '菜谱')).toHaveCount(0)
    const hidden = page.getByRole('button', { name: '收起的 1 处' })
    await expect(hidden).toBeInViewport()
    await hidden.click()
    await expect(hidden).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '放回来' }).click()
    await expect(page.locator('#places-root .place-name')).toHaveText(['菜谱', '花园'])
    await expect(hidden).toHaveCount(0)
  })
}

test('macOS 全屏状态去掉红黄绿预留宽度', async ({ page, shimUrl }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
  await page.goto(shimUrl)
  const root = page.locator('html')
  const toggle = page.locator('#desk-rail-toggle')
  await expect(toggle).toBeVisible()
  await expect(root).not.toHaveAttribute('data-desk-fullscreen', '')
  expect((await toggle.boundingBox())?.x).toBe(84)
  await root.evaluate(el => el.setAttribute('data-desk-fullscreen', ''))
  expect((await toggle.boundingBox())?.x).toBe(4)
  await root.evaluate(el => el.removeAttribute('data-desk-fullscreen'))
  expect((await toggle.boundingBox())?.x).toBe(84)
})


test('鼠标侧键导航，模态对话框打开时快捷键不导航', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await row(page, '菜谱').click()
  await row(page, '花园').click()
  await back(page).focus()
  await back(page).dispatchEvent('mouseup', { button: 3 })
  await expect(row(page, '菜谱')).toHaveAttribute('aria-pressed', 'true')
  await expect(back(page)).toBeFocused()
  await back(page).dispatchEvent('mouseup', { button: 4 })
  await expect(row(page, '花园')).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    dialog.showModal()
  })
  await page.keyboard.press((await shortcuts(page)).back)
  await expect(row(page, '花园')).toHaveAttribute('aria-pressed', 'true')
})

test('终端线可后退，地方页签里的会话消失后跳过', async ({ page, shimUrl }) => {
  const updatedAt = Date.now()
  let available = true
  await routePlaces(page, () => [placeItem('菜谱'), terminalPlace('花园', 's1', '要看一下文件', {
    sessions: available ? [placeSession('s1', 'waiting', updatedAt)] : [],
    ...(!available ? { waiting:null, status:null, line:'没有会话' } : {}),
  })])
  const item=rosterItem('s1','花园',{key:'terminal:s1',kind:'terminal',updatedAt})
  await routeRoster(page,[item])
  await page.route('**/v1/roster',route=>route.fulfill({json:{items:available?[item]:[],version:String(available)}}))
  await page.route('**/v1/cli/sessions?**', route => route.fulfill({
    json: { sessions: available ? [{ session_id: 's1', status: 'idle' }] : [] },
  }))
  await page.route('**/v1/cli/activity?**', route => route.fulfill({ json: { items: [] } }))
  await page.goto(shimUrl)
  await row(page, '菜谱').click()
  await row(page, '菜谱').click()
  await expect(row(page,'菜谱')).toHaveAttribute('aria-pressed','true')
  // 在菜谱的页面里看不到花园的纸条(别处等你定的不压在正文上);从左栏进花园,它的线里就有。
  await row(page, '花园').click()
  const draft = page.locator('#thing-thread [data-terminal-input]')
  await draft.fill('终端未发送草稿')
  await page.locator('#topbar-cc').click()
  await expectHistory(page, true, false)
  await back(page).click()
  await expect(draft).toBeVisible()
  await expect(draft).toHaveValue('终端未发送草稿')
  await forward(page).click()
  await expect(draft).toBeHidden()
  available = false
  await expect(page.locator('#topbar-roster')).toHaveText('在做 0',{timeout:6000})
  await expect(placeRow(page, '花园').locator('.place-line')).toHaveText('没有会话',{timeout:9000})
  await back(page).click()
  await expectHistory(page, true, true)
  await expect(draft).toBeHidden()
  await expect(row(page, '菜谱')).toHaveAttribute('aria-pressed', 'true')
})
