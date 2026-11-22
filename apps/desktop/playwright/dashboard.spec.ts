// Dashboard smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// The topbar holds global navigation and the overflow menu.
// Conversation is mounted once inside overview.
//
// NOTE: In DRY_RUN the doctor --json returns accounts.count=0 so the page
// boots into wizard mode by default. The dashboard <main> is always in the
// DOM (CSS shows/hides via data-mode); tests that need the dashboard
// visible switch data-mode via page.evaluate.

import { test, expect, clickNav, clickRevealed } from './fixtures'
import { REPORTS } from './reports'
import { answerPlace, placeItem, placeRow, terminalPlace } from './roster-fixture'

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
  })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
}

// ── Pane registry + skeleton presence ───────────────────────────────────

// 页头直接导航或「更多」里的页面；日志和插件从后厨标签进入。
const NAV_PANES = ['overview', 'notebook', 'recollections', 'memory', 'atelier', 'todos', 'sessions', 'a2a-agents'] as const
/** 有 pane、但入口在后厨标签页里(见 logs.spec.ts 的 bootAndOpenLogs)。 */
const BACKSTAGE_PANES = ['logs', 'plugins'] as const

test('dashboard renders nav + panes (all attached)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)

  for (const pane of NAV_PANES) {
    await expect(page.locator(`button.dash-nav-link[data-pane="${pane}"]`)).toBeAttached()
    await expect(page.locator(`article.dash-pane[data-pane="${pane}"]`)).toBeAttached()
  }
  await expect(page.locator('button.dash-nav-link[data-pane="workbench"]')).toHaveCount(0)
  await expect(page.locator('.dash-pane[data-pane="workbench"]')).toBeAttached()
  await expect(page.locator('#topbar-search')).toBeVisible()
  for (const pane of BACKSTAGE_PANES) {
    await expect(page.locator(`article.dash-pane[data-pane="sessions"] .dialogue-workspace-tab[data-backstage-pane="${pane}"]`)).toBeAttached()
  }
  await expect(page.locator('#converse-root')).toHaveCount(1)
  await expect(page.locator('article[data-pane="overview"] #converse-root')).toBeAttached()
  await expect(page.locator('#topbar-cc')).toBeAttached()
  await expect(page.locator('button[data-pane="converse"]')).toHaveCount(0)
  // Settings gear (opens drawer, not wizard — moxiuwen's gear was repurposed
  // when master's wizard refactor landed; #settings-open is the live id).
  await expect(page.locator('#settings-open')).toBeAttached()
})

test('overview is the default-active pane on first paint', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toBeAttached()
  // Other panes' nav links must NOT have .active.
  for (const pane of ['notebook', 'memory', 'sessions', 'logs', 'a2a-agents'] as const) {
    await expect(page.locator(`button.dash-nav-link.active[data-pane="${pane}"]`)).toHaveCount(0)
  }
})

// ── Tab switching ───────────────────────────────────────────────────────

test('clicking a pane button switches active pane', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)

  // Click memory tab — should switch active class + un-hide memory pane.
  await clickNav(page, 'memory')
  await expect(page.locator('button.dash-nav-link.active[data-pane="memory"]')).toBeAttached()
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toHaveCount(0)
  // The memory pane should no longer be hidden (active panes drop the
  // hidden attribute).
  const memoryHidden = await page.locator('article.dash-pane[data-pane="memory"]').getAttribute('hidden')
  expect(memoryHidden).toBeNull()
})

test('round-trip: overview → memory → overview restores initial state', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'memory')
  await clickNav(page, 'overview')
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toBeAttached()
  // memory should be hidden again
  await expect(page.locator('article.dash-pane[data-pane="memory"][hidden]')).toBeAttached()
})

// ── Per-pane DOM contract ───────────────────────────────────────────────

