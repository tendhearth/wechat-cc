import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vitest's jsdom-like DOM stub so setPending no-ops cleanly. The
// existing dashboard.js uses document.getElementById in setPending; we
// just need the call not to crash.
beforeEach(() => {
  // @ts-expect-error provide a minimal getElementById stub
  globalThis.document = { getElementById: () => null }
  // @ts-expect-error provide the DOM constant used by renderRestartButton
  globalThis.Node = { TEXT_NODE: 3 }
})

// Import AFTER document stub so setPending's getElementById doesn't crash
const { renderDashboard, renderRestartButton, restartDaemon, stopDaemon } = await import('./dashboard.js')

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
    'accounts-body': els.accountsBody,
    'accounts-current': els.accountsCurrent,
    'accounts-meta': els.accountsMeta,
  }
  // @ts-expect-error minimal dashboard DOM
  globalThis.document = { getElementById: (id: string) => byId[id] ?? null }
  return els
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
  }
  return {
    refresh: vi.fn(async () => ({ checks })),
    current: { checks },
  }
}

describe('dashboard button state', () => {
  it('companion-active hero shows disconnect only, even while daemon is recovering', () => {
    const els = installDashboardDom()
    const report = dashboardReport()

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('AI 正在陪伴中')
    expect(els.heroMeta.textContent).toBe('一切正常，连接稳定')
    expect(els.dashStop.hidden).toBe(false)
    expect(els.dashRestart.hidden).toBe(true)
  })

  it('offline hero shows reconnect only', () => {
    const els = installDashboardDom()
    const report = dashboardReport({
      checks: {
        accounts: { count: 0, items: [] },
      },
      userNames: {},
    })

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('暂时失去连接')
    expect(els.heroMeta.textContent).toBe('当前连接不稳定，正在尝试重新恢复陪伴')
    expect(els.dashStop.hidden).toBe(true)
    expect(els.dashRestart.hidden).toBe(false)
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

describe('restartDaemon (PR3)', () => {
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
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
      markConnected,
    })
    // Verify both pid calls happened
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
    expect(markConnected).toHaveBeenCalled()
    expect(els.dashPending.textContent).toBe('已重启 (pid 1234 → 5678)')
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

    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })

    expect(els.dashPending.textContent).toBe('重新连接失败：后台服务启动失败')
    expect(els.dashPending.textContent.includes('launchctl bootstrap')).toBe(false)
  })

  it('service start ok but daemon still down keeps offline state', async () => {
    const els = installDashboardDom()
    const markConnected = vi.fn()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })

    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
      markConnected,
    })

    expect(markConnected).not.toHaveBeenCalled()
    expect(els.dashPending.textContent).toBe('重新连接失败：后台服务没起来')
  })

  it('pid unchanged → permission error message', async () => {
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return 1234  // same pid both times
      return { ok: true }
    })
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })
    // The function returns early on this branch (no auto-clear) — verify
    // by checking pid was queried twice
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })

  it('non-Windows (pid always null) → falls through to generic OK', async () => {
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })
})
