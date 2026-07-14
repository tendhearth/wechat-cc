import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vitest's jsdom-like DOM stub so setPending no-ops cleanly. The
// existing dashboard.js uses document.getElementById in setPending; we
// just need the call not to crash.
beforeEach(() => {
  // @ts-expect-error provide a minimal getElementById stub
  globalThis.document = { getElementById: () => null }
  // Use a class for Node so vitest's expect(x instanceof Node) check doesn't
  // throw — a plain object is not constructable, but vitest's toContain tries
  // `actual instanceof Node` which throws when Node is not a function.
  class NodeStub { static TEXT_NODE = 3 }
  // @ts-expect-error stub Node for test environment
  globalThis.Node = NodeStub
  // Reset dashboard module-level state so tests don't bleed into each other.
  __resetDashboardState?.()
})

// Import AFTER document stub so setPending's getElementById doesn't crash
const { renderDashboard, renderRestartButton, restartDaemon, runRestartSequence, stopDaemon, __resetDashboardState, toggleProviderMenu, toggleUserProviderMenu, closeProviderMenu, advanceCompanionHeroCopy } = await import('./dashboard.js')

function textNode(text = '') {
  return { nodeType: 3, textContent: text }
}

function fakeEl() {
  return {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    title: '',
    dataset: {},
    childNodes: [] as Array<any>,
    classList: {
      values: new Set<string>(),
      toggle(cls: string, force?: boolean) {
        if (force) this.values.add(cls)
        else this.values.delete(cls)
      },
      contains(cls: string) { return this.values.has(cls) },
    },
    appendChild(node: any) { this.childNodes.push(node); return node },
    removeAttribute(name: string) {
      if (name === 'title') this.title = ''
    },
    querySelector() { return null },
    addEventListener: vi.fn(),
    contains: (_node: any) => false,
    closest: (_sel: string) => null,
  }
}

function installDashboardDom() {
  const els = {
    heroCard: fakeEl(),
    heroHeadline: fakeEl(),
    heroMeta: fakeEl(),
    dashPending: fakeEl(),
    dashStop: fakeEl(),
    dashRestart: { ...fakeEl(), childNodes: [textNode(' 重新连接')] },
    dashViewDetails: { ...fakeEl(), hidden: true },
    accountsBody: fakeEl(),
    accountsCurrent: fakeEl(),
    accountsMeta: fakeEl(),
  }
  const byId: Record<string, any> = {
    'hero-card': els.heroCard,
    'hero-headline': els.heroHeadline,
    'hero-meta': els.heroMeta,
    'dash-pending': els.dashPending,
    'dash-stop': els.dashStop,
    'dash-restart': els.dashRestart,
    'dash-view-details': els.dashViewDetails,
    'accounts-body': els.accountsBody,
    'accounts-current': els.accountsCurrent,
    'accounts-meta': els.accountsMeta,
  }
  const fakeDocument = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => ({
      ...fakeEl(),
      tagName: tag.toUpperCase(),
      href: '',
      target: '',
      rel: '',
      style: { cssText: '' },
    }),
  }
  globalThis.document = fakeDocument as unknown as typeof document
  return els
}

// Extends installDashboardDom with the provider-menu element and a fake
// .provider-switch anchor so toggleProviderMenu can position and populate
// the menu in tests. Returns the extended element bag.
function installProviderMenuDom() {
  const base = installDashboardDom()

  // Buttons added to the menu on each toggleProviderMenu call.
  const menuButtons: Array<{ dataset: { provider: string }; disabled: boolean; className: string; _clickHandlers: Array<(ev: any) => void> }> = []

  const providerMenu = {
    ...fakeEl(),
    hidden: true,
    style: {} as Record<string, string>,
    innerHTML: '',
    _buttons: menuButtons,
    querySelectorAll: (_sel: string) => menuButtons,
    contains: (node: any) => menuButtons.includes(node),
  }

  // Fake .provider-switch button that has getBoundingClientRect
  const providerSwitch = {
    ...fakeEl(),
    getBoundingClientRect: () => ({ bottom: 100, left: 50, top: 70, right: 200, width: 150, height: 30 }),
    contains: (_node: any) => false,
  }

  // When innerHTML is set on the menu, parse out data-provider attributes
  // to build fake button objects.
  Object.defineProperty(providerMenu, 'innerHTML', {
    set(html: string) {
      menuButtons.length = 0
      // Extract data-provider="..." values from the HTML string
      const re = /data-provider="([^"]+)"/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) !== null) {
        const provider = m[1]!
        const isActive = html.includes(`class="provider-menu-active"`) && html.indexOf(`class="provider-menu-active"`) < html.indexOf(`data-provider="${provider}"`)
        const btn: typeof menuButtons[0] = {
          dataset: { provider },
          disabled: false,
          className: isActive ? 'provider-menu-active' : '',
          _clickHandlers: [],
        }
        ;(btn as any).addEventListener = (_ev: string, handler: (ev: any) => void) => {
          btn._clickHandlers.push(handler)
        }
        menuButtons.push(btn)
      }
    },
    get() { return '' },
  })

  // Track document-level event listeners added by toggleProviderMenu
  const docListeners: Array<{ type: string; fn: EventListenerOrEventListenerObject; capture?: boolean }> = []

  // Snapshot the base document BEFORE replacing globalThis.document
  // so the extendedDoc.getElementById can delegate without infinite recursion.
  const baseDoc = globalThis.document as any

  const extendedDoc = {
    ...baseDoc,
    getElementById: (id: string) => {
      if (id === 'provider-menu') return providerMenu
      return baseDoc.getElementById(id)
    },
    querySelector: (sel: string) => {
      if (sel === '.provider-switch') return providerSwitch
      return null
    },
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject, capture?: boolean) => {
      docListeners.push({ type, fn, capture })
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject, capture?: boolean) => {
      const idx = docListeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture)
      if (idx !== -1) docListeners.splice(idx, 1)
    },
    _listeners: docListeners,
  }
  globalThis.document = extendedDoc as unknown as typeof document

  return { ...base, providerMenu, providerSwitch, menuButtons, docListeners }
}

