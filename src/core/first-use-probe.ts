/**
 * first-use-probe — 「先真跑一句再信」的 provider 包装。
 *
 * 为 codex 而生(2026-09-09 实测):SDK 0.144.4 驱动用户的 CLI 0.153.4 照样
 * 收到 agent_message,而内置的 0.144.4 二进制被 OpenAI 服务端以「这个模型
 * 需要更新的 Codex」400 拒掉。也就是说**版本号判不出能不能用,只有真跑
 * 一句才知道**;而且要跑就得用用户那个更新的 CLI。于是:
 *
 *  - 开机**不**外呼(主人纪律:网络不稳时的无人值守外呼是风控形状);
 *  - 第一次真要用到(spawn / cheapEval)时探一句「只回复 ok」,通了缓存,
 *    daemon 生命周期内不再探;
 *  - 探测失败 → 这次调用抛带人话的错(调用方转成给用户的提示),十分钟后
 *    允许再探(网络抖一下不该把这家钉死到重启)。
 *
 * 并发:多个调用同时撞上首次使用,共用同一个 in-flight promise,只探一次。
 */
import type { AgentProvider, AgentProject, AgentSession, SpawnContext } from './agent-provider'

export interface FirstUseProbeOpts {
  /** 跑一句探测,返回模型文本;抛错或空串都算失败。 */
  probe: () => Promise<string>
  /** 探测结果的人话摘要,给 /mode 和日志。 */
  onResult?: (r: { ok: boolean; detail: string; ms: number }) => void
  /** 失败时抛给调用方的信息(会原样进用户提示)。 */
  failureMessage: (detail: string) => string
  /** 失败后多久允许重探(默认 10 分钟)。 */
  retryAfterMs?: number
  /** 'all'(默认):spawn 和 cheapEval/strongEval 都先过探测;'spawn':只拦聊天
   *  回合 —— 给默认 provider 用,后台评估(开机就可能跑)不因探测多一次外呼。 */
  gate?: 'spawn' | 'all'
  now?: () => number
}

export interface ProbeStatus { state: 'untested' | 'probing' | 'ok' | 'failed'; detail?: string; at?: number }

export function withFirstUseProbe(inner: AgentProvider, opts: FirstUseProbeOpts): AgentProvider & { probeStatus(): ProbeStatus } {
  const now = opts.now ?? Date.now
  const retryAfter = opts.retryAfterMs ?? 10 * 60_000
  let status: ProbeStatus = { state: 'untested' }
  let inflight: Promise<void> | null = null

  const ensure = (): Promise<void> => {
    if (status.state === 'ok') return Promise.resolve()
    if (status.state === 'failed' && status.at !== undefined && now() - status.at < retryAfter) {
      return Promise.reject(new Error(opts.failureMessage(status.detail ?? 'probe failed')))
    }
    if (inflight) return inflight
    const started = now()
    status = { state: 'probing' }
    inflight = (async () => {
      let text = ''
      try {
        text = (await opts.probe()).trim()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        status = { state: 'failed', detail, at: now() }
        opts.onResult?.({ ok: false, detail, ms: now() - started })
        throw new Error(opts.failureMessage(detail))
      } finally {
        inflight = null
      }
      if (text === '') {
        const detail = '探测拿到了空回复(协议不合的典型症状)'
        status = { state: 'failed', detail, at: now() }
        opts.onResult?.({ ok: false, detail, ms: now() - started })
        throw new Error(opts.failureMessage(detail))
      }
      status = { state: 'ok', detail: text.slice(0, 40), at: now() }
      opts.onResult?.({ ok: true, detail: text.slice(0, 40), ms: now() - started })
    })()
    return inflight
  }

  const wrapped: AgentProvider & { probeStatus(): ProbeStatus } = {
    ...inner,
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      await ensure()
      return inner.spawn(project, ctx)
    },
    ...(inner.cheapEval && (opts.gate ?? 'all') === 'all' ? { cheapEval: async (prompt: string) => { await ensure(); return inner.cheapEval!(prompt) } } : {}),
    ...(inner.strongEval && (opts.gate ?? 'all') === 'all' ? { strongEval: async (prompt: string) => { await ensure(); return inner.strongEval!(prompt) } } : {}),
    probeStatus: () => status,
  }
  return wrapped
}
