import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:4213'
const source = new URL('../src/', import.meta.url)
const hostile = '<script>window.approvalInjected=1</script><img src=x onerror="window.approvalInjected=2">\' "'
const command = `npm install sharp\n${hostile}\n${Array.from({ length: 8 }, (_, i) => `echo example-${i}`).join('\n')}`
const snapshotNotice = '预览是批准时的快照，运行以当时内容为准。允许仅限本请求、本轮和这一次调用；脚本及运行时依赖可能变化。'
const completeSource = `command=${command}\necho original-tail\r\n\n${snapshotNotice}`
const cwd = '/demo/portfolio'
const task = { id: 'A', title: '画作品集', path: cwd, providerId: 'claude', status: 'running', createdAt: 1, updatedAt: 2, error: null }
const note = '校对示例后继续 ' + hostile
const whitespaceNotice = '这处改动只在换行或空白上有差别，这里看不出来。'
const edit = { note, body: { kind: 'edit', path: cwd + '/src/a.ts', changes: [
  { before: 'const a = 1', after: 'const a = 2\n' + hostile },
  { before: 'const b = 3\n', after: 'const b = 3' },
] } }
const editSource = 'input=' + JSON.stringify(edit.body)
const data = {
  task, version: 1, runId: 'run-A', events: [], artifacts: [], questions: [],
  permissions: [
    { id: 'p1', taskId: 'A', tool: 'Bash', description: 'legacy command', cwd, display: { body: { kind: 'command', command } }, createdAt: 1 },
    { id: 'p2', taskId: 'A', tool: 'Edit', description: editSource, cwd, display: edit, createdAt: 1 },
    { id: 'p3', taskId: 'A', tool: 'Bash', description: completeSource, cwd, display: { body: { kind: 'command', command: command.replace('sharp', 'sharp\r') }, truncated: true },
      showSnapshotNotice: true, scripts: [{ path: 'sample.ts', content: 'export {}' }], createdAt: 1 },
  ],
}