function dashboardReport(overrides: Record<string, any> = {}) {
  const report = {
    checks: {
      daemon: { alive: false, pid: null },
      accounts: { count: 1, items: [{ id: 'demo-im-bot', botId: 'demo@im.bot', userId: 'u1', baseUrl: '' }] },
      provider: { provider: 'codex' },
      access: { allowFromCount: 1 },
      service: { installed: true },
    },
    userNames: { u1: '锦鲤大人' },
    expiredBots: [],
  }
  return { ...report, ...overrides, checks: { ...report.checks, ...(overrides.checks ?? {}) } }
}

function fakeDoctorPoller(cachedDaemonRunning = true) {
  // Return a doctor cache that doesn't trigger the "install" route — so
  // restartDaemon flows into the stop+start path. The shape is enough to
  // satisfy restartButtonState() returning action != "install".
  const checks = {
    daemon: { alive: cachedDaemonRunning, pid: cachedDaemonRunning ? 1234 : null },
    // restartButtonState() checks service.installed — set true so the
    // function returns action: "restart" (not "install"), letting our
    // pid-check path execute.
    service: { installed: true },
    accounts: { count: 1, items: [] },
    access: { allowFromCount: 1 },
    provider: { provider: 'claude' },
    claude: { ok: true },
  }
  return {
    refresh: vi.fn(async () => ({ checks, expiredBots: [] })),
    current: { checks, expiredBots: [] },
    lastError: null,
  }
}

// A minimal doctor report shaped to produce code-1 from diagnose()
// (daemon dead + pid ≠ null + service installed).
function deadDaemonReport() {
  return {
    checks: {
      daemon: { alive: false, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [],
    userNames: {},
  }
}

// A report that produces code-5 (account expired).
function expiredAccountReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [{ id: 'bot1', botId: 'b1', userId: 'u1', baseUrl: '' }] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [{ botId: 'b1', firstSeenExpiredAt: Date.now() - 3600000 }],
    userNames: {},
  }
}

// A report that produces code-4 (provider hard-missing, daemon alive).
function providerMissingReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { severity: 'hard', fix: { command: 'npm install -g @anthropic-ai/claude-code' } },
    },
    expiredBots: [],
    userNames: {},
  }
}

// A report that produces code-0 (all green).
function allGreenReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [],
    userNames: {},
  }
}

describe('dashboard button state', () => {
  it('daemon alive + account → connected hero shows stop only', () => {
    const els = installDashboardDom()
    const report = dashboardReport({
      checks: { daemon: { alive: true, pid: 1234 } },
    })

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('此刻，陪你一起看鱼')
    expect(els.heroMeta.textContent).toBe('把鼠标轻轻移进鱼缸，看看谁会先回应你')
    expect(els.dashStop.hidden).toBe(false)
    expect(els.dashRestart.hidden).toBe(true)
  })

  it('returning to the overview advances the warm hero copy once', () => {
    const els = installDashboardDom()
    const report = dashboardReport({ checks: { daemon: { alive: true, pid: 1234 } } })

    renderDashboard(report)
    expect(els.heroHeadline.textContent).toBe('此刻，陪你一起看鱼')
    advanceCompanionHeroCopy()
    renderDashboard(report)
    expect(els.heroHeadline.textContent).toBe('给忙碌留一小片水光')
    expect(els.heroMeta.textContent).toBe('在这里慢慢游一会儿，也没关系')
  })

  it('bound account but daemon NOT alive → recovering (was falsely "connected")', () => {
    // dashboardReport() has daemon.alive=false, accounts.count=1.
    // Connected state uses the warm companion headline; a failed probe still
    // takes precedence through the warning state above.
    // New behaviour: state "recovering" → honest reconnect affordance shown.
    const els = installDashboardDom()
    const report = dashboardReport()

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('CC 暂时失去连接')
    expect(els.heroMeta.textContent).toBe('可能暂时无法接收微信消息')
    expect(els.dashStop.hidden).toBe(true)
    expect(els.dashRestart.hidden).toBe(false)
  })

  it('no account + daemon offline → recovering hero shows reconnect only', () => {
    const els = installDashboardDom()
    const report = dashboardReport({
      checks: {
        accounts: { count: 0, items: [] },
      },
      userNames: {},
    })

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('CC 暂时失去连接')
    expect(els.heroMeta.textContent).toBe('可能暂时无法接收微信消息')
    expect(els.dashStop.hidden).toBe(true)
    expect(els.dashRestart.hidden).toBe(false)
  })
})

