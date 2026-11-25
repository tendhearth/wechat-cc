// Interaction tests — driven against test-shim.ts (DRY_RUN=1).
//
// Coverage:
//   1. archive observation        — data layer (shim /v1 ↔ mock state)
//   2. session favorite toggle    — localStorage persistence
//   3. settings drawer            — open / close (button / ESC / backdrop)
//                                   + toggle aria-pressed flip
//                                   + duplicate-ID regression (drawer
//                                     toggle is independent of wizard
//                                     step-4 toggle with the same name)

import { test, expect, clickRevealed } from './fixtures'

test('hidden-titlebar window exposes four narrow drag edges', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await expect(page.locator('.window-drag-edge[data-tauri-drag-region]')).toHaveCount(4)
  await expect(page.locator('.window-drag-titlebar[data-tauri-drag-region]')).toBeAttached()
  await expect(page.locator('.window-drag-edge-top')).toBeAttached()
  await expect(page.locator('.window-drag-edge-right')).toBeAttached()
  await expect(page.locator('.window-drag-edge-bottom')).toBeAttached()
  await expect(page.locator('.window-drag-edge-left')).toBeAttached()
})

test('pressing a drag region explicitly starts native window dragging', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.evaluate(() => {
    // @ts-expect-error — injected by the shim
    window.__dragCalls = 0
    // @ts-expect-error — injected by the shim
    window.__TAURI__.window.getCurrentWindow = () => ({
      // @ts-expect-error — test-only counter
      startDragging: async () => { window.__dragCalls += 1 },
    })
  })
  await page.locator('.window-drag-titlebar').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error — test-only counter
    return window.__dragCalls
  })).toBe(1)
})

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
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

// ── Existing coverage (preserved) ─────────────────────────────────────

