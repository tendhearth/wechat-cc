import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../view.js', () => ({ escapeHtml: (s: string) => s, formatRelativeTime: () => '' }))
vi.mock('./observations.js', () => ({ observationRow: () => '', milestoneCard: () => '' }))
vi.mock('./decisions.js', () => ({ decisionRow: () => '' }))
vi.mock('./icons.js', () => ({ icon: () => '' }))

beforeEach(() => {
  // @ts-expect-error minimal getElementById stub before import
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }
  // @ts-expect-error bare localStorage stub
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  // @ts-expect-error bare window stub (module-level resize listener)
  globalThis.window = { addEventListener: () => {} }
})

const {
  synthesizeMemory,
  generateMemoryProfile,
} = await import('./memory.js')

function fakeEl() {
  return {
    textContent: '', innerHTML: '', hidden: true, disabled: false, dataset: {} as Record<string, string>,
  }
}

/** Bare deps stub — invoke/invokeApi mocked per-test, other deps no-ops. */
function makeDeps(overrides: Record<string, any> = {}) {
  return {
    invoke: vi.fn(),
    invokeApi: vi.fn(),
    formatInvokeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    doctorPoller: { current: null },
    ...overrides,
  }
}

describe('synthesizeMemory', () => {
  it('calls invokeApi POST /v1/memory/synthesize with a 60s timeout, not the sidecar', async () => {
    const statusEl = fakeEl()
    ;(globalThis as any).document.getElementById = (id: string) => (id === 'memory-status' ? statusEl : null)
    const deps = makeDeps({
      invokeApi: vi.fn().mockResolvedValue({ ok: true, written: { path: '_overview.md', bytesWritten: 42 }, projectsFound: 3 }),
    })
    const result = await synthesizeMemory(deps as any)
    expect(deps.invokeApi).toHaveBeenCalledWith('POST', '/v1/memory/synthesize', undefined, { timeoutMs: 60_000 })
    expect(deps.invoke).not.toHaveBeenCalledWith('wechat_cli_json', expect.objectContaining({ args: expect.arrayContaining(['synthesize']) }))
    expect((result as any).written.bytesWritten).toBe(42)
  })

  it('memory_not_wired (daemon down / not wired) surfaces the daemon-required copy without crashing', async () => {
    const statusEl = fakeEl()
    ;(globalThis as any).document.getElementById = (id: string) => (id === 'memory-status' ? statusEl : null)
    const deps = makeDeps({
      invokeApi: vi.fn().mockRejectedValue(new Error('memory_not_wired')),
    })
    await expect(synthesizeMemory(deps as any)).rejects.toThrow('需要守护进程运行后才能重新整理记忆')
    expect(statusEl.textContent).toContain('需要守护进程运行后才能重新整理记忆')
    expect(statusEl.hidden).toBe(false)
  })

  it('daemon 掉线的真实 fetch 错误(TimeoutError / 连接拒绝)也认作 daemon-required', async () => {
    for (const err of [
      Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
      new Error('Unable to connect. Is the computer able to access the url?'),
    ]) {
      const statusEl = fakeEl()
      ;(globalThis as any).document.getElementById = (id: string) => (id === 'memory-status' ? statusEl : null)
      const deps = makeDeps({ invokeApi: vi.fn().mockRejectedValue(err) })
      await expect(synthesizeMemory(deps as any)).rejects.toThrow('需要守护进程运行后才能重新整理记忆')
      expect(statusEl.textContent).toContain('需要守护进程运行后才能重新整理记忆')
    }
  })
})

describe('generateMemoryProfile', () => {
  it('calls invokeApi POST /v1/memory/profile/generate with chat_id, not the sidecar', async () => {
    const statusEl = fakeEl()
    ;(globalThis as any).document.getElementById = (id: string) => (id === 'memory-status' ? statusEl : null)
    const deps = makeDeps({
      // loadMemoryPane (via currentChatId) reads `memory list` through deps.invoke,
      // then refreshMemoryProfileStatus also goes through deps.invoke — both stay
      // on the sidecar (pure IO, out of scope for this task).
      invoke: vi.fn().mockImplementation((_cmd: string, args: { args: string[] }) => {
        const sub = args.args
        if (sub[0] === 'memory' && sub[1] === 'list') {
          return Promise.resolve([{ userId: 'chat123@im.wechat', fileCount: 1, files: [] }])
        }
        if (sub[0] === 'memory' && sub[1] === 'profile' && sub[1 + 1] === 'status') {
          return Promise.resolve({ ok: true, status: 'ready', canGenerate: true, reason: 'ok' })
        }
        return Promise.resolve({ ok: true })
      }),
      invokeApi: vi.fn().mockResolvedValue({ ok: true, written: { path: '_profile.json', bytesWritten: 10 }, projectsFound: 1 }),
    })
    const result = await generateMemoryProfile(deps as any)
    expect(deps.invokeApi).toHaveBeenCalledWith('POST', '/v1/memory/profile/generate', { chat_id: 'chat123@im.wechat' })
    expect((result as any).written.bytesWritten).toBe(10)
  })

  it('memory_not_wired surfaces the daemon-required copy without crashing', async () => {
    const statusEl = fakeEl()
    ;(globalThis as any).document.getElementById = (id: string) => (id === 'memory-status' ? statusEl : null)
    const deps = makeDeps({
      invoke: vi.fn().mockImplementation((_cmd: string, args: { args: string[] }) => {
        const sub = args.args
        if (sub[0] === 'memory' && sub[1] === 'list') {
          return Promise.resolve([{ userId: 'chat123@im.wechat', fileCount: 1, files: [] }])
        }
        if (sub[0] === 'memory' && sub[1] === 'profile' && sub[1 + 1] === 'status') {
          return Promise.resolve({ ok: true, status: 'ready', canGenerate: true, reason: 'ok' })
        }
        return Promise.resolve({ ok: true })
      }),
      invokeApi: vi.fn().mockRejectedValue(new Error('memory_not_wired')),
    })
    await expect(generateMemoryProfile(deps as any)).rejects.toThrow('需要守护进程运行后才能刷新画像')
    expect(statusEl.textContent).toContain('需要守护进程运行后才能刷新画像')
  })
})
