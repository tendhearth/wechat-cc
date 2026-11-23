import { expect, test, type Page } from '@playwright/test'
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

const taskScript = `
import { initWorkbenchPage } from '/modules/workbench.js'
const detail = ${JSON.stringify(data)}
initWorkbenchPage({
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

async function openFixture(page: Page, { wide = false, terminal = false } = {}) {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', () => { document.documentElement.dataset.cspViolation = 'true' })
  })
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      const styles = ['tokens.css', 'fonts.css', 'styles.css', 'shared/agent-avatars.css', 'cc-now.css', 'styles/workbench.css', 'styles/desk-two-pane.css']
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'" },
        body: `<!doctype html><html lang="zh"${wide ? ' data-desk-wide' : ''}><head><meta charset="utf-8">
          ${styles.map(css => `<link rel="stylesheet" href="/${css}">`).join('')}
          <style>html, body, .dashboard, .dash-main, .thing-detail, .workbench-pane, #workbench-root { height: 100%; margin: 0; }</style>
          </head><body>${terminal ? terminalMarkup : taskMarkup}<script type="module" src="/fixture.js"></script></body></html>`,
      })
    } else if (path === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: terminal ? terminalScript : taskScript })
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
    await expect(truncated.locator('.approval-invisible-notice')).toBeVisible()
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
  await expect(dialog.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
})

test('terminal calls a legacy summary a summary and expands received preview lines', async ({ page }) => {
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
})