test('页头 has the connections card + 浮到桌面; no aquarium anywhere; verdict + users + reconnect in 连接与设置', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const now = page.locator('article.dash-pane[data-pane="overview"]')
  await expect(page.locator('#dash-global-rail .cc-home-details #now-connections')).toBeAttached()
  await expect(page.locator('#dash-global-rail .cc-home-details #companion-desktop-start')).toBeAttached()
  await expect(now.locator('#hero-card')).toHaveCount(0)
  // 鱼缸画布 2026-10-01 退休(主人拍板):没有鱼缸页、没有画布、没有沉浸模式。
  await expect(page.locator('[data-pane="aquarium"]')).toHaveCount(0)
  await expect(page.locator('#companion-stage')).toHaveCount(0)
  await expect(page.locator('#companion-immersive-start')).toHaveCount(0)
  // 当前用户 + 子用户 + 重连 / 断开 在「连接与设置」抽屉的「连接」段
  const conn = page.locator('#settings-drawer .drawer-connection')
  await expect(conn.locator('#hero-card #hero-headline')).toBeAttached()
  await expect(conn.locator('#accounts-current')).toBeAttached()
  await expect(conn.locator('#accounts-body')).toBeAttached()
  await expect(conn.locator('#dash-restart')).toBeAttached()
  await expect(conn.locator('#dash-stop')).toBeAttached()
  await expect(conn.locator('#brain-selfcheck')).toBeAttached()
})

test('此刻 status line opens CC 的连接: headline + one row per source + the computer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#dash-global-rail .cc-home-details > summary').click()
  const card = page.locator('#now-connections')
  await expect(card).toBeVisible()
  await expect(card.locator('.nc-headline')).toHaveText('都连着')
  await expect(card.locator('.nc-source')).toHaveCount(3)
  await expect(card.locator('.nc-source').first()).toContainText('微信聊天记录')
  await expect(card.locator('.nc-source').first()).toContainText('最新消息')
  await expect(card.locator('.nc-computer')).toContainText('在线')
  await page.keyboard.press('Escape')
  await expect(page.locator('#dash-global-rail .cc-home-details')).not.toHaveAttribute('open')
})

test('CC 的连接 never shows green when it cannot be read', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', connections: null })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#dash-global-rail .cc-home-details > summary').click()
  const card = page.locator('#now-connections')
  await expect(card.locator('.nc-headline')).toHaveText('暂时不知道连接情况')
  await expect(card.locator('.nc-headline .dot')).toHaveClass(/unknown/)
  await expect(card.locator('.dot.ok')).toHaveCount(0)
})

test('CC 现在怎么样:终端里的 Claude Code / Codex 没接上 ⇒「接上」先说会改什么,确定之后才调路由、行变成已接上', async ({ page, shimUrl, shim }) => {
  const now = Date.now()
  await shim.invoke('demo.seed', { chat_id: 'test_chat', connections: {
    generatedAt: now, starting: false, sources: [], computers: [{ id: 'home', label: '这台电脑', online: true, since: now, version: '1.7.6' }], recent: [], outputs: [],
    capabilities: [{ id: 'terminal', name: '终端里的 Claude Code / Codex', state: 'off', code: 'terminal.not_connected', reason: '装了 Claude Code / Codex，还没接上：终端里的会话 CC 看不到。', action: { label: '接上', where: 'desktop', run: 'cli_hooks_install' } }],
  } })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#dash-global-rail .cc-home-details > summary').click()
  const row = page.locator('#now-connections .nc-capability')
  await expect(row).toContainText('还没接上')
  await row.getByRole('button', { name: '接上', exact: true }).click()
  await expect(row.locator('.hooks-confirm')).toHaveText('只加 CC 自己的几条 hook，随时能撤掉。')
  await row.locator('.hooks-detail > summary').click()
  await expect(row.locator('.hooks-detail')).toContainText('~/.claude/settings.json')
  expect(((await shim.invoke('mock.hook-calls')) as { result: { calls: unknown[] } }).result.calls).toHaveLength(0)
  await row.getByRole('button', { name: '确定接上' }).click()
  await expect(row).toContainText('已接上')
  await expect(row.locator('button')).toHaveCount(0)
  expect(((await shim.invoke('mock.hook-calls')) as { result: { calls: unknown[] } }).result.calls).toEqual([{}])
})

