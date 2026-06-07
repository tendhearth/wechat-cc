// Overview ("此刻") pane data-flow tests — driven against test-shim.ts.
//
// Covers moxiuwen's redesigned hero card + current-user card + sub-user
// grid (post merge 782268e):
//   1. hero tone — daemon alive ("AI 正在陪伴中") vs dead ("暂时失联")
//   2. current-user card — populated when an account is bound, empty
//      placeholder when not
//   3. sub-user grid — 6 demo cards when no real sub-users; sub-rows
//      from accounts.items.slice(1) when present
//   4. provider chip reads from doctor.checks.provider.provider
//
// Drives the dashboard via the shim's doctor intercept which produces
// daemon.alive + accounts based on demo.seed state.

import { test, expect } from './fixtures'

// These tests rely on initialMode() routing into dashboard mode based on
// the doctor mock (accounts + provider + service all present). No manual
// dataset.mode override needed — the boot path naturally lands on dashboard
// when demo.seed has populated chats. That also means renderDashboard
// actually runs (it bails when state.mode !== 'dashboard' even if the
// DOM data-mode attr says otherwise).

// ── Hero tone (daemon alive vs dead) ────────────────────────────────────
//
// To exercise the hero render path, the page must boot INTO dashboard mode
// (state.mode = "dashboard" — not just the data-mode attribute). initialMode
// requires accounts + provider + service to all be present. We always seed
// so that condition holds, then independently set daemonAlive to drive the
// hero tone.

// Wait for boot to finish setting state.mode to dashboard, then trigger
// a fresh doctorPoller.refresh so renderDashboard fires with the now-correct
// state.mode. Without this, the first refresh fires before setMode and
// renderDashboardIfActive bails; subsequent renders depend on the 5s poll
// interval which is racey with test timeouts.
async function bootAndForceDashboardRender(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => document.documentElement.dataset.mode === 'dashboard',
    { timeout: 10_000 }
  )
  // Boot may have raced past renderDashboard. Force a re-render by
  // dispatching a synthetic visibilitychange — the dashboard subscribes
  // to refresh on visibility regain. Alternative: small delay then
  // doctorPoller.refresh, but visibilitychange is more deterministic.
  await page.evaluate(() => {
    // Trigger any visibility-listener path the app uses for fresh data.
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

// NOTE on the 3-state dashboardHero logic in view.js::dashboardHero —
// state is determined by these rules (in priority order):
//   taken_over  — lastProbe.state === 'taken_over' OR expiredCount > 0
//   connected   — lastProbe.state === 'connected' OR (daemonAlive && accountCount > 0)
//   recovering  — everything else (daemon dead, no probe result)
//
// Button visibility follows state:
//   #dash-stop    visible only in "connected"
//   #dash-restart visible only in "recovering"
//   #dash-rebind  visible only in "taken_over"
//
// In the test scenarios below, demo.seed produces non-expired accounts.
// daemonAlive=true  → connected  (#dash-stop visible, #dash-restart hidden)
// daemonAlive=false → recovering (#dash-stop hidden,  #dash-restart visible)

test('hero shows "AI 正在陪伴中" with bound account (daemon alive)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).not.toHaveClass(/warn/)
})

test('hero shows "暂时失联" when daemon is dead (bound account, no probe)', async ({ page, shimUrl, shim }) => {
  // daemon dead + account > 0 + no probe result → recovering state.
  // The 3-state logic requires BOTH daemonAlive AND accountCount > 0 for
  // "connected"; a dead daemon falls through to "recovering" regardless
  // of bound account count.
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/暂时失联/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).toHaveClass(/warn/)
})

// ── Stop/restart button visibility ─────────────────────────────────────
// Both renderDashboard and renderRestartButton call dashboardHero() and
// use hero.state to show/hide the three action buttons:
//   #dash-stop    → visible only when state === "connected"
//   #dash-restart → visible only when state === "recovering"
//   #dash-rebind  → visible only when state === "taken_over"
//
// daemon alive + accounts > 0    → connected   → stop shown, restart hidden
// daemon dead  + accounts > 0    → recovering  → restart shown, stop hidden

test('stop button visible + restart hidden when account bound and daemon alive', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#dash-stop')).toBeVisible()
  await expect(page.locator('#dash-restart')).toBeHidden()
})

test('daemon dead + account bound → recovering: restart shown, stop hidden', async ({ page, shimUrl, shim }) => {
  // daemon dead + accounts > 0, no probe → recovering state.
  // #dash-stop is hidden (nothing to stop), #dash-restart is shown.
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#dash-stop')).toBeHidden({ timeout: 10_000 })
  await expect(page.locator('#dash-restart')).toBeVisible()
})

// ── Current-user card ───────────────────────────────────────────────────

test('current-user card renders bound account name + 管理员 pill', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  const current = page.locator('#accounts-current')
  // Friendly name comes from userNames[userId] in the doctor response.
  // demo.seed seeds userNames = { test_chat: 'Test User' }.
  await expect(current).toContainText(/Test User/, { timeout: 10_000 })
  await expect(current.locator('.role-pill')).toContainText(/管理员/)
  await expect(current.locator('.provider-chip')).toContainText(/claude/)
})

// ── Sub-user grid ───────────────────────────────────────────────────────

test('sub-user grid shows 6 demo cards when no real sub-users', async ({ page, shimUrl, shim }) => {
  // demo.seed produces 1 real account → rows.slice(1) is empty → demo cards shown.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  // demoSubUsers() returns 6 placeholder rows.
  await expect(page.locator('#accounts-body .sub-user-card')).toHaveCount(6, { timeout: 10_000 })
  // Each demo card has the data-bot-id attr set to demo-N.
  await expect(page.locator('#accounts-body .sub-user-card[data-bot-id^="demo-"]')).toHaveCount(6)
})

test('demo sub-user cards have no delete button (row.demo flag)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#accounts-body .sub-user-card')).toHaveCount(6, { timeout: 10_000 })
  // Demo cards skip the delete affordance — non-demo non-expired rows
  // would have a .mini-action[data-action="ask-delete"] button.
  const deleteBtns = page.locator('#accounts-body .sub-user-card .mini-action[data-action="ask-delete"]')
  await expect(deleteBtns).toHaveCount(0)
})