const layoutPermission = {
  ...data.permissions[0],
  description: [command, ...Array.from({ length: 48 }, (_, i) => `echo original-${i}`)].join('\n'),
  display: { body: { kind: 'command', command }, note: '核对生成的文件后继续。' },
  showSnapshotNotice: true,
  canDenyWithReason: true,
  canAllowTask: true,
}
const layoutDetail = {
  ...data, inputMode: 'steer', permissions: [],
  events: Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`, taskId: task.id, kind: 'text', text: `第 ${i + 1} 段回复。继续检查交付文件。`, createdAt: i + 1,
  })),
}
const taskScript = (layout: boolean) => `
import { initWorkbenchPage } from '/modules/workbench.js'
const detail = ${JSON.stringify(layout ? layoutDetail : data)}
const controller = initWorkbenchPage({
  pollMs: 60000,
  async invokeWorkbenchApi(method, path) {
    if (path.startsWith('/v1/workbench/task?')) {
      return path.includes('since=') ? new Promise(() => {}) : detail
    }
    if (path.startsWith('/v1/matter/changes?')) return { reviews: [] }
    if (path.startsWith('/v1/matters?')) return { matters: [] }
    if (method === 'POST') return { ok: true }
    return { tasks: [detail.task], projects: [], providers: [{ id: 'claude', displayName: 'Claude' }], defaultProvider: 'claude', canWechat: false }
  },
})
${layout ? `window.setFixturePermissions = count => {
  const request = ${JSON.stringify(layoutPermission)}
  controller.state.detail.permissions = Array.from({ length: count }, (_, i) => ({ ...request, id: 'p' + (i + 1) }))
  controller.paint(true)
}` : ''}
`
const terminalScript = `
import { mountNowPage } from '/modules/now-page.js'
import { terminalWaitingRows } from '/modules/terminal-waiting.js'
const root = document.querySelector('.cc-now-pane')
const page = mountNowPage({
  root, presencePoller: { subscribe: () => () => {} }, onOpenTask: () => {},
  onResolveTerminal: async () => true,
})
page.setTerminal(terminalWaitingRows([{
  session_id: 'fixture-edit', source: 'claude', displayName: 'Claude', status: 'waiting', project: 'portfolio',
  pending: { tool: 'Edit', summary: 'src/a.ts…', hash: 'ed1t1', truncated: true, cwd: ${JSON.stringify(cwd)}, display: ${JSON.stringify(edit)} },
}, {
  session_id: 'fixture-summary', source: 'claude', displayName: 'Claude', status: 'waiting', project: 'portfolio',
  pending: { tool: 'Bash', summary: 'echo sample', hash: 'leg01', truncated: false },
}, {
  session_id: 'fixture-partial', source: 'claude', displayName: 'Claude', status: 'waiting', project: 'portfolio',
  pending: { tool: 'Bash', summary: 'partial…', hash: 'cut01', truncated: true,
    display: ${JSON.stringify({ body: { kind: 'command', command }, truncated: true })} },
}]))
`
const terminalMarkup = `<article class="cc-now-pane" data-now="home">
  <button id="now-cc">CC</button>
  <section id="now-waiting" hidden><h2 id="now-waiting-title"></h2><ul id="now-waiting-list"></ul></section>
</article>`
const taskMarkup = '<main class="dashboard"><div class="dash-main"><div class="thing-detail"><section class="workbench-pane" data-docked><div id="workbench-root"></div></section></div></div></main>'
function layoutMarkup(wide: boolean) {
  const workbench = `<section class="dash-pane workbench-pane" data-workbench-view="detail">
    <header class="cc-life-topline"><button type="button" class="workbench-home">返回对话</button></header>
    <div id="workbench-root" class="workbench-root"></div></section>`
  return `<main class="dashboard"><div class="dash-window"><div class="dash-main">${wide
    ? `<section class="dash-pane thing-thread"><header class="thing-heading">画作品集</header><div class="thing-detail">${workbench}</div></section>`
    : workbench}</div></div></main>`
}

async function openFixture(page: Page, { wide = false, terminal = false, layout = false } = {}) {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', () => { document.documentElement.dataset.cspViolation = 'true' })
  })
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      const styles = ['tokens.css', 'fonts.css', 'styles.css', 'shared/agent-avatars.css', 'cc-now.css',
        ...(layout ? ['styles/converse.css'] : []), 'styles/workbench.css', 'styles/desk-two-pane.css']
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'" },
        body: `<!doctype html><html lang="zh"${wide ? ' data-desk-wide' : ''}${layout ? ' data-mode="dashboard"' : ''}><head><meta charset="utf-8">
          ${styles.map(css => `<link rel="stylesheet" href="/${css}">`).join('')}
          ${layout ? '' : '<style>html, body, .dashboard, .dash-main, .thing-detail, .workbench-pane, #workbench-root { height: 100%; margin: 0; }</style>'}
          </head><body>${terminal ? terminalMarkup : layout ? layoutMarkup(wide) : taskMarkup}<script type="module" src="/fixture.js"></script></body></html>`,
      })
    } else if (path === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: terminal ? terminalScript : taskScript(layout) })
    } else {
      try {
        const body = await readFile(new URL(path.slice(1), source))
        const contentType = /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'
        await route.fulfill({ body, contentType })
      } catch {
        await route.fulfill({ status: 404, body: 'missing fixture asset' })
      }
    }
  })
  await page.goto(origin)
}

for (const width of [1440, 760]) {
  test(`task permissions show a command and an edit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openFixture(page, { wide: width === 1440 })
    const cards = page.locator('.wb-permission')
    await expect(cards).toHaveCount(3)
    const commandPanel = cards.first().locator('[data-kind="command"]')
    await expect(cards.first().locator('.wb-permission-tool')).toHaveText('Claude 想运行一条命令')
    await expect(commandPanel.locator('.approval-command > span')).toHaveText('$')
    await expect(commandPanel.locator('.approval-source').first()).toHaveCSS('white-space', 'pre-wrap')
    await commandPanel.getByText('还有 2 行 · 看全部', { exact: true }).click()
    await expect(commandPanel.getByText('echo example-7', { exact: false })).toBeVisible()
    const original = cards.first().getByText('看完整原文', { exact: true })
    await original.click()
    await expect(cards.first().getByText('legacy command', { exact: true })).toBeVisible()
    await original.click()

    const editPanel = cards.nth(1).locator('[data-kind="edit"]')
    await editPanel.scrollIntoViewIfNeeded()
    await expect(editPanel.locator('.approval-path')).toHaveText('src/a.ts')
    await expect(editPanel.locator('[data-line="deleted"]').first()).toHaveText('− const a = 1')
    await expect(editPanel.locator('[data-line="added"]').first()).toHaveText('+ const a = 2')
    const reason = cards.nth(1).locator('.approval-operation > .approval-meta:first-child')
    await expect(reason).toBeVisible()
    expect(await reason.textContent() === note).toBe(true)
    await expect(cards.nth(1).getByText('在 /demo/portfolio', { exact: true })).toBeVisible()
    await expect(editPanel.getByText(whitespaceNotice, { exact: true })).toBeVisible()
    await expect(editPanel.getByText('这一段的末尾少了一个换行。', { exact: true })).toBeVisible()
    const editOriginal = cards.nth(1).getByText('看完整原文', { exact: true })
    await editOriginal.click()
    expect(await cards.nth(1).locator('.approval-operation > details .approval-source').textContent() === editSource).toBe(true)
    await editOriginal.click()
    const truncated = cards.nth(2)
    const notice = truncated.locator('.wb-permission-snapshot')
    await notice.scrollIntoViewIfNeeded()
    await expect(notice).toBeVisible()
    await expect(notice).toHaveText(snapshotNotice)
    await expect(truncated.getByText('这里不是全部内容，完整的在下面『看完整原文』里。', { exact: true })).toBeVisible()
    await expect(truncated.locator('.approval-operation .approval-invisible-notice').first()).toBeVisible()
    await expect(truncated.locator('.approval-panel .approval-invisible')).toHaveAttribute('aria-label', '不可见字符 \\r')
    const fullOriginal = truncated.getByText('看完整原文', { exact: true })
    await expect(fullOriginal).toBeVisible()
    await fullOriginal.click()
    const fullSource = truncated.locator('.approval-operation > details .approval-source')
    await expect(fullSource).toBeVisible()
    await expect(fullSource.locator('.approval-invisible')).toBeVisible()
    expect(await fullSource.textContent() === completeSource.replace('\r', '\\r')).toBe(true)
    await expect(cards.locator('script, img, [onerror]')).toHaveCount(0)
    expect(await page.evaluate(() => 'approvalInjected' in window)).toBe(false)
    expect(await editPanel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(page.locator('html')).not.toHaveAttribute('data-csp-violation', 'true')
  })
}

