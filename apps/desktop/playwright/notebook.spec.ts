import type { Page } from '@playwright/test'
import type { NotebookEntryT, NotebookPaperT } from '@wechat-cc/protocol'
import { test, expect, clickNav } from './fixtures'
import { NOTEBOOK_CACHE_KEY } from '../src/modules/notebook-state.js'

const october = '2026-10-28'
const november = '2026-11-04'
const pageDay = '2026-11-19'
const writeInput = '#notebook-write'
const uniqueLine = 'notebook-private-71c6'
const pen = { font: 'kai', ink: 'blueBlack', reason: '慢一点写' }

function row(id: number, author: NotebookEntryT['author'], body: string, date: string, refId: string | null = null): NotebookEntryT {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, author, body,
    createdAt: new Date(`${date}T15:00:00`).getTime() + id, refId,
    struckAt: null, clientId: null, origin: 'desktop',
  }
}

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function mockNotebook(page: Page, initial: Record<string, NotebookEntryT[]> = {}) {
  const entries = structuredClone(initial)
  const writes: { body: string, clientId: string }[] = []
  const strikes: { id: string, struck: boolean }[] = []
  const settings: { paper: NotebookPaperT, failWrite: boolean, writeDelay: number, readGate?: Promise<void> } = {
    paper: 'ruled', failWrite: false, writeDelay: 0,
  }
  await page.route(/\/v1\/notebook(\?.*)?$/, async route => {
    const day = new URL(route.request().url()).searchParams.get('day') ?? pageDay
    await settings.readGate
    await route.fulfill({ json: {
      day, days: Object.keys(entries).filter(day => entries[day]!.length).sort().reverse(),
      entries: entries[day] ?? [], pen, penPending: false, paper: settings.paper,
    } })
  })
  await page.route('**/v1/notebook/write', async route => {
    const request = route.request().postDataJSON() as typeof writes[number]
    writes.push(request)
    if (settings.writeDelay) await new Promise(resolve => setTimeout(resolve, settings.writeDelay))
    if (settings.failWrite) {
      await route.fulfill({ status: 500, json: { error: 'notebook_unavailable' } })
      return
    }
    const current = entries[pageDay] ??= []
    const known = current.find(entry => entry.clientId === request.clientId)
    const entry = known ?? { ...row(100 + current.length, 'owner', request.body, pageDay), clientId: request.clientId }
    if (!known) current.push(entry)
    await route.fulfill({ json: { entry } })
  })
  await page.route('**/v1/notebook/strike', async route => {
    const request = route.request().postDataJSON() as typeof strikes[number]
    strikes.push(request)
    const entry = Object.values(entries).flat().find(entry => entry.id === request.id)!
    entry.struckAt = request.struck ? new Date(`${pageDay}T16:00:00`).getTime() : null
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/v1/notebook/paper', async route => {
    settings.paper = route.request().postDataJSON().paper
    await route.fulfill({ json: { paper: settings.paper } })
  })
  return { entries, writes, strikes, settings }
}

test.beforeEach(async ({ page, shim }) => {
  await shim.invoke('demo.seed', { daemonAlive: true })
  await page.clock.install({ time: new Date(`${pageDay}T15:00:00`) })
})

test('打开即聚焦，读取挂起和写响应延迟时仍立即落字，正文不进 console', async ({ page, shimUrl }) => {
  const { writes, settings } = await mockNotebook(page)
  const read = gate()
  settings.readGate = read.wait
  settings.writeDelay = 3000
  let leaked = false
  page.on('console', message => { leaked ||= message.text().includes(uniqueLine) })
  try {
    await page.goto(shimUrl)
    await clickNav(page, 'notebook')
    const input = page.locator(writeInput)
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('placeholder', '接着写…')
    await input.fill(uniqueLine)
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(input).toHaveValue(uniqueLine)
    await input.press('Shift+Enter')
    await input.press('1')
    await expect(input).toHaveCSS('height', '72px')

    const pending = page.waitForResponse('**/v1/notebook/write')
    let responded = false
    void pending.then(() => { responded = true })
    await input.press('Enter')
    await expect(page.locator('.notebook-text')).toHaveText(`${uniqueLine} 1`)
    expect(responded).toBe(false)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await pending
    expect(writes).toHaveLength(1)
    read.release()
    await expect(page.locator('.notebook-strike')).toHaveCount(1)
    expect(leaked).toBe(false)
  } finally {
    read.release()
  }
})