test('archive observation removes it from active list', async ({ shim, shimUrl }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  // 架构终态 F6:桌面经宿主调 /v1/observations/*;mock 模式下 shim 按路径答
  const list = async () => (await (await fetch(`${shimUrl}/v1/observations/list?chat_id=test_chat`)).json()) as { observations?: Array<{ id: string }> }
  const observations = (await list()).observations ?? []
  expect(observations.length).toBe(5)

  const firstId = observations[0]!.id
  await fetch(`${shimUrl}/v1/observations/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'test_chat', id: firstId }) })

  const remaining = (await list()).observations ?? []
  expect(remaining.length).toBe(4)
  expect(remaining.map(o => o.id)).not.toContain(firstId)
})

test('sessions favorite toggles and persists to localStorage', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => {
    localStorage.setItem('wechat-cc:favorite-sessions', JSON.stringify(['sess_1']))
  })
  await page.reload()
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  const stored = await page.evaluate(
    () => localStorage.getItem('wechat-cc:favorite-sessions')
  )
  expect(stored).toBe(JSON.stringify(['sess_1']))
})

// ── Settings drawer ───────────────────────────────────────────────────

test('settings drawer is in DOM and starts closed (no .is-open)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const drawer = page.locator('#settings-drawer')
  await expect(drawer).toBeAttached()
  await expect(drawer).not.toHaveClass(/is-open/)
})

test('clicking #settings-open opens the drawer (.is-open class)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
})

test('clicking #settings-close closes the drawer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await page.locator('#settings-close').click()
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

test('ESC key closes the drawer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

test('clicking outside the drawer (on dashboard body) closes it', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  // Click somewhere clearly outside the drawer
  await page.locator('main.dashboard').click({ position: { x: 100, y: 100 } })
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

// ── Toggle behavior + duplicate-ID isolation ──────────────────────────

test('drawer toggle: aria-pressed flips on click', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  const toggle = page.locator('#autostart-toggle')
  const initial = await toggle.getAttribute('aria-pressed')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', initial === 'true' ? 'false' : 'true')
})

test('日历偏好读取状态，授权成功后开着，关闭后提示去哪里收回授权', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const posts: unknown[] = []
  let statusReads = 0
  await page.route('**/v1/calendar/status', async route => {
    expect(route.request().method()).toBe('GET')
    statusReads++
    await route.fulfill({ json: { enabled: false, permission: 'not_determined' } })
  })
  let finishAuthorization!: () => void
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve })
  const offText = 'CC 不再读。系统里的授权要收回，去『系统设置 → 隐私与安全性 → 日历 / 提醒事项』。'
  await page.route('**/v1/calendar/enabled', async route => {
    expect(route.request().method()).toBe('POST')
    const body = route.request().postDataJSON()
    posts.push(body)
    if (body.on) {
      await authorization
      await route.fulfill({ json: { enabled: true, permission: 'granted', text: '日历和提醒事项开了。' } })
    } else {
      await route.fulfill({ json: { enabled: false, text: offText } })
    }
  })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  const drawer = page.locator('#settings-drawer')
  const toggle = drawer.getByRole('button', { name: '读日历和提醒' })
  const feedback = drawer.locator('#calendar-toggle-feedback')
  await expect(drawer.getByText('只读。开了以后早报会带上今天的日程，问 CC 时它也能看。第一次打开时 Mac 会问你给不给权限。', { exact: true })).toBeVisible()
  await expect(feedback).toHaveText('Mac 还没授权。')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(statusReads).toBe(1)
  try {
    await toggle.click()
    await expect(feedback).toHaveText('正在请求授权…')
    await expect(toggle).toBeDisabled()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => posts).toEqual([{ on: true }])
  } finally {
    finishAuthorization()
  }
  await expect(feedback).toHaveText('开着，Mac 已授权。')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveClass(/\bon\b/)
  await toggle.click()
  await expect(feedback).toHaveText(offText)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(posts).toEqual([{ on: true }, { on: false }])
})

test('Mac 拒绝日历授权时开关保持关闭，并指向系统设置', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.route('**/v1/calendar/status', route => route.fulfill({ json: { enabled: false, permission: 'not_determined' } }))
  await page.route('**/v1/calendar/enabled', async route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ on: true })
    await route.fulfill({ json: { enabled: false, permission: 'denied', text: '没拿到权限。' } })
  })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  const toggle = page.locator('#calendar-toggle')
  await toggle.click()
  await expect(page.locator('#calendar-toggle-feedback')).toHaveText('Mac 没给权限。要用的话去『系统设置 → 隐私与安全性 → 日历 / 提醒事项』里打开 Tendhearth CC，再回来开一次。')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toBeEnabled()
})

test('CC 停止时无法点击日历开关', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.route('**/v1/calendar/status', route => route.fulfill({ status: 503, json: { error: 'workbench_connection_unavailable' } }))
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  await expect(page.locator('#calendar-toggle-feedback')).toHaveText('CC 没在运行，启动以后再看。')
  await expect(page.locator('#calendar-toggle')).toBeDisabled()
})

// 这条原本用 #guard-toggle 断言"点一下就亮",从 2026-07-08 起在 CI 上长期
// 红。根因不是 flake:guard 开关会把状态持久化到 daemon,而 v1.6.4 加了
// 「持久化失败的开关会回滚,不再静默撒谎」—— shim 跑在 mutations=blocked
// 下,写必然抛错,于是开关如实回滚,.on 永远不出现。本地偶尔能过只是抢在
// 回滚之前采到了乐观态,是竞速。
//
// 拆成两条,各自测各自该测的:
test('drawer toggle: .on class toggles on click(写入成功的开关)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  // 原先用 #memory-embryo-toggle(纯本地开关);2026-10-03 UI 评审把「实验」
  // 整段藏起来了(无效开关),藏起来的按钮点不到。改用 autostart:shim 在
  // DRY_RUN 下把 `provider set` 当成功写入,开关机制照样测得到、不会回滚。
  await expect(page.locator('#memory-embryo-toggle')).toBeHidden()
  const toggle = page.locator('#autostart-toggle')
  const wasOn = /\bon\b/.test((await toggle.getAttribute('class')) ?? '')
  await toggle.click()
  await expect(toggle).toHaveClass(wasOn ? /^(?!.*\bon\b)/ : /\bon\b/)
  await toggle.click()
  await expect(toggle).toHaveClass(wasOn ? /\bon\b/ : /^(?!.*\bon\b)/)
})

test('drawer toggle: 持久化失败时回滚,不静默撒谎(v1.6.4 契约)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  // guard 开关要落盘;shim 的 mutations=blocked 让这次写必然失败。开关必须
  // 退回原状,而不是停在乐观的"已开启"上骗人。这条契约此前没有 e2e 覆盖 ——
  // 恰恰是它让上面那条老测试红了七周。
  // 2026-10-18 起没装 bx 又没开守护时这一行隐藏(CI 机器上就是这样);这里测的是回滚契约,
  // 等打开抽屉那次刷新落定后再把行亮出来。
  await expect(page.locator('#guard-status-line')).not.toHaveText(/—|查询中/)
  await page.evaluate(() => { (document.getElementById('guard-row') as HTMLElement).hidden = false })
  // 打开抽屉会读回真实状态(shim 的状态目录里可能是开着的),所以按读回的初值断言「点了也不变」。
  const toggle = page.locator('#guard-toggle')
  const before = await toggle.getAttribute('aria-pressed')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', before ?? 'false')
  await expect(toggle).toHaveClass(before === 'true' ? /\bon\b/ : /^(?!.*\bon\b)/)
})

test('drawer and wizard step-4 toggles are independent (duplicate-ID fix regression guard)', async ({ page, shimUrl, shim }) => {
  // Pre-fix (commit before 2712bfb's follow-up rename), both #screen-service
  // and #settings-drawer used the same #autostart-toggle id. Toggling the
  // drawer copy would silently fail to update the wizard copy (and vice
  // versa) because getElementById returns only the first match. The fix
  // renamed the wizard copies to #screen-*. This test asserts that
  // clicking the drawer toggle leaves the wizard copy untouched.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await clickRevealed(page, '#settings-open')
  const drawerToggle = page.locator('#autostart-toggle')          // drawer's
  const wizardToggle = page.locator('#screen-autostart-toggle')   // wizard step-4's
  await expect(drawerToggle).toBeAttached()
  await expect(wizardToggle).toBeAttached()
  const drawerBefore = await drawerToggle.getAttribute('aria-pressed')
  const wizardBefore = await wizardToggle.getAttribute('aria-pressed')
  // Click drawer toggle — only that one should flip.
  await drawerToggle.click()
  const drawerAfter = await drawerToggle.getAttribute('aria-pressed')
  const wizardAfter = await wizardToggle.getAttribute('aria-pressed')
  expect(drawerAfter).not.toBe(drawerBefore)
  expect(wizardAfter).toBe(wizardBefore)  // unchanged
})
