import { test as base, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'

interface ShimFixtures {
  shimUrl: string
  shim: { invoke(cmd: string, args?: unknown): Promise<unknown> }
}

// Worker-scoped fixtures run once per worker (not per test), so the shim
// process is started once and reused across all tests in the file.
// This avoids port-in-use races when tests share a worker.
interface WorkerShimFixtures {
  _workerShimUrl: string
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' })
      if (r.ok || r.status === 404) return  // 404 means server is up but root has no handler
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Shim did not start at ${url} within ${timeoutMs}ms`)
}

// Use a dedicated port for Playwright tests so they don't collide with a
// running `bun run shim` (port 4174) on the developer's machine. The test
// shim spawns its own ephemeral instance; EADDRINUSE is silently swallowed
// by the fixture, which would cause tests to run against the non-DRY_RUN
// shim and see real data. Using 4176 avoids that conflict.
const SHIM_PORT = Number(process.env.PLAYWRIGHT_SHIM_PORT ?? '4176')
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`

export const test = base.extend<ShimFixtures, WorkerShimFixtures>({
  // Worker-scoped: start the shim once per worker, share across all tests.
  _workerShimUrl: [async ({}, use) => {
    let proc: ChildProcess | null = null
    try {
      proc = spawn('bun', ['test-shim.ts'], {
        cwd: process.cwd(),  // apps/desktop when run via `playwright test`
        env: { ...process.env, WECHAT_CC_DRY_RUN: '1', WECHAT_CC_SHIM_PORT: String(SHIM_PORT) },
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
      // Suppress EADDRINUSE noise: if the port is already occupied (e.g. a
      // previous run's shim is still alive), the spawn will fail immediately
      // but waitForUrl will still succeed — so we tolerate that case.
      proc.stderr?.on('data', (d: Buffer) => {
        const msg = d.toString().trim()
        if (!msg.includes('EADDRINUSE')) process.stderr.write(`[shim] ${msg}\n`)
      })
      proc.stdout?.on('data', (d: Buffer) => process.stderr.write(`[shim] ${d.toString().trim()}\n`))
      await waitForUrl(SHIM_URL, 10_000)
      await use(SHIM_URL)
    } finally {
      if (proc) {
        proc.kill('SIGTERM')
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }, { scope: 'worker' }],

  // Test-scoped: just expose the worker-scoped URL
  shimUrl: async ({ _workerShimUrl }, use) => {
    await use(_workerShimUrl)
  },

  shim: async ({ _workerShimUrl }, use) => {
    await use({
      invoke: async (cmd, args = {}) => {
        const r = await fetch(`${_workerShimUrl}/__invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: cmd, args }),
        })
        return r.json()
      },
    })
  },
})

export { expect }

/** 页头在所有宽度保持可达；偶尔去的页面先展开更多。 */
export async function clickNav(page: import('@playwright/test').Page, pane: string): Promise<void> {
  if(pane==='workbench'){await page.locator('#topbar-search').click();return}
  const target=page.locator(`#dash-global-rail button[data-pane="${pane}"]`)
  if(await target.evaluate(el=>!!el.closest('.topbar-more'))){
    const more=page.locator('.topbar-more');if(await more.getAttribute('open')===null)await more.locator('summary').click()
  }
  await target.click()
}

/**
 * 点一个可能藏在折叠 `<details>` 或「连接与设置」抽屉里的元素:先把它所有 <details> 祖先展开,
 * 在抽屉里就先点开抽屉,再点。
 */
export async function reveal(page: import('@playwright/test').Page, selector: string): Promise<void> {
  const target = page.locator(selector).first()
  if (await target.evaluate(el => !!el.closest('.topbar-more:not([open])'))) {
    await page.locator('.topbar-more > summary').click()
  }
  await target.evaluate(el => {
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
  })
  // 2026-10-01 起重连 / 测试 / 状态自检与用户卡片住在「连接与设置」抽屉的「连接」段:和用户一样先点开抽屉。
  const inDrawer = await page.locator(selector).first().evaluate(el => !!el.closest('#settings-drawer'))
  if (inDrawer && !(await page.locator('#settings-drawer').evaluate(el => el.classList.contains('is-open')))) {
    if(await page.locator('.topbar-more').getAttribute('open')===null)await page.locator('.topbar-more summary').click()
    await page.locator('#settings-open').click()
    await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  }
}
export async function clickRevealed(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await reveal(page, selector)
  await page.locator(selector).first().click()
}

/**
 * 假的工作台接口要截的请求:`/v1/workbench/*`,外加 P3e-3 起桌面改调的一件事上的动作(`/v1/matter/<动词>`,同一个处理器)。
 * 只截这几个动词:`/v1/matter`、`/v1/matters`、主人对话那几条照旧走 test-shim。
 */
export const WORKBENCH_ROUTES = /\/v1\/(workbench|matter\/(seen|stop|permission|answer|artifact|handoff|worktree|create|create-receipt|rewind|changes|review-mark|review-return|review-comment|review-comments-send))(?=[/?#]|$)/