const setPermissionCount = (page: Page, count: number) => page.evaluate(count => {
  (window as typeof window & { setFixturePermissions: (count: number) => void }).setFixturePermissions(count)
}, count)

async function expectDecisionButtons(card: Locator) {
  for (const name of ['拒绝', '允许']) {
    const button = card.getByRole('button', { name, exact: true })
    await expect(button).toBeInViewport({ ratio: 1 })
    // Verify hit-testing without letting Playwright scroll the button into view first.
    expect(await button.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2))
    })).toBe(true)
  }
}

async function expectFirstThreeCommandLines(card: Locator) {
  const source = card.locator('.approval-command .approval-source').first()
  const visible = await source.evaluate(el => {
    const text = el.firstChild
    if (!(text instanceof Text)) return []
    const panel = el.closest('.wb-permissions')!.getBoundingClientRect()
    const actions = el.closest('.wb-permission')!.querySelector('.wb-permission-actions')!.getBoundingClientRect()
    const range = document.createRange()
    let start = 0
    return text.data.split('\n').slice(0, 3).map(line => {
      range.setStart(text, start)
      range.setEnd(text, start + line.length)
      start += line.length + 1
      const rects = Array.from(range.getClientRects())
      return rects.length > 0 && rects.every(rect =>
        rect.top >= Math.max(0, panel.top) &&
        rect.bottom <= Math.min(window.innerHeight, panel.bottom, actions.top) &&
        rect.left >= Math.max(0, panel.left) &&
        rect.right <= Math.min(window.innerWidth, panel.right))
    })
  })
  expect(visible).toEqual([true, true, true])
}