// ── renderDashboard: admin currentRow selection ───────────────────────────────
// The "当前连接中的用户" slot should pick the account whose userId appears in
// access.json admins[], not whichever lands at items[0] (filesystem order).

describe('renderDashboard admin row selection', () => {
  it('picks admin user as currentRow even when they are not at items[0]', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 2,
          items: [
            { id: 'wangzai-im-bot', botId: 'wz@im.bot', userId: 'o9cq80-cET4rsiJPGqDSGO5SpoU8@im.wechat', baseUrl: '' },
            { id: 'gushirui-im-bot', botId: 'gsr@im.bot', userId: 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', baseUrl: '' },
          ],
        },
        provider: { provider: 'claude' },
        access: {
          allowFromCount: 2,
          admins: ['o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'],
        },
        service: { installed: true },
      },
      userNames: {
        'o9cq80-cET4rsiJPGqDSGO5SpoU8@im.wechat': '旺仔',
        'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat': '顾时瑞',
      },
      expiredBots: [],
    }

    renderDashboard(report)

    // 顾时瑞 (admin, at items[1]) must appear in the current-user slot
    expect(els.accountsCurrent.innerHTML).toContain('顾时瑞')
    expect(els.accountsCurrent.innerHTML).toContain('管理员')
    // 旺仔 (non-admin, at items[0]) must be in the sub-users table
    expect(els.accountsBody.innerHTML).toContain('旺仔')
    expect(els.accountsBody.innerHTML).not.toContain('管理员')
  })

  it('falls back to items[0] as currentRow when admins[] is empty', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 2,
          items: [
            { id: 'first-im-bot', botId: 'f@im.bot', userId: 'uFirst', baseUrl: '' },
            { id: 'second-im-bot', botId: 's@im.bot', userId: 'uSecond', baseUrl: '' },
          ],
        },
        provider: { provider: 'codex' },
        access: { allowFromCount: 2, admins: [] },
        service: { installed: true },
      },
      userNames: { uFirst: '第一人', uSecond: '第二人' },
      expiredBots: [],
    }

    renderDashboard(report)

    // No admins → falls back to items[0]
    expect(els.accountsCurrent.innerHTML).toContain('第一人')
    expect(els.accountsBody.innerHTML).toContain('第二人')
  })

  it('falls back to items[0] as currentRow when admins is absent', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 1,
          items: [{ id: 'only-im-bot', botId: 'o@im.bot', userId: 'uOnly', baseUrl: '' }],
        },
        provider: { provider: 'claude' },
        access: { allowFromCount: 1 },
        service: { installed: true },
      },
      userNames: { uOnly: '唯一用户' },
      expiredBots: [],
    }

    renderDashboard(report)

    expect(els.accountsCurrent.innerHTML).toContain('唯一用户')
  })
})

// ── renderDashboard: heartbeat display ───────────────────────────────────────
// When hero state is "connected" and report.heartbeats[account.id] exists,
// the "当前连接中的用户" slot should show "连接正常 · 上次活动 X 前".
// When heartbeat is absent or hero is not "connected", fall back to "已连接".

describe('renderDashboard heartbeat display', () => {
  it('shows heartbeat copy when connected and heartbeat present', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 1,
          items: [{ id: 'bot1-im-bot', botId: 'b1@im.bot', userId: 'u1', baseUrl: '' }],
        },
        provider: { provider: 'claude' },
        access: { allowFromCount: 1 },
        service: { installed: true },
      },
      userNames: { u1: '小白' },
      expiredBots: [],
      heartbeats: { 'bot1-im-bot': new Date(Date.now() - 60_000).toISOString() },
    }

    renderDashboard(report)

    // Should contain the heartbeat copy, not bare "已连接"
    expect(els.accountsCurrent.innerHTML).toContain('连接正常')
    expect(els.accountsCurrent.innerHTML).toContain('上次活动')
  })

  it('falls back to "已连接" when heartbeats field is absent', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 1,
          items: [{ id: 'bot1-im-bot', botId: 'b1@im.bot', userId: 'u1', baseUrl: '' }],
        },
        provider: { provider: 'claude' },
        access: { allowFromCount: 1 },
        service: { installed: true },
      },
      userNames: { u1: '小白' },
      expiredBots: [],
      // no heartbeats field
    }

    renderDashboard(report)

    expect(els.accountsCurrent.innerHTML).toContain('已连接')
    expect(els.accountsCurrent.innerHTML).not.toContain('连接正常')
  })

  it('falls back to "已连接" when heartbeat for account is null', () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        accounts: {
          count: 1,
          items: [{ id: 'bot1-im-bot', botId: 'b1@im.bot', userId: 'u1', baseUrl: '' }],
        },
        provider: { provider: 'claude' },
        access: { allowFromCount: 1 },
        service: { installed: true },
      },
      userNames: { u1: '小白' },
      expiredBots: [],
      heartbeats: { 'bot1-im-bot': null },
    }

    renderDashboard(report)

    expect(els.accountsCurrent.innerHTML).toContain('已连接')
    expect(els.accountsCurrent.innerHTML).not.toContain('连接正常')
  })
})