test('「地方」里终端停着问的行亮点，只有可拍板的请求才显示允许和拒绝', async ({ page, shimUrl, shim }) => {
  await page.setViewportSize({ width: 1000, height: 900 })
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const allowed = { session_id: 'ab12c3-full', hash: 'k3x9z', decision: 'allow' }
  const decisions: unknown[] = []
  const actionable = terminalPlace('wechat-cc', allowed.session_id, 'Bash · npm publish')
  const localOnly = terminalPlace('melu', 'cd34e5-full', '要改 package.json')
  const running = placeItem('leni', { line: '在跑测试', sessionIds: ['ef56g7-full'] })
  let approved = false
  await page.route('**/v1/places', route => route.fulfill({ json: {
    places: approved ? [{ ...actionable, waiting: null, status: 'working', moving: true }, localOnly, running] : [actionable, localOnly, running],
    version: approved ? 'approved' : 'waiting',
  } }))
  await page.route('**/v1/cli/sessions*', route => route.fulfill({ json: { sessions: [
    { session_id: allowed.session_id, source: 'claude', status: approved ? 'running' : 'waiting',
      pending: approved ? null : { actionable: true, tool: 'Bash', summary: 'npm publish', hash: allowed.hash } },
    { session_id: 'cd34e5-full', source: 'codex', status: 'waiting', last_summary: '要改 package.json',
      pending: { actionable: false, tool: 'permission', summary: '要改 package.json' } },
  ] } }))
  await page.route('**/v1/cli/activity*', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/v1/cli/decide', route => {
    const decision = route.request().postDataJSON()
    decisions.push(decision)
    approved = decision.session_id === allowed.session_id && decision.hash === allowed.hash && decision.decision === allowed.decision
    return route.fulfill({ status: approved ? 200 : 400, json: { ok: approved } })
  })
  await bootIntoDashboard(page, shimUrl)
  const waiting = page.locator('#places-root .place[data-waiting="true"]')
  await expect(waiting).toHaveCount(2)
  await expect(placeRow(page, 'wechat-cc')).toContainText('npm publish')
  await expect(placeRow(page, 'melu')).toContainText('要改 package.json')
  await expect(placeRow(page, 'leni')).toHaveAttribute('data-waiting', 'false')
  // 不在对话页时,顶栏 CC 上亮一个点。
  await expect(page.locator('#topbar-cc')).toHaveAttribute('data-waiting', '2')

  const detail = page.locator('#thing-thread .thing-terminal:visible')
  await answerPlace(page, 'melu')
  await expect(detail.locator('textarea')).toHaveAttribute('placeholder','先在终端里定下这件，它才往下走')
  await expect(detail.locator('.desk-waiting-card')).toBeHidden()
  await page.locator('#topbar-cc').click()
  await expect(detail).toHaveCount(0)
  await answerPlace(page, 'wechat-cc')
  await expect(detail).toBeVisible()
  await expect(detail.locator('.desk-waiting-question')).toHaveText('Bash · npm publish')
  await detail.getByRole('button', { name: '允许', exact: true }).click()
  await expect(detail.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  expect(decisions).toEqual([allowed])
  await page.locator('#topbar-cc').click()
  await expect(detail).toHaveCount(0)
  await expect(waiting).toHaveCount(1, { timeout: 6000 })
  await expect(waiting.first()).toHaveAttribute('data-place-key', localOnly.key)
  await expect(page.locator('#topbar-cc')).toHaveAttribute('data-waiting', '1')
})

test('memory pane has sidebar + observations + milestones + content viewer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'memory')
  const pane = page.locator('article.dash-pane[data-pane="memory"]')
  await expect(pane).toBeVisible()
  // Real IDs from index.html — the memory pane has a 3-column layout:
  // top zone with observations + milestones, then sidebar (file list)
  // + main content (markdown view + editor) + decisions panel.
  await expect(pane.locator('#memory-observations')).toBeAttached()
  await expect(pane.locator('#memory-milestones')).toBeAttached()
  await expect(pane.locator('#memory-sidebar')).toBeAttached()
  await expect(pane.locator('#memory-refresh')).toBeAttached()
  await expect(pane.locator('#memory-meta')).toBeAttached()
})

