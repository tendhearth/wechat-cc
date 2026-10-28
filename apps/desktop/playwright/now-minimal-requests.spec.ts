import { join } from 'node:path'
import { test, expect, clickNav } from './fixtures'

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
    await page.route('**/v1/workbench**', async route => {
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
    await page.goto(shimUrl)
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')
    await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'here')
    const row = page.locator('#now-waiting-list button[data-task-id="deadbeef"]')
    await expect(row).toHaveAccessibleName('Bash: bun run test 作品集 看清楚 ›')
    await expect(row).toHaveAttribute('title', '看清楚：Bash: bun run test · 作品集')
    await expect(row.locator('.go svg')).toBeVisible()
    await expect(row.locator('.go .now-sr')).toHaveCSS('clip', 'rect(0px, 0px, 0px, 0px)')
    await expect(page.locator('#now-waiting-title')).toHaveCSS('position', 'absolute')
    await expect(row).toHaveCSS('border-bottom-width', '0px')
    const screenshotDir = process.env.WECHAT_CC_DESIGN_SHOTS
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `now-minimal-${width}.png`) })
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.wb-task-head h2')).toHaveText('作品集')
    await clickNav(page, 'overview')
    unreadable = true
    await expect(page.locator('#now-waiting')).toHaveAttribute('data-state', 'partial', { timeout: 12_000 })
    await expect(page.locator('#now-waiting-title')).toHaveText('1 件事等你 · 一起做那边暂时读不到')
    await expect(page.locator('#now-waiting-title')).toHaveCSS('position', 'static')
    await expect(row).toHaveCount(0)
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