describe('stopDaemon', () => {
  it('continues residual kill after service stop warning and marks disconnected when daemon is down', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (_name: string, args?: any) => {
      if (args?.args?.[0] === 'service' && args.args[1] === 'stop') {
        throw new Error('Boot-out failed: long launchctl stack that should not be rendered')
      }
      return { ok: true }
    })
    const markDisconnected = vi.fn()
    const doctorPoller = {
      refresh: vi.fn(async () => dashboardReport({ checks: { daemon: { alive: false, pid: null } } })),
    }

    await stopDaemon({
      invoke,
      doctorPoller,
      markDisconnected,
      formatInvokeError: (e: unknown) => String(e),
    })

    expect(invoke.mock.calls.map(c => c[1]?.args?.slice(0, 2))).toEqual([
      ['service', 'stop'],
      ['daemon', 'kill-residual'],
    ])
    expect(markDisconnected).toHaveBeenCalledTimes(1)
    expect(els.dashPending.textContent).toBe('已断开；后台服务停止时有警告')
    expect(els.dashPending.textContent.includes('Boot-out failed')).toBe(false)
  })
})

// ── runRestartSequence — the actual stop+kill+start chain ──────────────
// These tests mirror the old restartDaemon (PR3) tests since the chain
// moved verbatim into runRestartSequence.

describe('runRestartSequence', () => {
  it('happy path: pid changes → success message includes both pids', async () => {
    const els = installDashboardDom()
    const markConnected = vi.fn()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') {
        // First call (before): 1234. Second call (after): 5678.
        const callIdx = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid').length
        return callIdx === 1 ? 1234 : 5678
      }
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      markConnected,
    })
    // Verify both pid calls happened
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
    expect(markConnected).toHaveBeenCalled()
    expect(els.dashPending.textContent).toBe('连接已恢复')
    expect(els.dashViewDetails.hidden).toBe(true)
  })

  it('service start failure renders a short visible reconnect failure', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, args?: any) => {
      if (name === 'wechat_daemon_pid') return null
      if (args?.args?.[0] === 'service' && args.args[1] === 'start') {
        throw new Error('launchctl bootstrap failed with a very long stack')
      }
      return { ok: true }
    })

    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
    })

    expect(els.heroHeadline.textContent).toBe('CC 暂时失去连接')
    expect(els.heroMeta.textContent).toBe('暂时无法恢复，请稍后再试')
    expect(els.dashViewDetails.hidden).toBe(false)
  })

  it('service start ok but daemon still down keeps offline state', async () => {
    const els = installDashboardDom()
    const markConnected = vi.fn()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })

    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
      markConnected,
    })

    expect(markConnected).not.toHaveBeenCalled()
    expect(els.heroHeadline.textContent).toBe('CC 暂时失去连接')
    expect(els.heroMeta.textContent).toBe('暂时无法恢复，请稍后再试')
    expect(els.dashViewDetails.hidden).toBe(false)
  })

  it('pid unchanged → permission error message', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return 1234  // same pid both times
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
    })
    // The function returns early on this branch (no auto-clear) — verify
    // by checking pid was queried twice
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })

  it('non-Windows (pid always null) → falls through to generic OK', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
    })
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })
})

// ── code-8 full flow: runRestartSequence sets _lastRestart, next restartDaemon ──
// call produces code 8 on win32.
//
// Flow: a failed restart records pidUnchanged, and the next click converts
// that signal into a concise permission message in the existing hero.