test('失败的字一直在纸上，五秒后才标记，三十秒重发使用同一个 clientId', async ({ page, shimUrl }) => {
  const { writes, settings, entries } = await mockNotebook(page)
  settings.failWrite = true
  let dialogs = 0
  page.on('dialog', async dialog => { dialogs++; await dialog.dismiss() })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  const failed = page.waitForResponse('**/v1/notebook/write')
  await page.locator(writeInput).fill('留在纸上的字')
  await page.locator(writeInput).press('Enter')
  expect((await failed).status()).toBe(500)
  await expect(page.locator('.notebook-entry')).toContainText('留在纸上的字')
  const pending = page.getByText('还没存上')
  await expect(pending).toHaveCount(0)
  await page.clock.fastForward(5400)
  await expect(pending).toBeVisible()
  expect(dialogs).toBe(0)

  settings.failWrite = false
  await page.clock.fastForward(30_000)
  await expect(pending).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect(writes[1]!.clientId).toBe(writes[0]!.clientId)
  expect(entries[pageDay]).toHaveLength(1)
  await expect(page.locator('.notebook-text')).toHaveText('留在纸上的字')
})

test('两个人的字落在同一行距，CC 落款可翻到旧页，翻页跳过空白日期', async ({ page, shimUrl }) => {
  const old = row(1, 'owner', '第一笔', october)
  await mockNotebook(page, {
    [october]: [old],
    [november]: [row(2, 'owner', '第二笔', november)],
    [pageDay]: [row(3, 'owner', '今天写的', pageDay), row(4, 'cc', '接着那天的想法写', pageDay, old.id)],
  })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  const owner = page.locator('.notebook-entry[data-author="owner"]')
  const cc = page.locator('.notebook-entry[data-author="cc"]')
  await expect(cc).toContainText('CC，下午')
  const first = await owner.locator('p').evaluate(el => {
    const { fontFamily, color } = getComputedStyle(el)
    return { fontFamily, color, x: el.getBoundingClientRect().x }
  })
  const second = await cc.locator('p').evaluate(el => {
    const { fontFamily, color } = getComputedStyle(el)
    return { fontFamily, color, x: el.getBoundingClientRect().x }
  })
  expect(second.fontFamily).toContain('Kaiti SC')
  expect(second.fontFamily).not.toBe(first.fontFamily)
  expect(second.color).not.toBe(first.color)
  expect(second.x - first.x).toBe(96)
  expect(await page.locator('.notebook-entry').evaluateAll(rows => rows.map(row => {
    const sheet = row.closest('.notebook-sheet')!
    return (row.getBoundingClientRect().top - sheet.getBoundingClientRect().top) % 36
  }))).toEqual([0, 0])

  await expect(page.getByRole('button', { name: '后一页' })).toBeDisabled()
  await page.getByRole('button', { name: '接着你 10 月 28 日那一条' }).click()
  await expect(page.getByText('第一笔', { exact: true })).toBeInViewport()
  await expect(page.locator('#notebook-date')).toHaveText('10 月 28 日')
  await expect(page.locator(writeInput)).toBeHidden()
  await expect(page.getByRole('button', { name: '前一页' })).toBeDisabled()
  await page.getByRole('button', { name: '后一页' }).click()
  await expect(page.locator('#notebook-date')).toHaveText('11 月 4 日')
  await expect(page.locator(writeInput)).toBeHidden()
  await page.getByRole('button', { name: '回到今天' }).click()
  await expect(page.locator(writeInput)).toBeFocused()
})

