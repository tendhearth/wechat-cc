import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { REPORTS } from './reports'

// Offline browser contract only: the native bridge below never opens a terminal.
async function stubCliSetup(page: Page, qaBlocked = false) {
  const state = {
    installed: false, loggedIn: false, setupReads: 0,
    posts: [] as unknown[], nativeCalls: [] as unknown[], healthQueries: [] as string[],
  }
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await page.route('**/v1/llm/setup', async route => {
    if (route.request().method() === 'POST') {
      state.posts.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
      return
    }
    expect(route.request().method()).toBe('GET')
    state.setupReads++
    await route.fulfill({ json: {
      ok: true, allowed: true, blockedReason: '', providers: [
        { id: 'grok', label: 'Grok · 账号连接', installed: state.installed, loggedIn: state.loggedIn,
          canInstall: true, canLogin: state.installed, runtimeSupported: true, free: true,
          website: 'https://x.ai/build', commands: ['offline-grok-install', 'offline-grok-login'] },
        { id: 'codex', label: 'Codex · 账号连接', installed: true, loggedIn: false,
          canInstall: true, canLogin: true, runtimeSupported: true, free: false,
          website: 'https://developers.openai.com/codex/cli', commands: ['offline-codex-login'] },
        { id: 'claude', label: 'Claude · 账号连接', installed: true, loggedIn: true,
          canInstall: true, canLogin: true, runtimeSupported: true, free: false,
          website: 'https://claude.com/claude-code', commands: ['offline-claude-login'] },
      ],
    } })
  })
  await page.route(/\/v1\/llm\/health(?:\?.*)?$/, async route => {
    const query = new URL(route.request().url()).searchParams
    const fresh = query.get('fresh') === '1' && query.get('provider') === 'grok'
    if (fresh) state.healthQueries.push(query.toString())
    await route.fulfill({ json: { ok: true, default_provider: 'claude',
      registered: state.loggedIn ? ['claude', 'grok'] : ['claude'],
      results: fresh ? [{ provider: 'grok', ok: state.loggedIn, source: 'login_receipt' }] : [{ provider: 'claude', ok: true }],
    } })
  })
  await page.route('**/__invoke', async route => {
    const { command, args } = route.request().postDataJSON()
    if (command !== 'open_cli_setup') { await route.fallback(); return }
    state.nativeCalls.push({ command, args })
    // Match the native QA refusal before any POST or launcher is reached.
    if (qaBlocked) { await route.fulfill({ json: { error: 'cli_setup_disabled_in_qa' } }); return }
    // lib.rs owns this POST in production, not the renderer. Simulate that
    // bridge with a routed browser fetch; the actual contract uses provider.
    const result = await page.evaluate(async args => {
      const response = await fetch('/v1/llm/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: args.provider, action: args.action }),
      })
      if (!response.ok) throw Error('offline setup plan refused')
      return response.json()
    }, args)
    await route.fulfill({ json: { result } })
  })
  return state
}

async function openChoices(page: Page, shimUrl: string) {
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible()
  await page.locator('.topbar-more summary').click()
  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await page.locator('#accounts-current .provider-switch').click()
  await page.locator('#provider-menu [data-action="connect-ai"]').click()
  await page.locator('#brain-health').getByRole('button', { name: '登录已有账号' }).click()
  await expect(page.locator('#brain-setup [data-brain-setup]')).toHaveCount(3)
  return page.locator('#brain-setup')
}

async function noHorizontalOverflow(page: Page, card: Locator) {
  await expect(card).toBeVisible()
  const sizes = await card.evaluate(el => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, right: rect.right, cardWidth: el.clientWidth, cardScroll: el.scrollWidth,
      viewport: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth }
  })
  expect(sizes.left).toBeGreaterThanOrEqual(0)
  expect(sizes.right).toBeLessThanOrEqual(sizes.viewport + 1)
  expect(sizes.cardScroll).toBeLessThanOrEqual(sizes.cardWidth + 1)
  expect(sizes.pageScroll).toBeLessThanOrEqual(sizes.viewport + 1)
}

