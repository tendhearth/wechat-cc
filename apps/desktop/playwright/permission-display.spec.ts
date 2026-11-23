import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:4213'
const source = new URL('../src/', import.meta.url)
const hostile = '<script>window.approvalInjected=1</script><img src=x onerror="window.approvalInjected=2">\' "'
const command = `npm install sharp\n${hostile}\n${Array.from({ length: 8 }, (_, i) => `echo example-${i}`).join('\n')}`
const snapshotNotice = '预览是批准时的快照，运行以当时内容为准。允许仅限本请求、本轮和这一次调用；脚本及运行时依赖可能变化。'
const completeSource = `command=${command}\necho original-tail\n\n${snapshotNotice}`
const cwd = '/demo/portfolio'
const task = { id: 'A', title: '画作品集', path: cwd, providerId: 'claude', status: 'running', createdAt: 1, updatedAt: 2, error: null }
const edit = { body: { kind: 'edit', path: cwd + '/src/a.ts', changes: [{ before: 'const a = 1', after: 'const a = 2\n' + hostile }] } }
const data = {
  task, version: 1, runId: 'run-A', events: [], artifacts: [], questions: [],
  permissions: [
    { id: 'p1', taskId: 'A', tool: 'Bash', description: 'legacy command', cwd, display: { body: { kind: 'command', command } }, createdAt: 1 },
    { id: 'p2', taskId: 'A', tool: 'Edit', description: 'legacy edit', cwd, display: edit, createdAt: 1 },
    { id: 'p3', taskId: 'A', tool: 'Bash', description: completeSource, cwd, display: { body: { kind: 'command', command }, truncated: true },
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
    await expect(editPanel.locator('[data-line="deleted"]')).toHaveText('− const a = 1')
    await expect(editPanel.locator('[data-line="added"]').first()).toHaveText('+ const a = 2')
    await expect(cards.nth(1).locator('.approval-meta')).toHaveText('在 /demo/portfolio')
    const truncated = cards.nth(2)
    const notice = truncated.locator('.wb-permission-snapshot')
    await notice.scrollIntoViewIfNeeded()
    await expect(notice).toBeVisible()
    await expect(notice).toHaveText(snapshotNotice)
    await expect(truncated.getByText('这里不是全部内容，完整的在下面『看完整原文』里。', { exact: true })).toBeVisible()
    const fullOriginal = truncated.getByText('看完整原文', { exact: true })
    await expect(fullOriginal).toBeVisible()
    await fullOriginal.click()
    const fullSource = truncated.locator('details .approval-source')
    await expect(fullSource).toBeVisible()
    expect(await fullSource.textContent() === completeSource).toBe(true)
    await expect(cards.locator('script, img, [onerror]')).toHaveCount(0)
    expect(await page.evaluate(() => 'approvalInjected' in window)).toBe(false)
    expect(await editPanel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(page.locator('html')).not.toHaveAttribute('data-csp-violation', 'true')
  })
}

test('terminal waiting row opens its structured edit under the desktop CSP', async ({ page }) => {
  await openFixture(page, { terminal: true })
  const row = page.locator('.now-terminal button')
  await expect(row).toHaveCount(1)
  await row.click()
  const dialog = page.locator('dialog.now-terminal-dialog')
  await expect(dialog.getByRole('heading')).toHaveText('想改 src/a.ts…')
  await expect(dialog.locator('[data-line="deleted"]')).toHaveText('− const a = 1')
  await expect(dialog.locator('[data-line="added"]').first()).toHaveText('+ const a = 2')
  await expect(dialog.locator('.approval-meta')).toHaveText(['在 /demo/portfolio', '这里可能不是全部内容，完整的请在终端里看。'])
  await expect(dialog.getByText('看完整原文', { exact: true })).toHaveCount(0)
  await expect(dialog.locator('script, img, [onerror]')).toHaveCount(0)
  expect(await page.evaluate(() => 'approvalInjected' in window)).toBe(false)
  await expect(page.locator('html')).not.toHaveAttribute('data-csp-violation', 'true')
  await expect(dialog.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
})