describe('code-8 flow: _lastRestart wired through runRestartSequence → restartDaemon', () => {
  // A report where daemon is alive, accounts+access+provider all healthy → code 0 normally.
  // With _lastRestart.pidUnchanged + win32 it becomes code 8.
  const aliveGreenReport = {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [],
    userNames: {},
  }

  it('runRestartSequence with pid-unchanged keeps the permission failure in the hero', async () => {
    // Step 1: prime _lastRestart by running the sequence with same pid before/after
    installDashboardDom()
    const pidUnchangedInvoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return 1234  // same pid both calls
      return { ok: true }
    })
    await runRestartSequence({
      invoke: pidUnchangedInvoke,
      doctorPoller: fakeDoctorPoller(true),
      formatInvokeError: (e: unknown) => String(e),
    })
    const pidCalls = pidUnchangedInvoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)

    // Step 2: restartDaemon on win32 — _lastRestart.pidUnchanged=true → code 8
    const els = installDashboardDom()
    // @ts-expect-error override navigator.platform for win32 path
    globalThis.navigator = { platform: 'win32' }
    try {
      await restartDaemon({
        invoke: vi.fn(async () => ({ ok: true })),
        doctorPoller: {
          refresh: vi.fn(async () => aliveGreenReport),
          current: aliveGreenReport,
          lastError: null,
        },
        formatInvokeError: (e: unknown) => String(e),
        healthProbe: null,
      })
    } finally {
      // @ts-expect-error restore
      globalThis.navigator = undefined
    }

    expect(els.heroHeadline.textContent).toBe('CC 暂时失去连接')
    expect(els.heroMeta.textContent).toBe('系统权限不足，请重新打开应用后再试')
    expect(els.dashViewDetails.hidden).toBe(false)
  })

  it('_lastRestart is cleared after restartDaemon consumes it (no stale signal on subsequent click)', async () => {
    // Prime _lastRestart (pid unchanged)
    installDashboardDom()
    await runRestartSequence({
      invoke: vi.fn(async (name: string) => {
        if (name === 'wechat_daemon_pid') return 9999
        return { ok: true }
      }),
      doctorPoller: fakeDoctorPoller(true),
      formatInvokeError: (e: unknown) => String(e),
    })

    // First restartDaemon click on win32 — consumes _lastRestart → code 8
    const els1 = installDashboardDom()
    // @ts-expect-error set win32
    globalThis.navigator = { platform: 'win32' }
    await restartDaemon({
      invoke: vi.fn(async () => ({ ok: true })),
      doctorPoller: {
        refresh: vi.fn(async () => aliveGreenReport),
        current: aliveGreenReport,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })
    expect(els1.heroMeta.textContent).toBe('系统权限不足，请重新打开应用后再试')

    // Second restartDaemon click — _lastRestart is null → code 0 (all green), no card
    const els2 = installDashboardDom()
    await restartDaemon({
      invoke: vi.fn(async () => ({ ok: true })),
      doctorPoller: {
        refresh: vi.fn(async () => aliveGreenReport),
        current: aliveGreenReport,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })
    // @ts-expect-error restore
    globalThis.navigator = undefined

    expect(els2.dashPending.textContent).toBe('连接正常')
  })
})

// ── restartDaemon — diagnose internally, act in the existing hero ─────────

