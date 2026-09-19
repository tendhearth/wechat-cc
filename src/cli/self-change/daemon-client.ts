/**
 * daemon-client.ts —— 自改流水线回头够 daemon 的那三条路由。
 *
 * 流水线跑在 daemon **外面**的一个 CLI 进程里(最后一步要重启 daemon,状态机
 * 放在 daemon 里会被自己杀掉),所以它既没有 ilink 连接也不知道主人是谁:
 * 报进展、问 y/n、查拍板结果都得回到 daemon 做。
 *
 * 两条纪律:
 *  · **每次调用重读 api-info**。流水线中途会 `self deploy` 换掉 daemon,端口和
 *    两把 token 都会变;把 ApiInfo 缓存在闭包里,部署之后所有请求都会打空。
 *  · **失败一律吞成 false / null / unknown**。调用方要分的只有「主人知道了 /
 *    不知道」,daemon 正在重启和 409 对它是同一件事(重试与放弃由步骤代码决定)。
 *
 * `SelfChangeDecision` 与 daemon 侧 self-change-glue.ts 同名同值,**故意抄一份**:
 * 分层规矩是 cli 不许 import daemon(.dependency-cruiser.cjs)。
 */
import type { ApiInfo } from '../../lib/api-info'

export type SelfChangeDecision = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'

const DECISIONS: readonly string[] = ['pending', 'allow', 'deny', 'timeout', 'undelivered', 'unknown']

export interface DaemonClient {
  /** 报一句进展。false = 主人没收到(没配 chat / 推送窗口关着 / daemon 没起)。 */
  notice(text: string): Promise<boolean>
  /**
   * 开一张拍板卡。null = daemon 那边压根没登记(没配主人 / daemon 没起),
   * 调用方别去轮询一个不存在的 hash。
   *
   * `delivered=false` **不是**失败:条目在登记处等着,只是微信那条路不通
   * (真机 errcode=-2),主人可以从桌面权限卡或 `self change --approve <id>`
   * 拍板。老 daemon 不回这个字段 ⇒ 按 true 算(它的行为就是送不到即失败)。
   */
  ask(prompt: string, timeoutMs: number): Promise<{ hash: string; code: string | null; delivered: boolean } | null>
  decision(hash: string): Promise<SelfChangeDecision>
  /**
   * 替主人拍一条待批(桌面权限卡走的是同一条路由、同一个 consume)。
   * false = hash 过期 / 已经被别的面拍过了 / daemon 够不着。
   */
  resolve(hash: string, decision: 'allow' | 'deny'): Promise<boolean>
  /** daemon 还在不在(部署后的健康门)。用窄的那把 file token。 */
  health(): Promise<boolean>
}

/** 单次请求的上限。拍板本身的等待是轮询出来的,不靠一条长连接吊着。 */
const DEFAULT_TIMEOUT_MS = 15_000

export function makeDaemonClient(deps: { readApiInfo: () => ApiInfo | null; fetch: typeof fetch; timeoutMs?: number }): DaemonClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; token: 'operator' | 'file'; body?: unknown },
  ): Promise<{ status: number; ok: boolean; body: unknown } | null> {
    const api = deps.readApiInfo()
    if (!api) return null
    try {
      const res = await deps.fetch(`${api.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.token === 'operator' ? api.operatorToken : api.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      let body: unknown
      try { body = await res.json() } catch { body = undefined }
      return { status: res.status, ok: res.ok, body }
    } catch {
      // daemon 正在重启 / 端口换了 / 超时 —— 对调用方都是「这次没够着」。
      return null
    }
  }

  return {
    async notice(text: string): Promise<boolean> {
      const r = await call('/v1/self-change/notice', { method: 'POST', token: 'operator', body: { text } })
      return !!r?.ok
    },

    async ask(prompt: string, askTimeoutMs: number): Promise<{ hash: string; code: string | null; delivered: boolean } | null> {
      const r = await call('/v1/self-change/ask', { method: 'POST', token: 'operator', body: { prompt, timeoutMs: askTimeoutMs } })
      if (!r?.ok) return null
      const b = (r.body ?? {}) as { hash?: unknown; code?: unknown; delivered?: unknown }
      if (typeof b.hash !== 'string' || !b.hash) return null
      // 老 daemon 没有 delivered:它送不到就当失败了,所以有 hash 就等于送到了。
      return { hash: b.hash, code: typeof b.code === 'string' ? b.code : null, delivered: typeof b.delivered === 'boolean' ? b.delivered : true }
    },

    async resolve(hash: string, decision: 'allow' | 'deny'): Promise<boolean> {
      // 和桌面那张权限卡同一条路由(operator token 的 routeAllow 里本来就有它)。
      const r = await call('/v1/permissions/resolve', { method: 'POST', token: 'operator', body: { hash, decision } })
      if (!r?.ok) return false
      return (r.body as { ok?: unknown } | undefined)?.ok === true
    },

    async decision(hash: string): Promise<SelfChangeDecision> {
      const r = await call(`/v1/self-change/decision?hash=${encodeURIComponent(hash)}`, { method: 'GET', token: 'operator' })
      if (!r?.ok) return 'unknown'
      const d = (r.body as { decision?: unknown } | undefined)?.decision
      return typeof d === 'string' && DECISIONS.includes(d) ? (d as SelfChangeDecision) : 'unknown'
    },

    async health(): Promise<boolean> {
      // file token:operator token 根本够不着 /v1/health(见 self-deploy 的健康门)。
      const r = await call('/v1/health', { method: 'GET', token: 'file' })
      return !!r?.ok
    },
  }
}