test('sessions pane mounts the dialogue-root container (Task 10 real-data page)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'sessions')
  const pane = page.locator('article.dash-pane[data-pane="sessions"]')
  await expect(pane).toBeVisible()
  // Task 10 replaced the static sessions scaffold with a single dynamic mount
  // point; the old #sessions-meta / #sessions-mode-compact are gone.
  await expect(pane.locator('#dialogue-root')).toBeAttached()
})

test('logs pane has meta crumb + content container', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'sessions')
  await page.locator('article.dash-pane[data-pane="sessions"] .dialogue-workspace-tab[data-backstage-pane="logs"]').click()
  const pane = page.locator('article.dash-pane[data-pane="logs"]')
  await expect(pane).toBeVisible()
  await expect(pane.locator('#logs-meta')).toBeAttached()
})

test('a2a-agents pane has server banner + agent list + Add Agent button', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'a2a-agents')
  const pane = page.locator('article.dash-pane[data-pane="a2a-agents"]')
  await expect(pane).toBeVisible()
  await expect(pane.locator('#a2a-server-banner')).toBeAttached()
  await expect(pane.locator('#a2a-agents-list')).toBeAttached()
  await expect(pane.locator('#a2a-add-btn')).toBeAttached()
})

test('a2a add modal opens + closes via ✕ button (regression for fix 5ddeb72)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickNav(page, 'a2a-agents')
  // Open the modal
  await clickRevealed(page, '#a2a-add-btn')
  await expect(page.locator('dialog#a2a-add-modal[open]')).toBeVisible()
  // Close via the ✕ — this was missing pre-5ddeb72 and the modal had no escape hatch
  await page.locator('#a2a-add-modal-close').click()
  await expect(page.locator('dialog#a2a-add-modal[open]')).toHaveCount(0)
})

// ── Data flow regression — shim seeding propagates through /v1(架构终态 F6 起不再经 CLI)──────

test('observations list reflects seeded data', async ({ shim, shimUrl }) => {
  // Direct shim API test — no UI needed; verifies the data layer works
  // end-to-end. Seed 5 observations for test_chat.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const result = (await (await fetch(`${shimUrl}/v1/observations/list?chat_id=test_chat`)).json()) as { observations?: unknown[] }
  const observations = result.observations ?? []
  expect(observations.length).toBe(5)
})

// ── Reconnect diagnosis fixtures ──────────────────────────────────────────
// Diagnosis stays internal; the overview hero is the only recovery surface.

test.describe('single-surface reconnect flow', () => {
  test('dead-daemon click starts recovery immediately without a second card', async ({ page, shimUrl, shim }) => {
    // Seed so dashboard mode is reached
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Inject the dead-daemon doctor shape BEFORE clicking restart
    await shim.invoke('mock.doctor', { report: REPORTS.deadDaemon })
    await shim.invoke('mock.reset-service-invokes')

    // The restart button is visible only when hero.tone !== "ok".
    // Our shim initially seeds daemon.alive=true (demo.seed default),
    // so the restart button is hidden and the stop button is shown.
    // Force-show the restart button for this test via evaluate.
    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })

    // One click diagnoses internally and starts recovery immediately.
    await clickRevealed(page, '#dash-restart')

    // The old duplicate diagnosis card no longer exists in the page.
    await expect(page.locator('#reconnect-diagnose-card')).toHaveCount(0)

    // Wait until the restart sequence reaches service start, then let the
    // next health poll observe a live daemon.
    await expect.poll(
      async () => {
        const r = await shim.invoke('mock.get-service-invokes') as { result: { invokes: string[] } }
        return r.result.invokes
      },
      { timeout: 5000 },
    ).toEqual(expect.arrayContaining(['service stop', 'service start']))
    await shim.invoke('mock.doctor', { report: REPORTS.allGreen })

    await expect(page.locator('#dash-pending')).toHaveText('连接已恢复', { timeout: 5000 })
  })

  test('provider-missing opens settings without a technical diagnosis card', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    await shim.invoke('mock.doctor', { report: REPORTS.providerMissing })

    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })
    await clickRevealed(page, '#dash-restart')

    await expect(page.locator('#reconnect-diagnose-card')).toHaveCount(0)
    await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/, { timeout: 3000 })
    await expect(page.locator('#hero-meta')).toHaveText('AI 服务暂不可用，请检查设置')
  })

  test('all-green race returns to normal without rendering another surface', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    await shim.invoke('mock.doctor', { report: REPORTS.allGreen })

    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })
    await clickRevealed(page, '#dash-restart')

    await expect(page.locator('#reconnect-diagnose-card')).toHaveCount(0)
    await expect(page.locator('#dash-pending')).toHaveText('连接正常', { timeout: 3000 })
  })

  test('frontend-stuck keeps the failure in the hero and exposes details', async ({ page, shimUrl, shim }) => {
    // Seed so dashboard mode is reached with daemonAlive=true (generates a
    // report with internal_api in daemon.checks so healthProbe can fire).
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Ensure health probe returns true (default, but be explicit).
    await shim.invoke('mock.health-probe', { result: true })

    // Make the NEXT doctor --json call fail so doctorPoller.lastError gets set.
    // The poller's .current still holds the last good report (from boot poll).
    await shim.invoke('mock.doctor-error')

    // Force-show the restart button (daemon was alive at boot → stop btn shown).
    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })

    // Click "重新连接" — restartDaemon:
    //   1. refresh() fails → lastError set, returns null
    //   2. current report has daemon.internal_api → healthProbe fires → true
    //   3. diagnose({ report, healthOk: true, lastError: non-null }) → code 7
    await clickRevealed(page, '#dash-restart')

    await expect(page.locator('#reconnect-diagnose-card')).toHaveCount(0)
    await expect(page.locator('#hero-headline')).toHaveText('CC 暂时失去连接')
    await expect(page.locator('#hero-meta')).toHaveText('页面状态暂未更新，请重新打开应用')
    await expect(page.locator('#dash-restart')).toContainText('再试一次')
    await expect(page.locator('#dash-view-details')).toBeVisible()
  })
})

