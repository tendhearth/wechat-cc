// A2A Agents dashboard — Playwright e2e tests.
//
// These tests drive the dashboard's A2A pane against test-shim.ts (DRY_RUN=1).
// The shim spins up a real Bun.serve fake HTTP server on port 4175 that handles
// all /v1/a2a/* routes, so no real daemon is required.
//
// Shim wiring:
//   - `daemon api-info` → returns { ok:true, baseUrl:'http://127.0.0.1:4175', token:'fake-shim-token' }
//   - `a2a.seed` test-control → pre-populates __mockState.a2aAgents + a2aEvents
//   - `a2a.reset` test-control → clears that state between tests
//
// Navigation helper:
//   All tests force `data-mode="dashboard"` via page.evaluate (same pattern as
//   dashboard.spec.ts) — in DRY_RUN the doctor returns accounts.count=0 so the
//   page typically boots into wizard mode, but the dashboard <main> is always in
//   the DOM and CSS toggles visibility via [data-mode="dashboard"].

import { test, expect } from './fixtures'

// Helper: navigate to shimUrl, wait for boot, force dashboard mode, click the
// A2A pane nav button, then wait for the list to settle (not "加载中…").
async function gotoA2APane(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  // Force dashboard mode (DRY_RUN boot lands in wizard if no accounts bound)
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await page.locator('button[data-pane="a2a-agents"]').click()
  // Wait until the list is no longer in the loading state
  await page.waitForFunction(
    () => {
      const list = document.getElementById('a2a-agents-list')
      return list !== null && list.textContent !== '加载中…'
    },
    { timeout: 8_000 }
  )
}

// ─────────────────────────────────────────────────────────────────────────────

test('A2A tab renders empty state when no agents registered', async ({ page, shimUrl, shim }) => {
  // Ensure no agents are seeded
  await shim.invoke('a2a.reset')
  await gotoA2APane(page, shimUrl)
  // The list must show the empty-state text (not a card)
  const list = page.locator('#a2a-agents-list')
  await expect(list).toBeVisible()
  await expect(list.locator('.empty')).toBeVisible()
  await expect(list.locator('.a2a-agent-card')).toHaveCount(0)
})

test('Add Agent flow: paste URL → preview → install → see in list', async ({ page, shimUrl, shim }) => {
  await shim.invoke('a2a.reset')
  await gotoA2APane(page, shimUrl)

  // Open the Add Agent modal
  await page.locator('#a2a-add-btn').click()
  await page.locator('#a2a-add-modal').waitFor({ state: 'visible' })

  // The form should be visible; preview and success should be hidden
  await expect(page.locator('#a2a-add-form')).toBeVisible()
  await expect(page.locator('#a2a-add-preview')).toBeHidden()
  await expect(page.locator('#a2a-add-success')).toBeHidden()

  // Fill and submit the URL form to trigger preview
  await page.fill('#a2a-add-form input[name="url"]', 'https://fake.example.com/a2a')
  await page.click('#a2a-add-form button[type="submit"]')

  // Preview section must appear (form hides, preview shown)
  await expect(page.locator('#a2a-add-preview')).toBeVisible({ timeout: 8_000 })
  await expect(page.locator('#a2a-add-form')).toBeHidden()

  // Preview should show the fake agent name returned by the shim
  await expect(page.locator('#a2a-preview-name')).toHaveText('Fake Agent')

  // Override the auto-slugified id with a known value for assertion
  await page.fill('#a2a-add-preview input[name="id"]', 'fake-bot')

  // Confirm installation
  await page.click('#a2a-install-confirm')

  // Success section must appear
  await expect(page.locator('#a2a-add-success')).toBeVisible({ timeout: 8_000 })

  // The curl snippet must contain the inbound bearer key (starts with wc_)
  await expect(page.locator('#a2a-add-curl')).toContainText('Authorization: Bearer wc_')

  // Close the modal — this triggers a refresh of the agents list
  await page.click('#a2a-add-close')

  // The modal must close
  await page.locator('#a2a-add-modal').waitFor({ state: 'hidden' })

  // Wait for the list to finish refreshing (not loading)
  await page.waitForFunction(
    () => {
      const list = document.getElementById('a2a-agents-list')
      return list !== null && !list.textContent?.includes('加载中…')
    },
    { timeout: 8_000 }
  )

  // Agent must appear in the list
  const list = page.locator('#a2a-agents-list')
  await expect(list.locator('.a2a-agent-card')).toHaveCount(1)
  await expect(list).toContainText('fake-bot')
})

