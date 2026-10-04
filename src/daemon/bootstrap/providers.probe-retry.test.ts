/**
 * 开机探测一时失败 ⇒ 退避重探,通过就注册(2026-10-04)。
 *
 * 真机事故:self deploy 之后那次开机,agy 的 `--version` 探测撞上事件循环被开机的其他活
 * 卡住,判了超时,agy 一直掉线到下一次重启;主人钉在 agy 上的 cheapEval 静默落到别家。
 * 同一次开机 cursor-agent 也掉了,被那句 `CURSOR_API_KEY not set` 盖住。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProviders, type ProviderDeps } from './providers'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../core/conversation-store'
import type { AgentConfig } from '../../lib/agent-config'
import type { VersionProbeResult } from './provider-probe'

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false, ...overrides }
}

function makeDeps(overrides: Partial<ProviderDeps> = {}): { deps: ProviderDeps; logs: Array<[string, string]> } {
  const logs: Array<[string, string]> = []
  const deps = {
    log: (tag: string, line: string) => { logs.push([tag, line]) },
    stateDir: mkdtempSync(join(tmpdir(), 'providers-retry-state-')),
    ilink: { askUser: vi.fn(), companion: { status: () => ({ enabled: false }) } } as unknown as ProviderDeps['ilink'],
    configuredAgent: baseConfig(),
    permissionMode: 'strict',
    conversationStore: makeConversationStore(openTestDb()),
    sdkOptionsForProject: (() => ({})) as unknown as ProviderDeps['sdkOptionsForProject'],
    claudeBin: undefined,
    currentClaudeModel: () => 'claude-x',
    resolveAdminChatId: () => null,
    pluginMcp: {},
    wechatStdioForCodex: null,
    delegateStdioForCodex: null,
    wechatStdioForCursor: null,
    delegateStdioForCursor: null,
    wechatStdioForOpenai: null,
    delegateStdioForOpenai: null,
    wechatStdioForGemini: null,
    wechatStdioForAgy: null,
    turnTimeoutMs: 60_000,
    ...overrides,
  } as ProviderDeps
  return { deps, logs }
}

/** 手动计时器:排进来的重探由测试决定什么时候跑。 */
function manualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    queue,
    setTimer: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length },
    clearTimer: () => {},
    /** 跑最早排进来的那个,等到它要么排了下一次、要么结束(成功不再排)。 */
    async fireNext(isDone: () => boolean): Promise<number | null> {
      const next = queue.shift()
      if (!next) return null
      next.fn()
      await vi.waitFor(() => { if (queue.length === 0 && !isDone()) throw new Error('attempt still running') })
      return next.ms
    },
  }
}

const fail = (detail: string): VersionProbeResult => ({ ok: false, reason: 'timeout', detail, ms: 5000 })
const okProbe: VersionProbeResult = { ok: true, firstLine: '1.0.0', ms: 5 }
/** 只对 `target` 按脚本回答;别的二进制(比如这台机器上真装着的 codex)一律通过 —— 不让它们吃掉脚本。 */
function probeScript(target: string, ...seq: VersionProbeResult[]) {
  const calls: string[] = []
  const fn = vi.fn(async (bin: string): Promise<VersionProbeResult> => {
    if (bin !== target) return okProbe
    calls.push(bin)
    return seq.length > 1 ? seq.shift()! : seq[0]!
  })
  return Object.assign(fn, { targetCalls: calls })
}

