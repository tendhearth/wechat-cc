import type { Page } from '@playwright/test'
import type { NotebookEntryT, NotebookPaperT, NotebookPenT } from '@wechat-cc/protocol'
import { test, expect, clickNav } from './fixtures'
import { NOTEBOOK_CACHE_KEY } from '../src/modules/notebook-state.js'

const october = '2026-10-28'
const november = '2026-11-04'
const pageDay = '2026-11-19'
const followingDay = '2026-11-20'
const writeInput = '#notebook-write'
const uniqueLine = 'notebook-private-71c6'
const pen: NotebookPenT = { font: 'kai', ink: 'blueBlack', reason: '慢一点写' }

function row(id: number, author: NotebookEntryT['author'], body: string, date: string, refId: string | null = null, refDay?: string): NotebookEntryT {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, author, body,
    createdAt: new Date(`${date}T15:00:00`).getTime() + id, refId,
    day: date, refDay, struckAt: null, clientId: null, origin: 'desktop',
  }
}

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function mockNotebook(page: Page, initial: Record<string, NotebookEntryT[]> = {}, pagePen = pen) {
  const entries = structuredClone(initial)
  const writes: { body: string, clientId: string }[] = []
  const reads: URLSearchParams[] = []
  const strikes: { id: string, struck: boolean }[] = []
  const settings: { paper: NotebookPaperT, failWrite: boolean, writeDelay: number, today: string, writeDay?: string, readGate?: Promise<void> } = {
    paper: 'ruled', failWrite: false, writeDelay: 0, today: pageDay,
  }
  await page.route(/\/v1\/notebook(\?.*)?$/, async route => {
    const query = new URL(route.request().url()).searchParams
    reads.push(query)
    const day = query.get('day') ?? settings.today
    await settings.readGate
    await route.fulfill({ json: {
      day, today: settings.today, days: Object.keys(entries).filter(day => entries[day]!.length).sort().reverse(),
      entries: entries[day] ?? [], pen: pagePen, penPending: false, paper: settings.paper,
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
    const writeDay = settings.writeDay ?? settings.today
    const current = entries[writeDay] ??= []
    const known = Object.values(entries).flat().find(entry => entry.clientId === request.clientId)
    // Keep the simulated browser timestamp independent of the daemon's day.
    const entry = known ?? { ...row(100 + current.length, 'owner', request.body, pageDay), day: writeDay, clientId: request.clientId }
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
  return { entries, reads, writes, strikes, settings }
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
  const { reads } = await mockNotebook(page, {
    [october]: [old],
    [november]: [row(2, 'owner', '第二笔', november)],
    [pageDay]: [row(3, 'owner', '今天写的', pageDay), row(4, 'cc', '接着那天的想法写', pageDay, old.id, october)],
  })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  const owner = page.locator('.notebook-entry[data-author="owner"]')
  const cc = page.locator('.notebook-entry[data-author="cc"]')
  await expect(cc).toContainText('CC，下午')
  const first = await owner.locator('p').evaluate(el => {
    return el.getBoundingClientRect().x
  })
  const second = await cc.locator('p').evaluate(el => {
    return el.getBoundingClientRect().x
  })
  expect(second - first).toBe(96)
  expect(reads.map(query => query.get('day'))).toEqual([pageDay])
  expect(await page.locator('.notebook-entry').evaluateAll(rows => rows.map(row => {
    const sheet = row.closest('.notebook-sheet')!
    return (row.getBoundingClientRect().top - sheet.getBoundingClientRect().top) % 36
  }))).toEqual([0, 0])

  await expect(page.getByRole('button', { name: '后一页' })).toBeDisabled()
  // 这个按钮是界面的字,不跟着 CC 的笔走:不斜,字体和主人那一列一样。
  const refButton = page.getByRole('button', { name: '接着你 10 月 28 日那一条' })
  await expect(refButton).toHaveCSS('font-style', 'normal')
  expect(await refButton.evaluate(node => getComputedStyle(node).fontFamily))
    .toBe(await page.locator('#notebook-write').evaluate(node => getComputedStyle(node).fontFamily))
  await refButton.click()
  await expect(page.getByText('第一笔', { exact: true })).toBeInViewport()
  await expect.poll(() => reads.map(query => query.get('day'))).toEqual([pageDay, october])
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
    [october]: [old, row(2, 'cc', '页边落款', october, old.id, october)],
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

for (const [font, family] of [
  ['kai', 'TH Pen Kai'], ['hand', 'TH Pen Hand'], ['fangsong', 'TH Pen Fangsong'], ['songItalic', null],
] as const) {
  test(`CC 用 ${font} 写字，桌面报全四支笔`, async ({ page, shimUrl }) => {
    const { reads } = await mockNotebook(page, {
      [pageDay]: [row(1, 'owner', '主人写字', pageDay), row(2, 'cc', 'CC 写字', pageDay)],
    }, { ...pen, font })
    await page.goto(shimUrl)
    await clickNav(page, 'notebook')
    const style = (author: string) => page.locator(`[data-author="${author}"] .notebook-text`).evaluate(el => {
      const { fontFamily, fontStyle, color } = getComputedStyle(el)
      return { fontFamily, fontStyle, color }
    })
    const owner = await style('owner')
    const cc = await style('cc')
    expect(reads[0]?.get('fonts')?.split(',')).toEqual(['kai', 'hand', 'fangsong', 'songItalic'])
    if (family) {
      expect(cc.fontFamily.replace(/^"/, '').startsWith(family)).toBe(true)
      expect(cc.fontStyle).toBe('normal')
      expect(await page.evaluate(name => document.fonts.check(`400 19px "${name}"`, '写字')
        && [...document.fonts].some(face => face.family.replaceAll('"', '') === name && face.status === 'loaded'), family)).toBe(true)
      await expect(page.locator('[data-author="cc"] .notebook-meta')).toHaveCSS('font-family', cc.fontFamily)
    } else {
      expect(cc.fontFamily).toBe(owner.fontFamily)
      expect(cc.fontStyle).toBe('italic')
    }
    expect([cc.fontFamily, cc.fontStyle]).not.toEqual([owner.fontFamily, owner.fontStyle])
    expect(cc.color).not.toBe(owner.color)
  })
}

test('缓存里的 CC 字等随包字体加载，失败后直接画成宋体斜', async ({ page, shimUrl }) => {
  const font = gate()
  const cc = row(2, 'cc', '缓存中的 CC 字', pageDay)
  await page.addInitScript(({ key, entry, pagePen }) => {
    localStorage.setItem(key, JSON.stringify({
      day: entry.day, today: entry.day, days: [entry.day], entries: [entry], pen: pagePen, paper: 'ruled',
    }))
  }, { key: NOTEBOOK_CACHE_KEY, entry: cc, pagePen: pen })
  await mockNotebook(page, { [pageDay]: [cc] })
  await page.route('**/th-pen-kai.woff2', async route => {
    await font.wait
    await route.abort()
  })
  const request = page.waitForRequest('**/th-pen-kai.woff2')
  try {
    await page.goto(shimUrl)
    await clickNav(page, 'notebook')
    await request
    await expect(page.locator(writeInput)).toBeFocused()
    await expect(page.getByText(cc.body)).toHaveCount(0)
  } finally {
    font.release()
  }
  await expect(page.getByText(cc.body)).toHaveCSS('font-style', 'italic')
  await expect(page.getByText(cc.body)).toHaveCSS('font-family', await page.locator(writeInput).evaluate(el => getComputedStyle(el).fontFamily))
})

test('静静取页跟着 daemon 跨午夜，保留草稿和焦点，补写按回执挪页', async ({ page, shimUrl }) => {
  const { reads, settings } = await mockNotebook(page, {
    [pageDay]: [row(1, 'owner', '旧页原有的一笔', pageDay)],
    [followingDay]: [row(2, 'owner', '新页原有的一笔', followingDay)],
  })
  settings.failWrite = true
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  const input = page.locator(writeInput)
  await expect(page.getByText('旧页原有的一笔')).toBeVisible()
  const failure = page.waitForResponse('**/v1/notebook/write')
  await input.fill('跨午夜补送的一笔')
  await input.press('Enter')
  expect((await failure).status()).toBe(500)
  await expect(page.getByText('跨午夜补送的一笔')).toBeVisible()
  await input.fill('跨午夜还在写的草稿')
  settings.today = followingDay
  await page.clock.fastForward(60_000)
  await expect(page.getByText('新页原有的一笔')).toBeVisible()
  expect(reads.map(query => query.get('day'))).toEqual([pageDay, pageDay, followingDay])
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('跨午夜还在写的草稿')
  await expect(page.locator('#notebook-date')).toHaveText('今天')
  await expect(page.getByText('跨午夜补送的一笔')).toHaveCount(0)
  await page.getByRole('button', { name: '前一页' }).click()
  await expect(input).toBeHidden()
  await expect(page.getByText('跨午夜补送的一笔')).toBeVisible()
  settings.failWrite = false
  await page.clock.fastForward(30_000)
  await expect(page.getByText('跨午夜补送的一笔')).toHaveCount(0)
  await page.getByRole('button', { name: '回到今天' }).click()
  await expect(page.getByText('跨午夜补送的一笔')).toHaveCount(1)
  await expect(input).toHaveValue('跨午夜还在写的草稿')
})

test('同日同一时段的连续 CC 留言只在末条落款，引用各自保留', async ({ page, shimUrl }) => {
  const old = row(1, 'owner', '旧页文字', october)
  const owner = row(4, 'owner', '主人夹写的一笔', pageDay)
  await mockNotebook(page, {
    [october]: [old],
    [pageDay]: [
      row(2, 'cc', '连续第一条', pageDay, old.id, october),
      row(3, 'cc', '连续第二条', pageDay, old.id, october),
      owner,
      row(5, 'cc', '主人写过后的留言', pageDay, owner.id, pageDay),
      { ...row(6, 'cc', '换时段后的留言', pageDay, old.id), createdAt: new Date(`${pageDay}T18:00:00`).getTime() },
    ],
  })
  await page.goto(shimUrl)
  await clickNav(page, 'notebook')
  const cc = page.locator('[data-author="cc"]')
  await expect(cc).toHaveCount(4)
  await expect(cc.nth(0).getByText('CC，下午')).toHaveCount(0)
  await expect(cc.nth(1).getByText('CC，下午')).toBeVisible()
  await expect(cc.nth(2).getByText('CC，下午')).toBeVisible()
  await expect(cc.nth(3).getByText('CC，傍晚')).toBeVisible()
  for (const index of [0, 1]) {
    await expect(cc.nth(index).getByRole('button', { name: '接着你 10 月 28 日那一条' })).toBeVisible()
  }
  await expect(cc.nth(2).getByRole('button', { name: '接着你上面那一条' })).toBeVisible()
  await expect(cc.nth(3).getByRole('button')).toHaveCount(0)
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
      expect(box.x).toBeGreaterThanOrEqual(284)
    } else {
      const topbar = (await rail.boundingBox())!
      expect(box.x).toBe(0)
      expect(box.width).toBe(800)
      expect(topbar.y + topbar.height).toBeLessThanOrEqual(box.y)
    }
  })
}

const mailPath = '**/v1/notebook/unseen'
const mailName = '本子上有 CC 的回信'
const mailDot = '#desk-notebook-dot'
const emptyMail = { ok: true, unseen: false, day: null }

for (const via of ['信封', '本子行'] as const) {
  test(`点${via}翻到回信那天，读回来以后信封和小点消失`, async ({ page, shimUrl }) => {
    await page.setViewportSize({ width: 1280, height: 820 })
    const owner = row(901, 'owner', 'fixture', october)
    const reply = row(902, 'cc', 'fixture', october, owner.id)
    const { reads, settings } = await mockNotebook(page, { [october]: [owner, reply] })
    const read = gate()
    settings.readGate = read.wait
    await page.route(mailPath, route => route.fulfill({ json: reads.some(q => q.get('day') === october)
      ? emptyMail : { ok: true, unseen: true, day: october } }))
    try {
      await page.goto(shimUrl)
      await expect(page.locator('#dash-global-rail')).toBeVisible()
      const envelope = page.getByRole('button', { name: mailName, exact: true })
      const notebook = page.getByRole('button', { name: '本子，有回信', exact: true })
      await expect(envelope).toBeVisible()
      await expect(envelope).toHaveAttribute('title', mailName)
      await expect(envelope.locator('img')).toHaveCSS('width', '22px')
      await expect(page.locator(mailDot)).toBeVisible()
      await page.locator('#topbar-cc').focus()
      await page.keyboard.press('Tab')
      await expect(envelope).toBeFocused()
      if (via === '信封') await page.keyboard.press('Enter')
      else await notebook.click()
      await expect(page.locator('#notebook-date')).toHaveText('10 月 28 日')
      await expect.poll(() => reads.map(q => q.get('day'))).toEqual([october])
      await expect(envelope).toBeVisible()
      read.release()
      await expect(envelope).toBeHidden()
      await expect(page.locator(mailDot)).toBeHidden()
      await expect(page.getByRole('button', { name: '本子', exact: true })).toBeVisible()
    } finally {
      read.release()
    }
  })
}

test('宽窗口没有回信就不摆信，写成功后每 20 秒查一次', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await mockNotebook(page)
  let checks = 0
  await page.route(mailPath, route => {
    checks++
    return route.fulfill({ json: emptyMail })
  })
  await page.goto(shimUrl)
  await expect(page.locator('#dash-global-rail')).toBeVisible()
  await clickNav(page, 'notebook')
  await expect.poll(() => checks).toBeGreaterThanOrEqual(2)
  await expect(page.locator('#desk-notebook-envelope')).toBeHidden()
  await expect(page.locator(mailDot)).toBeHidden()
  const saved = page.waitForResponse('**/v1/notebook/write')
  await page.locator(writeInput).fill('fixture')
  await page.locator(writeInput).press('Enter')
  expect((await saved).ok()).toBe(true)
  await expect(page.locator('.notebook-strike')).toBeVisible()
  const before = checks
  await page.clock.fastForward(20_100)
  await expect.poll(() => checks).toBe(before + 1)
  await page.clock.fastForward(20_000)
  await expect.poll(() => checks).toBe(before + 2)
})

for (const [surface, width, alive] of [['窄窗口', 760, true], ['CC 停止的宽窗口', 1280, false]] as const) {
  test(`${surface}没有信，也不查回信`, async ({ page, shim, shimUrl }) => {
    await shim.invoke('demo.seed', { daemonAlive: alive })
    await page.setViewportSize({ width, height: 820 })
    await mockNotebook(page)
    let checks = 0
    await page.route(mailPath, route => {
      checks++
      return route.fulfill({ json: { ok: true, unseen: true, day: october } })
    })
    await page.goto(shimUrl)
    await expect(page.locator('#dash-global-rail')).toBeVisible()
    if (!alive) await expect(page.locator('#desk-cc-presence')).toHaveText('CC 没在运行')
    await clickNav(page, 'notebook')
    await expect(page.locator('#notebook-date')).toHaveText('今天')
    await page.clock.fastForward(61_000)
    await expect(page.locator('#desk-notebook-envelope')).toBeHidden()
    await expect(page.locator(mailDot)).toBeHidden()
    expect(checks).toBe(0)
  })
}