test('Pause / Resume toggles the agent paused state', async ({ page, shimUrl, shim }) => {
  // Pre-seed one active agent
  await shim.invoke('a2a.seed', {
    agents: [
      {
        id: 'pause-test-bot',
        name: 'Pause Test Bot',
        url: 'https://pause.example.com/a2a',
        paused: false,
        counts: { inbound: 0, outbound: 0 },
        inbound_api_key: 'wc_pause_testkey',
      },
    ],
    events: [],
  })

  await gotoA2APane(page, shimUrl)

  // The agent card must be present and not paused
  const card = page.locator('.a2a-agent-card[data-id="pause-test-bot"]')
  await expect(card).toBeVisible()
  await expect(card).not.toHaveClass(/paused/)

  // Click the Pause button (text "Pause" when agent is active)
  await card.locator('button[data-action="pause"]').click()

  // Wait for the refresh after the API call — card should now have .paused class
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.a2a-agent-card[data-id="pause-test-bot"]')
      return c !== null && c.classList.contains('paused')
    },
    { timeout: 8_000 }
  )
  await expect(card).toHaveClass(/paused/)

  // The pause button should now read "Resume"
  await expect(card.locator('button[data-action="pause"]')).toHaveText('Resume')

  // Click Resume
  await card.locator('button[data-action="pause"]').click()

  // Wait for card to lose .paused class
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.a2a-agent-card[data-id="pause-test-bot"]')
      return c !== null && !c.classList.contains('paused')
    },
    { timeout: 8_000 }
  )
  await expect(card).not.toHaveClass(/paused/)
  await expect(card.locator('button[data-action="pause"]')).toHaveText('Pause')
})

test('Activity drawer opens with recent events', async ({ page, shimUrl, shim }) => {
  const now = new Date().toISOString()
  // Pre-seed one agent + 3 events (2 inbound, 1 outbound)
  await shim.invoke('a2a.seed', {
    agents: [
      {
        id: 'activity-bot',
        name: 'Activity Bot',
        url: 'https://activity.example.com/a2a',
        paused: false,
        counts: { inbound: 2, outbound: 1 },
        inbound_api_key: 'wc_activity_key',
      },
    ],
    events: [
      { agent_id: 'activity-bot', direction: 'in',  text: 'hello from remote',  ts: now, status: 'ok' },
      { agent_id: 'activity-bot', direction: 'in',  text: 'second message',     ts: now, status: 'ok' },
      { agent_id: 'activity-bot', direction: 'out', text: 'reply from wechat-cc', ts: now, status: 'ok' },
    ],
  })

  await gotoA2APane(page, shimUrl)

  // The activity drawer starts hidden
  await expect(page.locator('#a2a-activity-drawer')).toBeHidden()

  // Click the Activity button for the agent card
  const card = page.locator('.a2a-agent-card[data-id="activity-bot"]')
  await expect(card).toBeVisible()
  await card.locator('button[data-action="activity"]').click()

  // Drawer must become visible
  await expect(page.locator('#a2a-activity-drawer')).toBeVisible({ timeout: 8_000 })

  // Title should reference the agent id
  await expect(page.locator('#a2a-activity-title')).toContainText('activity-bot')

  // Wait for events to load (not in loading state)
  await page.waitForFunction(
    () => {
      const ul = document.getElementById('a2a-activity-list')
      return ul !== null && !ul.textContent?.includes('加载中…')
    },
    { timeout: 8_000 }
  )

  // Should show all 3 events
  await expect(page.locator('#a2a-activity-list li')).toHaveCount(3)

  // Should contain the event texts
  const activityList = page.locator('#a2a-activity-list')
  await expect(activityList).toContainText('hello from remote')
  await expect(activityList).toContainText('second message')
  await expect(activityList).toContainText('reply from wechat-cc')

  // Close the drawer
  await page.locator('#a2a-activity-close').click()
  await expect(page.locator('#a2a-activity-drawer')).toBeHidden()
})

