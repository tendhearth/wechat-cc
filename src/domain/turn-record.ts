/**
 * 一轮对话的结构化记录(协调器写,`turn_records` 表存,GET /v1/turns 与健康汇总读)。纯数据形状,放在 domain
 * (架构终态 E3):写它的是 app(协调器),存它的是 adapters(turn-record-store),两边都只引这一份。
 */
import type { Mode, ProviderId } from './conversation'
import type { DeliveryKind } from './turn-reply'

/**
 * Structured, per-turn outcome record — the AI-native observability surface.
 * Emitted via `ConversationCoordinatorDeps.recordTurn`: once per solo dispatch,
 * once per participant in `parallel` mode, and once per speaker turn (round)
 * in `chatroom` mode — `mode` distinguishes them.
 * The daemon stores a ring of these (and/or exposes them on internal-api) so
 * a human — or an LLM diagnosing the daemon — can answer "what happened to
 * this chat's last turn" without grepping free-text logs. `outcome` is the
 * causal verdict; `error` carries the detail for `timeout`/`error` cases.
 */
export interface TurnRecord {
  chatId: string
  provider: ProviderId
  alias: string
  mode: Mode['kind']
  /** Epoch ms when the dispatch began (clock from `deps.now`). */
  startedAt: number
  /** Epoch ms when the dispatch settled. */
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'timeout' | 'auth_failed' | 'error'
  replyToolCalled: boolean
  /** 这一轮调过的工具名(只有名字,不含参数)。空数组 = 这条回答没查任何东西。 */
  toolCalls?: string[]
  /** Count of assistant text chunks produced this turn. */
  textChunks: number
  /** Failure detail for `timeout` / `error` outcomes; undefined otherwise. */
  error?: string
  /** provider 边界产的结构化码(lib/provider-error-code;`turn_timeout` 也在这)。
   *  health 判定有码就只看码,不再扫 `error` 文本。 */
  errorCode?: string
  /**
   * 回复交付(spec 2026-10-03 §4.10):这一轮主人到底收到了什么。只有真的交付过(completed)的轮才填;
   * 超时 / 出错 / 中止的轮留空。
   */
  delivery?: DeliveryKind
  /** 发出的文字气泡条数(交给 app 接收器的非空文字算 1)。 */
  bubbles?: number
  /** 发出的附件数(语音 / 表情 / 文件)。 */
  attachments?: number
  /** 最后的话之前的旁白段数(不发微信)。 */
  narrationSegments?: number
}
