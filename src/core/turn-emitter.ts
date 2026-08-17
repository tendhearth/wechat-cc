import type { AgentEvent } from './agent-provider'
import { isAuthFail } from './auth-fail'

/**
 * 每 turn 的事件制造 + 记账(spec §1d)。只制造事件对象,不接管循环、不接管
 * 工具执行、不碰迭代器 —— 因此 queue-pump / per-turn generator / 自持工具
 * 循环三种形状都能用。B3(三家不识别 auth 失败)由 error()/errorText()
 * 内建的 sdk-error 判别达成。
 */
export interface TurnEmitter {
  init(sessionId: string): AgentEvent
  text(t: string): AgentEvent
  toolCall(tool: string, server?: string): AgentEvent          // 内部 toolCall 计数++
  /** catch 到的异常 → error 事件;message 走 err instanceof Error 语气词;
   *  自动 isAuthFail('sdk-error') ⇒ code:'auth_failed'(opts.code 显式给定则优先)。 */
  error(err: unknown, opts?: { code?: string }): AgentEvent
  /** SDK 事件里已是字符串的错误消息 → 同上判别。 */
  errorText(message: string, opts?: { code?: string }): AgentEvent
  /** result 合成:durationMs 缺省 = now - 构造时刻;numTurns 缺省 = toolCall 计数
   *  (实践中五家都带自己的 numTurns —— overrides 整体覆盖,合成绝不克扣)。 */
  finish(overrides: { sessionId: string; numTurns?: number; durationMs?: number }): AgentEvent
}

export function makeTurnEmitter(): TurnEmitter {
  const startedAt = Date.now()
  let toolCalls = 0
  const mkError = (message: string, code?: string): AgentEvent => {
    if (code) {
      return {
        kind: 'error',
        message,
        code,
      }
    }
    if (isAuthFail('sdk-error', message)) {
      return {
        kind: 'error',
        message,
        code: 'auth_failed',
      }
    }
    return {
      kind: 'error',
      message,
    }
  }
  return {
    init: (sessionId) => ({ kind: 'init', sessionId }),
    text: (text) => ({ kind: 'text', text }),
    toolCall: (tool, server) => {
      toolCalls++
      return { kind: 'tool_call', tool, ...(server !== undefined ? { server } : {}) }
    },
    error: (err, opts) => mkError(err instanceof Error ? err.message : String(err), opts?.code),
    errorText: (message, opts) => mkError(message, opts?.code),
    finish: (o) => ({
      kind: 'result',
      sessionId: o.sessionId,
      numTurns: o.numTurns ?? toolCalls,
      durationMs: o.durationMs ?? Date.now() - startedAt,
    }),
  }
}