// ── Provider-switch dropdown ─────────────────────────────────────────────────

test.describe('provider-switch dropdown', () => {
  test('connecting another AI service keeps its settings form visible',async({page,shimUrl,shim})=>{
    await shim.invoke('demo.seed',{chat_id:'test_chat'})
    await bootIntoDashboard(page,shimUrl)
    await clickRevealed(page, '#settings-open')
    await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
    await expect(page.locator('#accounts-current .provider-switch')).toBeVisible()
    await page.locator('#accounts-current .provider-switch').click()
    await page.locator('#provider-menu [data-action="connect-ai"]').click()
    await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
    await expect(page.locator('#brain-health')).toBeVisible()
  })
  test('click .provider-switch shows menu with 3 options; clicking codex records provider-set + restart chain', async ({ page, shimUrl, shim }) => {
    // Seed with claude as the active provider (default in shim doctor output)
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Force-render the current-user card — the doctor poller runs on a 5s
    // interval; we need the card in the DOM NOW. Trigger a doctor refresh.
    // The shim seeds provider=claude, so the chip shows "claude".
    await shim.invoke('mock.reset-service-invokes')

    // Wait for the current-user card to have a .provider-switch button.
    // It's rendered on the first doctor poll which completes during boot.
    await expect(page.locator('#accounts-current .provider-switch')).toBeAttached({ timeout: 8000 })

    // Click the provider-switch button to open the dropdown
    await clickRevealed(page, '#accounts-current .provider-switch')

    // Menu should now be visible with 3 option buttons
    await expect(page.locator('#provider-menu')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('#provider-menu button[data-provider="claude"]')).toBeAttached()
    await expect(page.locator('#provider-menu button[data-provider="codex"]')).toBeAttached()
    await expect(page.locator('#provider-menu button[data-provider="cursor"]')).toBeAttached()

    // claude should be marked active (has .provider-menu-active class)
    await expect(page.locator('#provider-menu button.provider-menu-active[data-provider="claude"]')).toBeAttached()

    // Click "codex" to trigger the switch
    await page.locator('#provider-menu button[data-provider="codex"]').click()

    // Assert provider set was recorded
    await expect.poll(
      async () => {
        const r = await shim.invoke('mock.get-provider-invokes') as { result: { invokes: Array<{ provider: string }> } }
        return r.result.invokes.map(i => i.provider)
      },
      { timeout: 5000 },
    ).toContain('codex')

    // Assert service stop + start were called (restart chain)
    await expect.poll(
      async () => {
        const r = await shim.invoke('mock.get-service-invokes') as { result: { invokes: string[] } }
        return r.result.invokes
      },
      { timeout: 8000 },
    ).toEqual(expect.arrayContaining(['service stop', 'service start']))

    // Menu should be closed after the switch
    await expect(page.locator('#provider-menu')).toBeHidden({ timeout: 3000 })
  })
})

