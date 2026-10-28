/**
 * 终端会话登记处的口(架构终态 E5):库里一行、对外的一条、身份、store。实现在
 * src/adapters/store/cli-session-store.ts(v76 `cli_sessions`);app 的 hook 事件判定(cli-events)只经这里认它们的形状。
 * 读时折算 / 排序是纯函数,在 src/domain/cli-session-view.ts。只有类型,没有逻辑。
 */

export type CliSessionStatus = 'running' | 'waiting' | 'idle' | 'ended'
/** 同 cli-events.ts 的 CliSource;这里单写一份是为了不和 hub 互相 import(depcruise no-circular 连 type 也算)。 */
type CliSource = 'claude' | 'codex' | 'cursor'

export interface CliSessionRow {
  session_id: string
  source: CliSource
  cwd: string
  machine: string | null
  transcript_path: string | null
  origin_agent: string | null
  status: CliSessionStatus
  last_event_at: number
  last_prompt_at: number | null
  last_summary: string | null
  pending_tool: string | null
  pending_summary: string | null
  pending_at: number | null
  created_at: number
}

/** 对外(内部 API / 手机)的一条:状态已按 stale 规则折算。 */
export interface CliSessionView {
  session_id: string
  /** 微信「看 码」「@码」用的短码(会话 id 前 6 位)。 */
  code: string
  source: CliSource
  status: CliSessionStatus
  /** 库里记的是 running / waiting,但超过 30 分钟没事件 ⇒ 折算成 idle。 */
  stale: boolean
  project: string
  cwd: string
  machine: string | null
  origin_agent: string | null
  last_summary: string | null
  last_event_at: number
  last_prompt_at: number | null
  created_at: number
  /** 等批准的那一项;只在 status='waiting' 时有。 */
  pending: { tool: string; summary: string | null; since: number } | null
}

export interface CliSessionIdentity {
  session_id: string
  source: CliSource
  cwd: string
  machine?: string | undefined
  transcript_path?: string | undefined
  origin_agent?: string | undefined
}

export interface CliSessionStore {
  /** 见到一条事件:没有就建(status=running),有就刷新身份字段与 last_event_at。 */
  touch(id: CliSessionIdentity, at: number): void
  setStatus(sessionId: string, status: CliSessionStatus, at: number, extra?: { summary?: string | null; promptAt?: number; pending?: { tool: string; summary: string | null } }): void
  get(sessionId: string): CliSessionRow | null
  /** 按会话 id 前缀找(不分大小写),不含已结束的;多条命中取最近有事件的。 */
  findByPrefix(prefix: string): CliSessionRow | null
  /** 最近有事件的在前。 */
  list(opts?: { includeEnded?: boolean; limit?: number }): CliSessionRow[]
  prune(now: number): void
}
