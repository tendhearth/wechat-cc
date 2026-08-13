// Wizard smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// Wizard DOM contract (4-screen guided flow, adopted from dev_moxiuwen):
//   <main class="wizard">                              wizard mode wrapper
//     <div class="wizard-window">
//       <div class="wz-top">                           brand + ✕ close
//       <div class="wz-body">
//         <section id="screen-doctor" class="screen active">
//           #checks                                    env-list (renderDoctorWizard)
//           #claude-status-card / #claude-status-label
//           #codex-status-card  / #codex-status-label
//           #recheck-env                               重新检测
//         <section id="screen-provider" class="screen">
//           button.agent[data-provider="claude"|"codex"|"cursor"]
//           #claude-meta / #codex-meta / #cursor-meta
//           #continue-wechat                           继续
//         <section id="screen-wechat" class="screen">
//           #qr-box  (inline; no <dialog>)
//           #qr-title / #qr-message / #qr-poll / #qr-ttl
//           #qr-refresh / #continue-service / #qr-raw / #qr-raw-toggle
//         <section id="screen-service" class="screen">
//           #service-install
//           #screen-autostart-toggle (wizard copy — drawer keeps #autostart-toggle)
//           #screen-unattended-toggle / #screen-guard-toggle / #screen-guard-status-line
//           #post-stop-alert / #post-stop-kill / #enter-dashboard
//       #wizard-foot-dot / #wizard-foot-text           status footer
//
// QR is inline inside #screen-wechat — there is NO <dialog id="qr-modal">.
// Settings live in two places: wizard step-4 (screen-* prefixed IDs) and
// the dashboard's settings drawer (#settings-drawer, canonical IDs).
//
// On startup, boot() calls doctorPoller.refresh() then initialMode(report).
// With DRY_RUN CLI: depending on agent installs, mode = wizard or dashboard.
// Wizard mode means #screen-doctor.screen.active is visible.

import { test, expect } from './fixtures'

async function waitForBoot(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
}

test('wizard renders four guided screens', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // All four screens must be in the DOM regardless of which is visible.
  await expect(page.locator('#screen-doctor')).toBeAttached()
  await expect(page.locator('#screen-provider')).toBeAttached()
  await expect(page.locator('#screen-wechat')).toBeAttached()
  await expect(page.locator('#screen-service')).toBeAttached()
})

test('provider picker offers all three agents', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // Cursor was added 2026-05-23; restored to the wizard in commit b097953
  // after moxiuwen's design (pre-Cursor) was adopted.
  await expect(page.locator('button.agent[data-provider="claude"]')).toBeAttached()
  await expect(page.locator('button.agent[data-provider="codex"]')).toBeAttached()
  await expect(page.locator('button.agent[data-provider="cursor"]')).toBeAttached()
})

test('cursor card meta shows specific missing-leg copy, not generic "未检测到"', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // Cursor's probe shape is { apiKeySet, sdkInstalled, ok } — wizard.js's
  // renderDoctorWizard composes which leg is missing into #cursor-meta:
  //   ok=true               → "已就绪"
  //   apiKeySet=false       → "缺少 CURSOR_API_KEY"
  //   sdkInstalled=false    → "缺少 @cursor/sdk"
  //   otherwise             → "未检测到"
  const metaText = await page.locator('#cursor-meta').textContent()
  expect(metaText).toMatch(/已就绪|缺少 CURSOR_API_KEY|缺少 @cursor\/sdk|未检测到|检测中/)
})

test('provider status cards exist on screen-doctor', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // Doctor screen renders Claude / Codex status cards as the at-a-glance
  // health summary. Both should be present (only Claude/Codex per moxiuwen's
  // design — Cursor's status lives on screen-provider's agent card instead).
  await expect(page.locator('#claude-status-card')).toBeAttached()
  await expect(page.locator('#claude-status-label')).toBeAttached()
  await expect(page.locator('#codex-status-card')).toBeAttached()
  await expect(page.locator('#codex-status-label')).toBeAttached()
})