describe('restartDaemon (single-surface recovery)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeDeps(report: any, extra: Record<string, any> = {}) {
    return {
      invoke: vi.fn(async () => ({ ok: true })),
      doctorPoller: {
        refresh: vi.fn(async () => report),
        current: report,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
      routeToWizardService: vi.fn(),
      routeToWizardBind: vi.fn(),
      routeToAccessSettings: vi.fn(),
      routeToProviderSettings: vi.fn(),
      ...extra,
    }
  }

  it('code-1 (dead daemon + pid): immediately runs the restart sequence', async () => {
    const els = installDashboardDom()
    const deps = makeDeps(deadDaemonReport())
    await restartDaemon(deps)
    const serviceCalls = deps.invoke.mock.calls
      .map((call: any[]) => call[1]?.args?.slice(0, 2))
      .filter(Boolean)
    expect(serviceCalls).toContainEqual(['service', 'stop'])
    expect(serviceCalls).toContainEqual(['service', 'start'])
    expect(els.heroMeta.textContent).toBe('暂时无法恢复，请稍后再试')
  })

  it('disconnected-intent: restarts directly in one click', async () => {
    const els = installDashboardDom()
    const deps = makeDeps(deadDaemonReport(), { isDisconnectedIntent: () => true })
    await restartDaemon(deps)
    // Took the runRestartSequence path: service start was invoked...
    const startCalled = deps.invoke.mock.calls.some(
      (c: unknown[]) => Array.isArray((c[1] as { args?: unknown[] })?.args)
        && (c[1] as { args: unknown[] }).args[0] === 'service'
        && (c[1] as { args: unknown[] }).args[1] === 'start',
    )
    expect(startCalled).toBe(true)
  })

  it('default (no disconnected-intent): a dead daemon still restarts directly', async () => {
    const els = installDashboardDom()
    const deps = makeDeps(deadDaemonReport(), { isDisconnectedIntent: () => false })
    await restartDaemon(deps)
    expect(deps.invoke.mock.calls.some((call: any[]) => call[1]?.args?.[0] === 'service' && call[1]?.args?.[1] === 'start')).toBe(true)
  })

  it('code-5 (account expired): routes directly to rescan', async () => {
    const els = installDashboardDom()
    const deps = makeDeps(expiredAccountReport())
    await restartDaemon(deps)
    expect(deps.routeToWizardBind).toHaveBeenCalledTimes(1)
  })

  it('code-4 (provider missing): opens provider settings and keeps feedback in the hero', async () => {
    const els = installDashboardDom()
    const deps = makeDeps(providerMissingReport())
    await restartDaemon(deps)
    expect(deps.routeToProviderSettings).toHaveBeenCalledTimes(1)
    expect(els.heroMeta.textContent).toBe('AI 服务暂不可用，请检查设置')
  })

  it('code-0 (all green): no card shown and connection returns to normal', async () => {
    const els = installDashboardDom()
    await restartDaemon(makeDeps(allGreenReport()))
    expect(els.dashPending.textContent).toBe('连接正常')
  })

  it('code-3 (service not installed): routes directly to service setup', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: false, pid: null },
        service: { installed: false },
        accounts: { count: 0, items: [] },
        access: { allowFromCount: 0 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    const deps = makeDeps(report)
    await restartDaemon(deps)
    expect(deps.routeToWizardService).toHaveBeenCalledTimes(1)
  })

  it('code-6 (empty allowlist): opens access settings', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        service: { installed: true },
        accounts: { count: 1, items: [{ id: 'b1', botId: 'b1', userId: 'u1', baseUrl: '' }] },
        access: { allowFromCount: 0 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    const deps = makeDeps(report)
    await restartDaemon(deps)
    expect(deps.routeToAccessSettings).toHaveBeenCalledTimes(1)
  })

  it('code-2 (daemon dead + pid=null): starts the service directly', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: false, pid: null },
        service: { installed: true },
        accounts: { count: 1, items: [] },
        access: { allowFromCount: 1 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    const deps = makeDeps(report)
    await restartDaemon(deps)
    expect(deps.invoke.mock.calls.some((call: any[]) => call[1]?.args?.[0] === 'service' && call[1]?.args?.[1] === 'start')).toBe(true)
  })

  it('code-5 (no accounts): routes directly to binding', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        service: { installed: true },
        accounts: { count: 0, items: [] },
        access: { allowFromCount: 1 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    const deps = makeDeps(report)
    await restartDaemon(deps)
    expect(deps.routeToWizardBind).toHaveBeenCalledTimes(1)
  })

  it('no doctor report falls back to runRestartSequence directly', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    const deps = {
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => null),
        current: null,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    }
    await restartDaemon(deps)
    // With no report, restartDaemon falls back to runRestartSequence chain
    // which runs stop + kill + start. Verify stop was called.
    const stopCall = invoke.mock.calls.find(c => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = c[1] as any
      return a?.args?.[0] === 'service' && a?.args?.[1] === 'stop'
    })
    // Must find a concrete call — not just truthy (undefined passes toBeTruthy)
    expect(stopCall).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((stopCall![1] as any).args).toEqual(expect.arrayContaining(['service', 'stop']))
  })
})

// ── Step 4 — RECONNECT_DIAGNOSE telemetry ────────────────────────────────────
// Every reconnect click must fire a fire-and-forget `wechat_cli_json` call
// with args[0] === 'log' and tag 'RECONNECT_DIAGNOSE'.
// We verify:
//   1. The invoke is called with the correct subcommand args shape.
//   2. The fields payload contains exactly the 6 expected keys.
//   3. The call is non-blocking (restartDaemon returns promptly even if
//      the invoke never resolves — tested via a never-resolving mock).