test('划掉和恢复只给主人，换纸由 daemon 保存，刷新时先画上次读的那天', async ({ page, shimUrl }) => {
  const old = row(1, 'owner', '上次翻的那一天', october)
  const { strikes, settings } = await mockNotebook(page, {
    [october]: [old, row(2, 'cc', '页边落款', october, old.id)],
  })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  await page.getByRole('button', { name: '前一页' }).click()
  const owner = page.locator('.notebook-entry[data-author="owner"]')
  const cc = page.locator('.notebook-entry[data-author="cc"]')
  await expect(cc.getByRole('button', { name: '接着你上面那一条' })).toBeVisible()
  await expect(cc.locator('.notebook-strike')).toHaveCount(0)
  const strike = owner.getByRole('button', { name: '划掉' })
  await expect(strike).toHaveCSS('opacity', '0')
  await strike.focus()
  await expect(strike).toHaveCSS('opacity', '1')
  await strike.press('Enter')
  await expect(owner.locator('p')).toHaveCSS('text-decoration-line', 'line-through')
  await owner.getByRole('button', { name: '恢复' }).click()
  await expect(owner.locator('p')).toHaveCSS('text-decoration-line', 'none')
  expect(strikes).toEqual([{ id: old.id, struck: true }, { id: old.id, struck: false }])

  const sheet = page.locator('.notebook-sheet')
  await expect(sheet).toHaveCSS('background-image', /repeating-linear-gradient/)
  await page.getByRole('button', { name: '换成白纸' }).click()
  await expect(sheet).toHaveCSS('background-image', 'none')
  const reading = gate()
  settings.readGate = reading.wait
  try {
    await page.reload()
    await clickNav(page, 'notebook')
    await expect(page.locator('#notebook-date')).toHaveText('10 月 28 日')
    await expect(owner).toContainText('上次翻的那一天')
    await expect(sheet).toHaveCSS('background-image', 'none')
    await expect(page.getByRole('button', { name: '换成横线' })).toBeVisible()
  } finally {
    reading.release()
  }
})

test('六十秒静静刷页，保留焦点和草稿，CC 等主人放下笔再出现', async ({ page, shimUrl }) => {
  const original = row(1, 'owner', '先写一笔', pageDay)
  const fillers = Array.from({ length: 18 }, (_, i) => row(i + 10, 'owner', `同一天的第 ${i + 2} 笔`, pageDay))
  const { entries } = await mockNotebook(page, { [pageDay]: [original, ...fillers] })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  await expect(page.locator('.notebook-text').first()).toHaveText(original.body)
  const input = page.locator(writeInput)
  await input.fill('正在想')
  const scroll = page.locator('.notebook-scroll')
  await scroll.evaluate(el => { el.scrollTop = 180 })
  entries[pageDay]!.push(row(50, 'cc', '后来添的一笔', pageDay))
  const updated = page.waitForResponse(/\/v1\/notebook\?day=/)
  await page.clock.fastForward(60_000)
  await updated
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').entries?.length, NOTEBOOK_CACHE_KEY))
    .toBe(fillers.length + 2)
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(180)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('正在想')
  await expect(page.locator('.notebook-entry[data-author="cc"]')).toHaveCount(0)
  await input.evaluate(el => {
    (el as HTMLTextAreaElement).value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.notebook-entry[data-author="cc"]')).toContainText('后来添的一笔')
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(180)
  await expect(input).toBeFocused()
})

for (const width of [1280, 800]) {
  test(`${width} 窗口里本子是记忆前面唯一的入口，页面与现有工作台对齐`, async ({ page, shimUrl }) => {
    await page.setViewportSize({ width, height: 820 })
    await mockNotebook(page)
    await page.goto(shimUrl)
    const rail = page.locator('#dash-global-rail')
    const entry = rail.getByRole('button', { name: '本子' })
    await expect(entry).toHaveCount(1)
    expect(await entry.evaluate(el => (el.nextElementSibling as HTMLElement)?.dataset.pane)).toBe('memory')
    await clickNav(page, 'notebook')
    await expect(entry).toHaveAttribute('aria-current', 'page')
    const panel = page.locator('#notebook-pane')
    await expect(panel).toBeVisible()
    await expect(page.locator('.cc-now-pane')).toBeHidden()
    const box = (await panel.boundingBox())!
    if (width === 1280) {
      await expect(rail.locator('.places-strip')).toBeVisible()
      expect(box.x).toBeGreaterThanOrEqual(304)
    } else {
      const topbar = (await rail.boundingBox())!
      expect(box.x).toBe(0)
      expect(box.width).toBe(800)
      expect(topbar.y + topbar.height).toBeLessThanOrEqual(box.y)
    }
  })
}
