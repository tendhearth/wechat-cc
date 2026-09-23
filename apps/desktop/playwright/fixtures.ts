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

/**
 * 点侧栏导航到某个面板。2026-09-13 起「生活与工具」那组入口(记忆 / 跟 CC 说 / 待办 /
 * 对话 / 觅食…)收进了 `<details class="cc-life-nav-more">`,而 main.js 每次切面板都会把
 * 它收起 —— 直接点被折叠的按钮会一直等 visible 到超时。先展开再点,和用户的手一样。
 */
export async function clickNav(page: import('@playwright/test').Page, pane: string): Promise<void> {
  await page.locator('details.cc-life-nav-more').evaluateAll(els => { for (const el of els) el.setAttribute('open', '') })
  await page.locator(`button.dash-nav-link[data-pane="${pane}"]`).click()
}

/**
 * 点一个可能藏在折叠 `<details>` 里的元素(09-13 起「此刻」页把连接 / 重启 / 切换后端收进了
 * `<details class="cc-home-details">`「鱼缸与连接」)。先把它所有 <details> 祖先展开再点。
 */
export async function reveal(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate(el => { for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.setAttribute('open', '') })
}
export async function clickRevealed(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await reveal(page, selector)
  await page.locator(selector).first().click()
}