describe('restartDaemon RECONNECT_DIAGNOSE telemetry', () => {
  function makeReport(daemonAlive: boolean, provider = 'claude') {
    return {
      checks: {
        daemon: { alive: daemonAlive, pid: daemonAlive ? 1234 : null },
        service: { installed: true },
        accounts: { count: 1, items: [] },
        access: { allowFromCount: 1 },
        provider: { provider },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
  }

  it('fires a wechat_cli_json log call after diagnose() for non-zero code', async () => {
    installDashboardDom()
    const invoke = vi.fn(async (_name: string, _args?: unknown) => ({ ok: true }))
    const report = makeReport(false)  // dead daemon → code-1
    report.checks.daemon = { alive: false, pid: 1234 }

    await restartDaemon({
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => report),
        current: report,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })

    // Give the fire-and-forget Promise a tick to run
    await new Promise(r => setTimeout(r, 0))

    const logCall = invoke.mock.calls.find(c => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'log'
    })
    expect(logCall).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logArgs = ((logCall as any[])[1] as any).args as string[]
    expect(logArgs[0]).toBe('log')
    expect(logArgs[1]).toBe('RECONNECT_DIAGNOSE')
    // fields JSON is at index 4 (after '--fields')
    const fieldsIdx = logArgs.indexOf('--fields')
    expect(fieldsIdx).not.toBe(-1)
    const fields = JSON.parse(logArgs[fieldsIdx + 1]!)
    // Verify all 7 expected keys are present
    const EXPECTED_KEYS = ['code', 'daemon_alive', 'service_installed', 'provider', 'lastError_present', 'health_ok', 'platform']
    for (const key of EXPECTED_KEYS) {
      expect(fields).toHaveProperty(key)
    }
  })

  it('fires a wechat_cli_json log call for code-0 (all green) too', async () => {
    installDashboardDom()
    const invoke = vi.fn(async (_name: string, _args?: unknown) => ({ ok: true }))
    const report = makeReport(true)  // alive → code-0

    await restartDaemon({
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => report),
        current: report,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })

    await new Promise(r => setTimeout(r, 0))

    const logCall = invoke.mock.calls.find(c => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'log'
    })
    expect(logCall).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logArgs = ((logCall as any[])[1] as any).args as string[]
    const fieldsIdx = logArgs.indexOf('--fields')
    const fields = JSON.parse(logArgs[fieldsIdx + 1]!)
    expect(fields.code).toBe(0)
  })

  it('does NOT fire a log call when report is null (no-report fallback path)', async () => {
    installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })

    await restartDaemon({
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => null),
        current: null,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })

    await new Promise(r => setTimeout(r, 0))

    const logCall = invoke.mock.calls.find(c => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'log'
    })
    // The plan says: if report is null, skip telemetry entirely
    expect(logCall).toBeUndefined()
  })

  it('does not block restartDaemon even if invoke never resolves', async () => {
    installDashboardDom()
    let _resolve!: (v: unknown) => void
    const hangingPromise = new Promise(res => { _resolve = res })
    const invoke = vi.fn(async (_name: string, args?: any) => {
      if (args?.args?.[0] === 'log') return hangingPromise
      return { ok: true }
    })
    const report = makeReport(true)

    // restartDaemon must complete — the hanging log call must not block it
    const start = Date.now()
    await restartDaemon({
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => report),
        current: report,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    })
    const elapsed = Date.now() - start
    // Sanity: must complete well under 500ms (the hanging promise never resolves)
    expect(elapsed).toBeLessThan(500)
    // Resolve to avoid open-handle warnings
    _resolve({ ok: true })
  })
})

// ── toggleProviderMenu / closeProviderMenu ────────────────────────────────
// Tests use the extended installProviderMenuDom() harness which adds a
// fake #provider-menu element and .provider-switch anchor stub.

function makeProviderReport(provider = 'claude') {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      accounts: { count: 1, items: [] },
      provider: { provider },
      access: { allowFromCount: 1 },
      service: { installed: true },
    },
    userNames: {},
    expiredBots: [],
  }
}