test('Remove with confirmation drops the agent from the list', async ({ page, shimUrl, shim }) => {
  // Pre-seed one agent
  await shim.invoke('a2a.seed', {
    agents: [
      {
        id: 'remove-me-bot',
        name: 'Remove Me Bot',
        url: 'https://remove.example.com/a2a',
        paused: false,
        counts: { inbound: 0, outbound: 0 },
        inbound_api_key: 'wc_remove_key',
      },
    ],
    events: [],
  })

  await gotoA2APane(page, shimUrl)

  const card = page.locator('.a2a-agent-card[data-id="remove-me-bot"]')
  await expect(card).toBeVisible()

  // The Remove button triggers window.confirm — auto-accept it
  page.on('dialog', dialog => dialog.accept())
  await card.locator('button[data-action="remove"]').click()

  // After confirmation + server DELETE + refresh, the card must be gone
  await page.waitForFunction(
    () => document.querySelector('.a2a-agent-card[data-id="remove-me-bot"]') === null,
    { timeout: 8_000 }
  )
  await expect(page.locator('#a2a-agents-list .a2a-agent-card')).toHaveCount(0)
  // List should show empty state
  await expect(page.locator('#a2a-agents-list .empty')).toBeVisible()
})

test('Test button opens modal and inbound/outbound both report success', async ({ page, shimUrl, shim }) => {
  await shim.invoke('a2a.seed', {
    agents: [{
      id: 'test-bot',
      name: 'Test Bot',
      url: 'https://test.example.com/a2a',
      paused: false,
      counts: { inbound: 0, outbound: 0 },
      inbound_api_key: 'wc_test_testkey',
    }],
    events: [],
  })

  await gotoA2APane(page, shimUrl)

  const card = page.locator('.a2a-agent-card[data-id="test-bot"]')
  await expect(card).toBeVisible()

  // Click Test → modal opens
  await card.locator('button[data-action="test"]').click()
  const modal = page.locator('#a2a-test-modal')
  await expect(modal).toBeVisible()
  await expect(page.locator('#a2a-test-title')).toContainText('test-bot')
  // Prefilled message contains the agent id
  await expect(page.locator('#a2a-test-text')).toHaveValue(/test-bot/)

  // Inbound test → result reports inbound delivered
  await page.locator('#a2a-test-inbound').click()
  await expect(page.locator('#a2a-test-result.ok')).toBeVisible()
  await expect(page.locator('#a2a-test-result')).toContainText(/inbound delivered/i)

  // Outbound test → result reports outbound delivered
  await page.locator('#a2a-test-outbound').click()
  await expect(page.locator('#a2a-test-result')).toContainText(/outbound delivered/i)

  // Close button shuts the modal
  await page.locator('#a2a-test-close').click()
  await expect(modal).not.toBeVisible()

  // After 2 tests, counts should be ≥1 each (the shim bumps counts on test)
  const card2 = page.locator('.a2a-agent-card[data-id="test-bot"]')
  await expect(card2.locator('.a2a-card-counts')).toContainText(/↓ 1.*↑ 1/)
})

test('Test button reports failure for unknown_agent', async ({ page, shimUrl, shim }) => {
  // Seed one agent, then test a different (nonexistent) id via UI manipulation.
  // Direct manipulation: we'll cheat by injecting a card with a fake id then
  // clicking its Test button — the shim's /v1/a2a/test will return unknown_agent.
  await shim.invoke('a2a.seed', {
    agents: [{
      id: 'ghost-bot',
      name: 'Ghost Bot',
      url: 'https://ghost.example.com/a2a',
      paused: false,
      counts: { inbound: 0, outbound: 0 },
      inbound_api_key: 'wc_ghost_key',
    }],
    events: [],
  })
  await gotoA2APane(page, shimUrl)
  const card = page.locator('.a2a-agent-card[data-id="ghost-bot"]')
  await expect(card).toBeVisible()
  // Pre-remove the agent from shim state, then click Test (cache stale id)
  await shim.invoke('a2a.seed', { agents: [], events: [] })
  await card.locator('button[data-action="test"]').click()
  await page.locator('#a2a-test-inbound').click()
  await expect(page.locator('#a2a-test-result.fail')).toBeVisible()
  await expect(page.locator('#a2a-test-result')).toContainText(/unknown_agent/)
})