for (const [width, height] of [[1440, 900], [1280, 800], [900, 650], [760, 600]] as const) {
  test(`task detail gives permissions room at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await openFixture(page, { wide: width >= 900, layout: true })
    const composer = page.locator('.wb-followup')
    const field = composer.getByRole('textbox')
    const content = page.locator('.wb-content')
    const panel = page.locator('.wb-permissions')
    const request = panel.locator('.wb-permission')
    await expect(composer).toBeInViewport({ ratio: 1 })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const fullConversationHeight = await content.evaluate(el => el.getBoundingClientRect().height)
    const normalComposerHeight = (await composer.boundingBox())!.height
    const normalFieldHeight = (await field.boundingBox())!.height
    const normalFontSize = await field.evaluate(el => getComputedStyle(el).fontSize)
    // In the normal layout the conversation fills the space between the header and controls.
    const normalGap = await page.locator('.wb-main').evaluate(main => {
      const header = main.querySelector('.wb-task-head')!.getBoundingClientRect()
      const controls = main.querySelector('.wb-controls')!.getBoundingClientRect()
      return controls.top - header.bottom
    })
    expect(fullConversationHeight).toBeCloseTo(normalGap, 0)

    await setPermissionCount(page, 1)
    await expect(panel.locator('header > span')).toHaveText('1 项')
    await expect(panel).toHaveCSS('max-height', 'none')
    await expect(composer).toBeInViewport({ ratio: 1 })
    await expectDecisionButtons(request)
    const conversationBox = (await content.boundingBox())!
    const panelBox = (await panel.boundingBox())!
    const composerBox = (await composer.boundingBox())!
    if (height < 700) expect(conversationBox.height).toBe(0)
    else expect(conversationBox.height).toBeGreaterThanOrEqual(48)
    expect(conversationBox.height).toBeLessThan(fullConversationHeight)
    expect(conversationBox.y + conversationBox.height).toBeLessThanOrEqual(panelBox.y + 1)
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(composerBox.y + 1)
    expect(panelBox.height).toBeGreaterThan(conversationBox.height)
    if (height >= 800) expect(panelBox.height).toBeGreaterThan(300)
    expect(await content.evaluate(el => {
      el.scrollTop = 0
      el.scrollTop = 80
      return el.scrollTop
    })).toBe(80)

    if (width === 760 && height === 600) {
      await expect(panel.getByRole('heading', { name: '需要你的决定' })).toBeInViewport({ ratio: 1 })
      const operation = request.locator('.wb-permission-tool')
      await expect(operation).toHaveText('Claude 想运行一条命令')
      await expect(operation).toBeInViewport({ ratio: 1 })
      await expectFirstThreeCommandLines(request)
      expect(composerBox.height).toBeLessThanOrEqual(96)
      await expect(field).toBeInViewport({ ratio: 1 })
      await expect(field).toHaveCSS('font-size', normalFontSize)
      const singleLineHeight = await field.evaluate(el => {
        const style = getComputedStyle(el)
        return parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      })
      expect((await field.boundingBox())!.height).toBeCloseTo(singleLineHeight, 0)

      const attach = (await composer.getByRole('button', { name: /添加附件/ }).boundingBox())!
      const help = (await composer.getByText('补充说明', { exact: true }).boundingBox())!
      const send = (await composer.getByRole('button', { name: '发送补充' }).boundingBox())!
      const allowTask = request.getByRole('button', { name: '本任务同命令都允许', exact: true })
      expect(attach.y + attach.height / 2).toBeCloseTo(send.y + send.height / 2, 0)
      expect(help.y + help.height / 2).toBeCloseTo(send.y + send.height / 2, 0)

      await field.click()
      await expect(field).toBeFocused()
      expect((await field.boundingBox())!.height).toBeCloseTo(normalFieldHeight, 0)
      await field.pressSequentially('draft')
      await expect(field).toBeInViewport({ ratio: 1 })
      await expect(composer).toBeInViewport({ ratio: 1 })
      await expectDecisionButtons(request)
      await expect(allowTask).toBeInViewport({ ratio: 1 })
      await field.blur()
      await expect(field).toHaveValue('draft')
      expect((await field.boundingBox())!.height).toBeCloseTo(singleLineHeight, 0)
      await expect(field).toBeInViewport({ ratio: 1 })
      await expect(composer).toBeInViewport({ ratio: 1 })
      await expectFirstThreeCommandLines(request)
      await expectDecisionButtons(request)
      await expect(allowTask).toBeInViewport({ ratio: 1 })
      await field.fill('')
      await field.blur()
      expect((await composer.boundingBox())!.height).toBeCloseTo(composerBox.height, 0)
    }

    // Expand the ten-line preview and a much longer original at the top of the scrollport.
    const allLines = request.getByText('还有 2 行 · 看全部', { exact: true })
    await allLines.evaluate(el => el.parentElement!.setAttribute('open', ''))
    await expect(request.locator('.approval-command').getByText('echo example-7', { exact: false })).toBeVisible()
    await request.getByText('看完整原文', { exact: true }).evaluate(el => el.parentElement!.setAttribute('open', ''))
    await panel.evaluate(el => { el.scrollTop = 0 })
    await expectDecisionButtons(request)
    expect(await panel.evaluate(el => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
      return el.scrollTop
    })).toBeGreaterThan(0)
    await expectDecisionButtons(request)
    await expect(composer).toBeInViewport({ ratio: 1 })

    await setPermissionCount(page, 0)
    await expect(panel).toHaveCount(0)
    expect(await content.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(fullConversationHeight, 0)
    await expect(composer).toBeInViewport({ ratio: 1 })
    expect((await composer.boundingBox())!.height).toBeCloseTo(normalComposerHeight, 0)
    expect((await field.boundingBox())!.height).toBeCloseTo(normalFieldHeight, 0)
  })
}

test('sticky permission actions reach the bottom of the approval area', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 600 })
  await openFixture(page, { layout: true })
  await expect(page.locator('.wb-followup')).toBeVisible()
  await setPermissionCount(page, 1)
  const panel = page.locator('.wb-permissions')
  const request = panel.locator('.wb-permission')
  await request.getByText('看完整原文', { exact: true }).evaluate(el => el.parentElement!.setAttribute('open', ''))
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  expect(await panel.evaluate(el => {
    const maxScroll = el.scrollHeight - el.clientHeight
    el.scrollTop = maxScroll / 2
    return el.scrollTop > 0 && el.scrollTop < maxScroll
  })).toBe(true)
  await expectDecisionButtons(request)
  const actions = request.locator('.wb-permission-actions')
  const dividerWidth = () => actions.evaluate(el => getComputedStyle(el, '::before').borderTopWidth)
  await expect.poll(dividerWidth).toBe('1px')
  const { edgeGap, commandBelow } = await actions.evaluate(el => {
    const panel = el.closest('.wb-permissions')!.getBoundingClientRect()
    const actions = el.getBoundingClientRect()
    const visibleBottom = Math.min(panel.bottom, window.innerHeight)
    const probeY = actions.bottom + 2
    const hit = probeY < visibleBottom ? document.elementFromPoint(actions.left + actions.width / 2, probeY) : null
    return {
      edgeGap: Math.abs(visibleBottom - actions.bottom),
      commandBelow: !!hit?.closest('.approval-source, .approval-command'),
    }
  })
  expect(edgeGap).toBeLessThanOrEqual(1)
  expect(commandBelow).toBe(false)
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect.poll(dividerWidth).toBe('0px')
})

test('permission buttons stay with their own request as the list scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 600 })
  await openFixture(page, { layout: true })
  await expect(page.locator('.wb-followup')).toBeVisible()
  await setPermissionCount(page, 2)
  const panel = page.locator('.wb-permissions')
  const cards = panel.locator('.wb-permission')
  await expect(panel.locator('header > span')).toHaveText('2 项')
  await expect(cards.nth(1)).toHaveCSS('border-top-width', '1px')
  for (const card of await cards.all()) {
    await card.getByText('看完整原文', { exact: true }).evaluate(el => el.parentElement!.setAttribute('open', ''))
  }
  await panel.evaluate(el => { el.scrollTop = 0 })
  await expectDecisionButtons(cards.first())
  await expect(cards.nth(1).locator('.wb-permission-actions')).not.toBeInViewport()
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expectDecisionButtons(cards.nth(1))
  await expect(cards.first().locator('.wb-permission-actions')).not.toBeInViewport()
  await expect(page.locator('.wb-followup')).toBeInViewport({ ratio: 1 })
})

test('terminal waiting row opens its structured edit under the desktop CSP', async ({ page }) => {
  await openFixture(page, { terminal: true })
  const row = page.locator('.now-terminal[data-hash="ed1t1"] button')
  await expect(row).toHaveCount(1)
  await row.click()
  const dialog = page.locator('dialog.now-terminal-dialog')
  await expect(dialog.getByRole('heading')).toHaveText('想改 src/a.ts…')
  await expect(dialog.locator('[data-line="deleted"]').first()).toHaveText('− const a = 1')
  await expect(dialog.locator('[data-line="added"]').first()).toHaveText('+ const a = 2')
  const reason = dialog.locator('.approval-operation > .approval-meta:first-child')
  await expect(reason).toBeVisible()
  expect(await reason.textContent() === note).toBe(true)
  await expect(dialog.getByText('在 /demo/portfolio', { exact: true })).toBeVisible()
  await expect(dialog.getByText(whitespaceNotice, { exact: true })).toBeVisible()
  await dialog.getByText('看完整原文', { exact: true }).click()
  const original = dialog.locator('.approval-operation > details .approval-source')
  await expect(original).toBeVisible()
  expect((await original.textContent())?.includes('Before: "const b = 3\\n"')).toBe(true)
  await expect(dialog.getByText('看摘要', { exact: true })).toHaveCount(0)
  await expect(dialog.locator('script, img, [onerror]')).toHaveCount(0)
  expect(await page.evaluate(() => 'approvalInjected' in window)).toBe(false)
  await expect(page.locator('html')).not.toHaveAttribute('data-csp-violation', 'true')
  await expect(dialog.getByText('这里不是全部内容，完整的请在终端里看。', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
})

test('terminal calls a legacy summary a summary and expands received preview lines', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 })
  await openFixture(page, { terminal: true })
  const dialog = page.locator('dialog.now-terminal-dialog')
  await page.locator('.now-terminal[data-hash="leg01"] button').click()
  await expect(dialog.getByText('摘要', { exact: true })).toBeVisible()
  await expect(dialog.getByText('摘要里的换行和连续空格可能被并掉了。', { exact: true })).toBeVisible()
  await dialog.getByText('看摘要', { exact: true }).click()
  await expect(dialog.getByText('看完整原文', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.locator('.now-terminal[data-hash="cut01"] button').click()
  await dialog.getByText('还有 2 行 · 展开收到的部分', { exact: true }).click()
  await expect(dialog.getByText('echo example-7', { exact: false })).toBeVisible()
  await expect(dialog.getByText('这里不是全部内容，完整的请在终端里看。', { exact: true })).toBeVisible()
  await expect(dialog.getByText('看完整原文', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
})