// ── Step 4 — RECONNECT_DIAGNOSE telemetry Playwright test ────────────────────
//
// Verify that clicking "重新连接" causes a fire-and-forget
// `wechat_cli_json { args: ['log', 'RECONNECT_DIAGNOSE', ...] }` call with
// the 6 expected field keys present in the --fields JSON payload.

test.describe('RECONNECT_DIAGNOSE telemetry', () => {
  test('clicking reconnect records a RECONNECT_DIAGNOSE log call with 6 field keys', async ({ page, shimUrl, shim }) => {
    // Seed so dashboard mode is reached and mock state is clean
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Inject a dead-daemon doctor report so restartDaemon goes through the
    // diagnose() path (not the no-report fallback) — code-1 is a good choice
    // because it reliably exercises the diagnostic log path.
    await shim.invoke('mock.doctor', { report: REPORTS.deadDaemon })

    // Force-show the restart button (seeded daemon is alive → stop btn shown)
    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })

    // Click "重新连接" — triggers restartDaemon() → diagnose() → telemetry
    await clickRevealed(page, '#dash-restart')

    const EXPECTED_FIELD_KEYS = ['code', 'daemon_alive', 'service_installed', 'provider', 'lastError_present', 'health_ok']

    // Poll until at least one log call with tag RECONNECT_DIAGNOSE is recorded
    // (the fire-and-forget settle time is typically <100ms on local machines).
    await expect.poll(
      async () => {
        const r = await shim.invoke('mock.get-log-calls') as { result: { calls: Array<{ tag: string; fields: Record<string, unknown> | null }> } }
        return r.result.calls.filter(c => c.tag === 'RECONNECT_DIAGNOSE').length
      },
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(1)

    const r = await shim.invoke('mock.get-log-calls') as { result: { calls: Array<{ tag: string; msg: string; fields: Record<string, unknown> | null }> } }
    const diagCalls = r.result.calls.filter(c => c.tag === 'RECONNECT_DIAGNOSE')

    // At least one telemetry call was fired
    expect(diagCalls.length).toBeGreaterThanOrEqual(1)

    // The first call must have all 6 expected field keys
    const firstFields = diagCalls[0]!.fields
    expect(firstFields).not.toBeNull()
    for (const key of EXPECTED_FIELD_KEYS) {
      expect(firstFields).toHaveProperty(key)
    }
  })
})


test('presence shell keeps one home composer and its draft through navigation', async ({page,shimUrl,shim}) => {
  await page.setViewportSize({ width: 800, height: 820 })
  await shim.invoke('demo.seed', {chat_id:'test_chat'})
  await bootIntoDashboard(page,shimUrl)
  await expect(page.locator('#dash-global-rail .cc-home-details')).not.toHaveAttribute('open')
  await expect(page.locator('#converse-input')).toBeVisible()
  await page.locator('#converse-input').fill('只检查草稿，不发送')
  await page.locator('#dash-global-rail .cc-home-details > summary').click()
  await clickNav(page, 'recollections')
  await expect(page.locator('article[data-pane="recollections"]')).toBeVisible()
  await clickNav(page, 'overview')
  await expect(page.locator('article[data-pane="overview"]')).toBeVisible()
  await page.locator('#topbar-cc').click()
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#dash-global-rail .cc-home-details')).not.toHaveAttribute('open')
  await expect(page.locator('#converse-input')).toHaveValue('只检查草稿，不发送')
  await expect(page.locator('#converse-input')).toBeFocused()
  await expect(page.locator('#converse-root')).toHaveCount(1)
  const header = await page.locator('header.dash-topbar').boundingBox()
  const main = await page.locator('.dash-main').boundingBox()
  expect(header!.y + header!.height).toBeLessThanOrEqual(main!.y + 1)
  expect(header!.height).toBe(72)
})