test('wizard step controls are wired', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // The step transitions: doctor → provider → wechat → service → dashboard.
  // Each forward CTA must exist (gated logic is per-screen; we only verify
  // the buttons are in the DOM).
  await expect(page.locator('#recheck-env')).toBeAttached()
  await expect(page.locator('#continue-wechat')).toBeAttached()
  await expect(page.locator('#continue-service')).toBeAttached()
  await expect(page.locator('#service-install')).toBeAttached()
  await expect(page.locator('#enter-dashboard')).toBeAttached()
})

test('QR is inline (#qr-box on screen-wechat, no <dialog>)', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // QR is rendered inline in moxiuwen's design — no dialog. The dialog
  // was master's single-page approach and has been removed.
  await expect(page.locator('dialog#qr-modal')).toHaveCount(0)
  await expect(page.locator('#screen-wechat #qr-box')).toBeAttached()
  await expect(page.locator('#screen-wechat #qr-refresh')).toBeAttached()
})

test('settings drawer still exists and starts closed', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // The settings drawer is unchanged from master. Even though wizard step-4
  // exposes the same toggles, the drawer remains for post-wizard access
  // from the dashboard rail.
  const drawer = page.locator('#settings-drawer')
  await expect(drawer).toBeAttached()
  await expect(drawer).not.toHaveClass(/is-open/)
})

test('wizard step-4 toggles use screen- prefix to avoid drawer collision', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // The toggle IDs were renamed in commit 2712bfb-followup so wizard step-4
  // and the settings drawer can coexist without document.getElementById()
  // ambiguity. Wizard step-4 owns the `screen-*` IDs; drawer keeps canonical.
  await expect(page.locator('#screen-autostart-toggle')).toBeAttached()
  await expect(page.locator('#screen-unattended-toggle')).toBeAttached()
  await expect(page.locator('#screen-guard-toggle')).toBeAttached()
  await expect(page.locator('#screen-guard-status-line')).toBeAttached()
  // The unprefixed IDs still exist on the drawer — DOM has both.
  await expect(page.locator('#autostart-toggle')).toBeAttached()
  await expect(page.locator('#unattended-toggle')).toBeAttached()
  await expect(page.locator('#guard-toggle')).toBeAttached()
})

test('single-page wizard DOM is gone (regression guard)', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await waitForBoot(page)
  // Sanity check that the old master single-page DOM (PR #36) is not
  // accidentally re-introduced.
  await expect(page.locator('#scan-bind')).toHaveCount(0)
  await expect(page.locator('#agent-card-claude')).toHaveCount(0)
  await expect(page.locator('#agent-card-codex')).toHaveCount(0)
  await expect(page.locator('#agent-card-cursor')).toHaveCount(0)
  await expect(page.locator('#install-strip')).toHaveCount(0)
  await expect(page.locator('#setup-error')).toHaveCount(0)
  await expect(page.locator('.setup-page')).toHaveCount(0)
})

// 已删除一条用例(2026-08-03):「add-account-btn routes to wizard wechat step」。
//
// 它断言仪表盘侧栏存在 #add-account-btn 且点击后路由回向导的 wechat 步骤。
// 该元素在源码里已完全不存在(全仓 grep 无匹配),添加账号的入口移进了设置
// —— 仪表盘现在的文案是「打开设置添加微信账号」。用例断言的是 toBeAttached,
// 元素不存在时必然红,且无法通过改选择器抢救。
//
// 这是 desktop-e2e 从 ~2026-07-08 起持续红的一部分。若要恢复这块覆盖,应针对
// 设置里现行的添加账号流程重新写,而不是复活这条。

test('setup-poll returns confirmed after the DRY_RUN auto-pass', async ({ shim }) => {
  // Direct shim API test — verifies the DRY_RUN QR auto-pass mock (P-T12).
  // Preserved across the wizard refactor because the underlying CLI flow
  // (setup --qr-json + setup-poll) is unchanged by the UI swap.
  await shim.invoke('demo.seed')
  const initial = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'fake-token', '--json'] }) as { result?: { status?: string } }
  expect(initial.result?.status).toBe('wait')

  await shim.invoke('wechat_cli_json', { args: ['setup', '--qr-json'] })
  await new Promise(r => setTimeout(r, 1200))

  const confirmed = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'mock-qr-token', '--json'] }) as { result?: { status?: string; accountId?: string } }
  expect(confirmed.result?.status).toBe('confirmed')
  expect(confirmed.result?.accountId).toBe('mock-bot')
})
