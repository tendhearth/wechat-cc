import { join } from 'node:path'
import { test, expect, clickNav, WORKBENCH_ROUTES } from './fixtures'

// All state below is a controlled demo fixture using the existing endpoint shapes.
const task = {
  id: 'deadbeef', title: '作品集', path: '/demo/portfolio', providerId: 'claude',
  status: 'running', createdAt: 1, updatedAt: 2, error: null, archivedAt: null,
  pendingPermissionCount: 1, pendingQuestionCount: 0,
}
const terminal = {
  session_id: 'terminal-1', code: 'demo', source: 'codex', displayName: 'Codex', status: 'waiting',
  project: '演示项目', pending: { tool: 'Bash', summary: 'git status', since: 1, hash: 'k3x9z' },
}

for (const width of [1440, 760]) {
  test(`minimal now keeps request purpose, keyboard destination and partial reads at ${width}`, async ({ page, shim, shimUrl }) => {
    await page.setViewportSize({ width, height: 900 })
    await shim.invoke('demo.seed', { daemonAlive: true, cliSessions: [terminal] })
    let unreadable = false
    await page.route(WORKBENCH_ROUTES, async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/v1/workbench/attention') {
        if (unreadable) return route.fulfill({ status: 503, json: { error: 'unavailable' } })
        return route.fulfill({ json: { tasks: [{ ...task, attentionKey: '["p1"]', first: { kind: 'permission', text: 'Bash: bun run test' } }] } })
      }
      if (path === '/v1/workbench/task') return route.fulfill({ json: {
        task, events: [{ id: 'e1', taskId: task.id, kind: 'text', text: '想运行测试，确认排版。', createdAt: 2 }], artifacts: [],
        permissions: [{ id: 'p1', taskId: task.id, tool: 'Bash', description: 'bun run test', createdAt: 2 }],
      } })
      if (path === '/v1/workbench') return route.fulfill({ json: {
        tasks: [task], projects: [], providers: [], defaultProvider: 'claude', canWechat: false,
        page: { limit: 100, total: 1, hasMore: false, nextCursor: null },
      } })
      return route.fulfill({ json: { reviews: [] } })
    })
    await page.route('**/v1/matter?id=*',route=>route.fulfill({json:{matter:{...task,kind:'task'},bindings:[],sessions:[],events:[],permissions:[],questions:[],artifacts:[]}}))
    await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')
    await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'here')
    // T5 routes attention through stable conversation references; the legacy
    // waiting rows remain hidden and must not be used as keyboard destinations.
    const locator = page.locator('#now-waiting-title')
    await expect(locator).toHaveText('2 件事等你')
    await expect(locator).toBeVisible()
    await locator.focus()
    await page.keyboard.press('Enter')
    const reference = page.locator('[data-matter-id="deadbeef"]')
    await expect(reference).toHaveCount(1)
    await expect(reference.locator('summary')).toHaveAccessibleName('作品集 等你决定')
    await reference.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(reference).toHaveAttribute('open', '')
    await expect(reference.locator('[data-matter-progress]')).toContainText('Bash: bun run test')
    await expect(reference.locator('[data-matter-progress]')).toContainText('想运行测试，确认排版。')
    const destination = reference.getByRole('button', { name: '看过程、成果与回应', exact: true })
    await expect(destination).toBeVisible()
    const screenshotDir = process.env.WECHAT_CC_DESIGN_SHOTS
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `now-minimal-${width}.png`) })
    await destination.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.wb-task-head h2')).toHaveText('作品集')
    await clickNav(page, 'overview')
    unreadable = true
    await expect(page.locator('#now-waiting')).toHaveAttribute('data-state', 'partial', { timeout: 12_000 })
    await expect(page.locator('#now-waiting-title')).toHaveText('1 件事等你 · 其余的暂时读不到')
    await expect(page.locator('#now-waiting-title')).toHaveCSS('position', 'static')
    await expect(page.locator('#now-waiting-list button[data-task-id="deadbeef"]')).toHaveCount(0)
    await expect(reference.locator('[data-matter-state]')).toHaveText('尚未同步')
    await expect(reference.locator('[data-matter-progress]')).toContainText('想运行测试，确认排版。')
    if (await page.locator('#now-waiting').getAttribute('open') === null) {
      await locator.focus()
      await page.keyboard.press('Enter')
    }
    const terminalRow = page.locator('.now-terminal button')
    await expect(terminalRow).toHaveAccessibleName(/想运行 git status.*演示项目.*Codex.*看清楚/)
    await terminalRow.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('dialog.now-terminal-dialog')).toBeVisible()
    await expect(page.locator('.now-terminal-command')).toHaveText('git status')
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog.now-terminal-dialog')).toHaveCount(0)
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `now-partial-${width}.png`) })
  })
}