test('conversation opens directly; CC focuses input and draft survives navigation', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const pane = page.locator('.cc-now-pane')
  await expect(pane).toHaveAttribute('data-now', 'chat')
  // shim 默认 presence ok ⇒ 够得着 ⇒ 亮着的 CC。
  await expect(pane).toHaveAttribute('data-cc', 'here')
  // 动画就绪后静态 PNG 让位给 now-pet-stage(cc-now.css),亮着看 stage 的 data-form。
  await expect(page.locator('#topbar-cc .now-pet-stage')).toHaveAttribute('data-form', 'lit')
  await expect(page.locator('.topbar-cc-dark')).toBeHidden()
  await expect(page.locator('#converse-scroll')).toBeVisible()
  await page.locator('#converse-input').fill('草稿不丢')
  await page.locator('#topbar-cc').click()
  await expect(pane).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#converse-scroll')).toBeVisible()
  // 离开对话再回来，草稿仍在同一个输入框里。
  await clickNav(page, 'recollections')
  await clickNav(page, 'overview')
  await expect(pane).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#converse-input')).toHaveValue('草稿不丢')
  await expect(page.locator('#converse-root')).toHaveCount(1)
  await clickNav(page,'overview')
  await expect(pane).toHaveAttribute('data-now', 'chat')
})

test('原话只在对话出现,小 CC 聚焦输入,草稿和完整回复保留', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const reply = '备选安排如下：\n\n1. 周五去上海，周日回来。\n2. 也可以把行程往后挪一周。'
  await page.route('**/v1/matter/owner-chat', route => route.fulfill({ json: { events: [
    { kind: 'text', text: reply, createdAt: Date.now() - 1000 },
    { kind: 'text', text: '任务完成：已修改 3 个文件', createdAt: Date.now(), source: 'workbench' },
  ] } }))
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('#converse-scroll')).toContainText('周五去上海，周日回来。')
  await expect(page.locator('#dash-global-rail')).not.toContainText('周五去上海')
  const metrics = await page.locator('#converse-input').evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client)
  await page.locator('#converse-input').fill('保留这句草稿')
  await page.locator('#topbar-cc').click()
  await expect(page.locator('#converse-scroll')).toContainText('备选安排如下：')
  await expect(page.locator('#converse-scroll ol li')).toHaveText(['周五去上海，周日回来。','也可以把行程往后挪一周。'])
  await expect(page.locator('#converse-scroll')).toContainText('任务完成：已修改 3 个文件')
  await expect(page.locator('#converse-input')).toHaveValue('保留这句草稿')
  await expect(page.locator('#converse-input')).toBeFocused()
})

test('CC goes dark when the daemon cannot be reached', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', presenceDown: true })
  const down = page.waitForResponse(r => r.url().includes('/v1/companion/presence') && r.status() === 503, { timeout: 25_000 })
  await bootIntoDashboard(page, shimUrl)
  await down
  // index.html 默认就是 away,所以先证明 poller 真的跑过:状态行红点 + 不在身边由同一信号写入。
  await expect(page.locator('#topbar-presence')).toHaveText('CC 不在身边', { timeout: 10_000 })
  await expect(page.locator('#topbar-presence-dot')).toHaveClass(/bad/)
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'away')
  await expect(page.locator('#topbar-cc')).toHaveAttribute('data-cc', 'away')
  await expect(page.locator('#topbar-cc .now-pet-stage')).toHaveAttribute('data-form', 'unlit')
  await expect(page.locator('.topbar-cc-light')).toBeHidden()
})

test('CC is lit and the status line is green when presence answers', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'here', { timeout: 25_000 })
  // 动画就绪后静态 PNG 让位给 now-pet-stage(cc-now.css),亮着看 stage 的 data-form。
  await expect(page.locator('#topbar-cc .now-pet-stage')).toHaveAttribute('data-form', 'lit')
  await expect(page.locator('#topbar-presence-dot')).toHaveClass(/ok/, { timeout: 15_000 })
  await expect(page.locator('#topbar-presence')).toHaveText('CC 在家')
})