test.beforeEach(async ({ shim }) => {
  await shim.invoke('demo.unseed')
  await shim.invoke('demo.seed', { chat_id: 'cli-setup-offline' })
  await shim.invoke('mock.doctor', { report: REPORTS.allGreen })
})

test('only Grok is free; an installed Codex offers login and choices never launch setup', async ({ page, shimUrl }) => {
  const state = await stubCliSetup(page)
  const card = await openChoices(page, shimUrl)
  await expect(card.getByRole('button', { name: /免费可用/ })).toHaveCount(1)
  await expect(card.locator('[data-brain-setup="grok"]')).toContainText('免费可用')
  for (const id of ['codex', 'claude']) {
    await expect(card.locator(`[data-brain-setup="${id}"]`)).not.toContainText('免费可用')
  }
  await card.locator('[data-brain-setup="codex"]').click()
  await expect(card.locator('[data-cli-action="login"]')).toHaveText('登录')
  await expect(card.locator('[data-cli-action="install"]')).toHaveCount(0)
  await expect(card).not.toContainText('免费可用')
  expect(state.posts).toEqual([])
  expect(state.nativeCalls).toEqual([])
})

test('install sends only provider/action through the stub native bridge and polling detects login', async ({ page, shimUrl }) => {
  const state = await stubCliSetup(page)
  const card = await openChoices(page, shimUrl)
  await card.locator('[data-brain-setup="grok"]').click()
  await expect(card).toContainText('免费可用 · 额度有限')
  await page.clock.install()
  await card.getByRole('button', { name: '安装并登录', exact: true }).click()
  await expect.poll(() => state.posts).toEqual([{ provider: 'grok', action: 'install' }])
  expect(state.nativeCalls).toEqual([{ command: 'open_cli_setup', args: { provider: 'grok', action: 'install' } }])
  await expect(card.getByRole('status')).toHaveText('终端已打开，正在等待安装与授权完成…')
  await expect(card.locator('[data-cli-action]')).toBeDisabled()
  await expect(card).not.toContainText('Grok · 账号连接 已接入')
  const reads = state.setupReads
  state.installed = true
  state.loggedIn = true
  await page.clock.runFor(10_000)
  await expect(card).toHaveText('Grok · 账号连接 已接入')
  expect(state.setupReads).toBeGreaterThan(reads)
  expect(state.healthQueries).toEqual(['fresh=1&provider=grok'])
  await page.clock.runFor(60_000)
  expect(state.healthQueries).toHaveLength(1)
  expect(state.nativeCalls).toHaveLength(1)
  expect(state.posts).toHaveLength(1)
})

test('QA native refusal shows failure and recheck without claiming a terminal opened or starting detection', async ({ page, shimUrl }) => {
  const state = await stubCliSetup(page, true)
  const card = await openChoices(page, shimUrl)
  await card.locator('[data-brain-setup="grok"]').click()
  await page.clock.install()
  await card.getByRole('button', { name: '安装并登录', exact: true }).click()
  await expect(card.getByRole('status')).toHaveText('没能打开接入终端，请检查网络保护后重试。')
  await expect(card.getByRole('button', { name: '重新检测', exact: true })).toBeVisible()
  await expect(card.locator('[data-cli-action]')).toBeEnabled()
  await expect(card).not.toContainText('终端已打开')
  await expect(card).not.toContainText('已接入')
  await page.clock.runFor(60_000)
  expect(state.nativeCalls).toEqual([{ command: 'open_cli_setup', args: { provider: 'grok', action: 'install' } }])
  expect(state.posts).toEqual([])
  expect(state.healthQueries).toEqual([])
})

test('390px choices and the Grok setup card stay inside the viewport', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await stubCliSetup(page)
  const card = await openChoices(page, shimUrl)
  await noHorizontalOverflow(page, card)
  await card.locator('[data-brain-setup="grok"]').click()
  await expect(card.getByRole('button', { name: '安装并登录', exact: true })).toBeVisible()
  await noHorizontalOverflow(page, card)
  await card.locator('summary').filter({ hasText: '复制命令' }).click()
  await expect(card.locator('.brain-cmd')).toHaveCount(2)
  await noHorizontalOverflow(page, card)
})