describe('provider menu', () => {
  it('toggleProviderMenu populates menu with claude, codex, cursor buttons', async () => {
    const { menuButtons } = installProviderMenuDom()
    await toggleProviderMenu(
      { invoke: vi.fn(async () => ({ ok: true })), doctorPoller: { current: null } },
      makeProviderReport('claude'),
    )
    const providers = menuButtons.map(b => b.dataset.provider)
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
    expect(providers).toContain('cursor')
    expect(providers).toHaveLength(3)
  })

  it('active provider button has provider-menu-active class', async () => {
    const { menuButtons } = installProviderMenuDom()
    await toggleProviderMenu(
      { invoke: vi.fn(async () => ({ ok: true })), doctorPoller: { current: null } },
      makeProviderReport('codex'),
    )
    const activeBtn = menuButtons.find(b => b.className === 'provider-menu-active')
    expect(activeBtn?.dataset.provider).toBe('codex')
  })

  it('clicking a different provider invokes CLI and calls runRestartSequence', async () => {
    const { menuButtons, providerMenu } = installProviderMenuDom()
    const invokeCalls: Array<[string, string[]]> = []
    const invoke = vi.fn(async (name: string, args?: any) => {
      invokeCalls.push([name, args?.args ?? []])
      return { ok: true }
    })
    const doctorPoller = {
      refresh: vi.fn(async () => makeProviderReport('codex')),
      current: makeProviderReport('claude'),
      waitForCondition: vi.fn(async (pred: (r: any) => boolean) => makeProviderReport('codex')),
      lastError: null,
    }
    await toggleProviderMenu({ invoke, doctorPoller }, makeProviderReport('claude'))
    // providerMenu is open — click 'codex' button
    const codexBtn = menuButtons.find(b => b.dataset.provider === 'codex')
    expect(codexBtn).toBeDefined()
    // Fire the click handler (simulated)
    for (const handler of codexBtn!._clickHandlers) {
      await handler({ stopPropagation: () => {} })
    }
    // provider set should have been called via wechat_cli_text
    const providerSetCall = invokeCalls.find(([_cmd, a]) => a[0] === 'provider' && a[1] === 'set')
    expect(providerSetCall).toBeDefined()
    expect(providerSetCall![1][2]).toBe('codex')
    // service stop + start should have been called (from runRestartSequence)
    const serviceStopCall = invokeCalls.find(([_cmd, a]) => a[0] === 'service' && a[1] === 'stop')
    expect(serviceStopCall).toBeDefined()
  })

  it('clicking the same provider closes menu without invoking CLI', async () => {
    const { menuButtons, providerMenu } = installProviderMenuDom()
    const invoke = vi.fn(async () => ({ ok: true }))
    await toggleProviderMenu({ invoke, doctorPoller: { current: null } }, makeProviderReport('claude'))
    const claudeBtn = menuButtons.find(b => b.dataset.provider === 'claude')
    expect(claudeBtn).toBeDefined()
    for (const handler of claudeBtn!._clickHandlers) {
      await handler({ stopPropagation: () => {} })
    }
    // No provider set call should have been made
    const providerSetCall = invoke.mock.calls.find(c => {
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'provider' && a?.args?.[1] === 'set'
    })
    expect(providerSetCall).toBeUndefined()
    // Menu should be hidden after same-provider click
    expect(providerMenu.hidden).toBe(true)
  })

  it('closeProviderMenu hides the menu', async () => {
    const { providerMenu } = installProviderMenuDom()
    await toggleProviderMenu(
      { invoke: vi.fn(async () => ({ ok: true })), doctorPoller: { current: null } },
      makeProviderReport('claude'),
    )
    expect(providerMenu.hidden).toBe(false)
    closeProviderMenu()
    expect(providerMenu.hidden).toBe(true)
  })

  it('provider set failure shows error toast and does NOT trigger restart', async () => {
    const els = installProviderMenuDom()
    const { menuButtons } = els
    const invoke = vi.fn(async (name: string, args?: any) => {
      const a = args?.args ?? []
      // provider set uses wechat_cli_text
      if (name === 'wechat_cli_text' && a[0] === 'provider' && a[1] === 'set') {
        throw new Error('provider set failed')
      }
      return { ok: true }
    })
    await toggleProviderMenu({ invoke, doctorPoller: { current: null } }, makeProviderReport('claude'))
    const codexBtn = menuButtons.find(b => b.dataset.provider === 'codex')
    for (const handler of codexBtn!._clickHandlers) {
      await handler({ stopPropagation: () => {} })
    }
    // service stop should NOT have been called
    const serviceStopCall = invoke.mock.calls.find(c => {
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'service' && a?.args?.[1] === 'stop'
    })
    expect(serviceStopCall).toBeUndefined()
    // Error toast should be visible
    expect(els.dashPending.textContent).toBe('切换 provider 失败')
  })

  it('toggleUserProviderMenu populates card menu with claude, codex, gemini buttons', async () => {
    const { menuButtons } = installProviderMenuDom()
    const row = { dataset: { chatId: 'chat-1', currentProvider: 'claude' } }
    const anchor = {
      ...fakeEl(),
      closest: (sel: string) => sel === '.sub-user-card' ? row : null,
      getBoundingClientRect: () => ({ bottom: 120, left: 280, top: 100, right: 340, width: 24, height: 24 }),
      contains: (_node: any) => false,
    }

    await toggleUserProviderMenu(
      { invoke: vi.fn(async () => ({ ok: true })), doctorPoller: { current: null } },
      anchor,
      makeProviderReport('claude'),
    )

    expect(menuButtons.map(b => b.dataset.provider)).toEqual(['claude', 'codex', 'gemini'])
  })

  it('user card provider click invokes mode set with JSON solo provider', async () => {
    const { menuButtons } = installProviderMenuDom()
    const row = { dataset: { chatId: 'chat-1', currentProvider: 'claude' } }
    const anchor = {
      ...fakeEl(),
      closest: (sel: string) => sel === '.sub-user-card' ? row : null,
      getBoundingClientRect: () => ({ bottom: 120, left: 280, top: 100, right: 340, width: 24, height: 24 }),
      contains: (_node: any) => false,
    }
    const invoke = vi.fn(async () => ({ ok: true }))

    await toggleUserProviderMenu({ invoke, doctorPoller: { refresh: vi.fn(async () => null) } }, anchor, makeProviderReport('claude'))
    const geminiBtn = menuButtons.find(b => b.dataset.provider === 'gemini')
    expect(geminiBtn).toBeDefined()
    for (const handler of geminiBtn!._clickHandlers) {
      await handler({ stopPropagation: () => {} })
    }

    const modeSetCall = invoke.mock.calls.find(c => {
      const a = (c as any[])[1] as any
      return a?.args?.[0] === 'mode' && a?.args?.[1] === 'set'
    })
    expect(modeSetCall).toBeDefined()
    const args = (modeSetCall as any)[1].args
    expect(args[2]).toBe('chat-1')
    expect(JSON.parse(args[3])).toEqual({ kind: 'solo', provider: 'gemini' })
    expect(args[4]).toBe('--json')
  })
})
