/**
 * mw-llm-health — LLM 降级时不再为每条消息发起轮次(spec 2026-08-03 §4)。
 *
 * 插在 mw-dispatch 之前:那是终端中间件,LLM 轮次就在它后面发生,所以在这里
 * 拦下就是在烧 token 之前拦下。
 *
 * 与 wechat 侧相反:LLM 坏掉时入站仍然收得到,每条消息都会驱动一次注定失败的
 * 调用 —— 这才是"反复打一个失败的 API"真正发生的地方。
 *
 * 恢复检测由入站消息本身驱动并受退避约束:距上次尝试不足当前退避间隔就直接
 * 回模板话;达到间隔则放行一次真实尝试。
 */
import { nextBackoffMs } from '../health/backoff'
import type { Middleware } from './types'

/**
 * 写死的文案 —— 坏掉的正是 LLM,不能指望它写自己的讣告。
 * 这听起来显然,但实现时很容易顺手就调了。
 */
const DEGRADED_REPLY = '我现在暂时没法思考(模型连接有问题),你的消息我收到了。等我恢复了会继续。'

export interface MwLlmHealthDeps {
  health: {
    shouldSuspend(dep: 'llm'): boolean
    get(dep: 'llm'): { consecutiveFailures: number }
  }
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  now: () => number
  log: (tag: string, line: string) => void
}

export function makeMwLlmHealth(deps: MwLlmHealthDeps): Middleware {
  /** 每个 chat 在当前 degraded 区间内是否已回过模板话。 */
  const notified = new Set<string>()
  let lastAttemptMs: number | null = null

  return async (ctx, next) => {
    if (!deps.health.shouldSuspend('llm')) {
      notified.clear()
      lastAttemptMs = null
      await next()
      return
    }

    const now = deps.now()
    const delay = nextBackoffMs(deps.health.get('llm').consecutiveFailures)

    if (lastAttemptMs !== null && now - lastAttemptMs >= delay) {
      // 距上次尝试已达退避间隔 —— 放行一次真实尝试:成功与否由下游上报给
      // 健康机,这里不做判断。
      lastAttemptMs = now
      await next()
      return
    }
    if (lastAttemptMs === null) {
      // 首次进入 degraded:刚经历了确认期(60s)的连续失败,没必要立刻再试
      // 一次 —— 把这一刻记成"上一次尝试点",后续消息据此计算退避窗口。
      lastAttemptMs = now
    }

    if (!notified.has(ctx.msg.chatId)) {
      notified.add(ctx.msg.chatId)
      try {
        await deps.sendMessage(ctx.msg.chatId, DEGRADED_REPLY)
      } catch (err) {
        // 微信可能也断了 —— 记一行就够,绝不能把入站管线打断。
        deps.log('HEALTH', `degraded reply failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    ctx.consumedBy = 'health'
  }
}