describe('registerProviders — 外部 CLI 探测失败后的退避重探', () => {
  it('agy 开机探测失败一次 ⇒ 不注册、日志带真实原因;第一次重探通过 ⇒ 注册上,不用重启', async () => {
    const timers = manualTimers()
    const probe = probeScript('/fake/bin/agy', fail('12034ms 内没退出(超时按 5000ms 计;其间事件循环被卡住约 11500ms(不计入超时))'), okProbe)
    const { deps, logs } = makeDeps({
      configuredAgent: baseConfig({ agyBin: '/fake/bin/agy' }),
      probeVersion: probe,
      probeRetry: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    })
    const { registry, providerProbes } = await registerProviders(deps)
    expect(registry.has('agy')).toBe(false)
    const bootLine = logs.find(([tag, line]) => tag === 'BOOT' && line.startsWith('agy:'))?.[1] ?? ''
    expect(bootLine).toContain('探测失败')
    expect(bootLine).toContain('事件循环被卡住')
    expect(bootLine).not.toContain('binary not found')
    expect(providerProbes()).toEqual([expect.objectContaining({ id: 'agy', state: 'retrying', attempts: 0 })])
    expect(timers.queue.map(q => q.ms)).toEqual([2_000])

    await timers.fireNext(() => registry.has('agy'))
    expect(registry.has('agy')).toBe(true)
    expect(providerProbes()).toEqual([expect.objectContaining({ id: 'agy', state: 'registered', attempts: 1 })])
    expect(timers.queue).toHaveLength(0)
    expect(probe.targetCalls).toHaveLength(2)
  })

  it('agyBin 指向一个不存在的文件(真探测、永远失败)⇒ 退避有界:一小时内最多 12 次,间隔指数增长后转 10 分钟', async () => {
    const timers = manualTimers()
    const missing = join(tmpdir(), `no-such-agy-${process.pid}-${Date.now()}`)
    const { deps } = makeDeps({
      configuredAgent: baseConfig({ agyBin: missing }),
      probeRetry: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    })
    const { registry, providerProbes } = await registerProviders(deps)
    expect(registry.has('agy')).toBe(false)
    const delays: number[] = []
    let elapsed = 0
    while (elapsed < 60 * 60_000) {
      const ms = await timers.fireNext(() => registry.has('agy'))
      if (ms === null) break
      delays.push(ms)
      elapsed += ms
    }
    expect(registry.has('agy')).toBe(false)
    expect(delays.slice(0, 6)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
    expect(delays.slice(6).every(d => d === 600_000)).toBe(true)
    const st = providerProbes()[0]!
    expect(st).toMatchObject({ id: 'agy', state: 'retrying' })
    expect(st.attempts).toBeLessThanOrEqual(12)
    expect(st.last_error).not.toBe('')
    expect(timers.queue.length).toBeLessThanOrEqual(1)
  })

  it.runIf(process.platform !== 'win32')('cursor-agent 探测失败(此前被 `CURSOR_API_KEY not set` 盖住)⇒ 日志说清楚,重探通过后注册 ACP 对话 provider', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      const timers = manualTimers()
      const probe = probeScript('/fake/bin/cursor-agent', fail('3001ms 内没退出'), okProbe)
      const { deps, logs } = makeDeps({
        configuredAgent: baseConfig({ cursorAgentBin: '/fake/bin/cursor-agent' }),
        probeVersion: probe,
        probeRetry: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
      })
      const { registry } = await registerProviders(deps)
      expect(registry.has('cursor')).toBe(false)
      expect(logs.some(([tag, line]) => tag === 'BOOT' && line.includes('cursor-agent --version 探测失败'))).toBe(true)
      await timers.fireNext(() => registry.has('cursor'))
      expect(registry.has('cursor')).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = prevKey
    }
  })

  it('测试 runner 下没给 probeRetry 接缝 ⇒ 不在背后排重探(单测里的 bootstrap 不起真 CLI)', async () => {
    const probe = probeScript('/fake/bin/agy', fail('x'))
    const { deps } = makeDeps({ configuredAgent: baseConfig({ agyBin: '/fake/bin/agy' }), probeVersion: probe })
    const { registry, providerProbes } = await registerProviders(deps)
    expect(registry.has('agy')).toBe(false)
    expect(providerProbes()).toEqual([])
  })

  it('stopProviderProbes() ⇒ 已排的重探不再跑', async () => {
    const queue: Array<{ fn: () => void; id: number }> = []
    let seq = 0
    const probe = probeScript('/fake/bin/agy', fail('x'), okProbe)
    const { deps } = makeDeps({
      configuredAgent: baseConfig({ agyBin: '/fake/bin/agy' }),
      probeVersion: probe,
      probeRetry: {
        setTimer: (fn) => { const id = ++seq; queue.push({ fn, id }); return id },
        clearTimer: (h) => { const i = queue.findIndex(q => q.id === h); if (i >= 0) queue.splice(i, 1) },
      },
    })
    const { registry, stopProviderProbes } = await registerProviders(deps)
    expect(queue).toHaveLength(1)
    stopProviderProbes()
    expect(queue).toHaveLength(0)
    expect(registry.has('agy')).toBe(false)
  })
})
