import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * reply-scope — 一轮之内"回复该往哪儿去"。
 *
 * 意图路由第四步(d):桌面 / 手机上说的话也走 route + consume 这张表。表里的消费者
 * (管理 / 模式 / 引导 / 工作台 / 管家 / 终端回话)回话时都调的是 `sendMessage(chatId, text)`,
 * 那条路直通微信。App 发起的一轮不该把回复发到微信,而要原样交还给 App。
 *
 * 做法:App 一轮用 `withReplyScope` 包住;消费者的 sendMessage 先问 `scopedReply()`,
 * 有作用域就把文字放进去而不外发。按异步上下文而不是按 chat 记,所以同一时刻微信来的
 * 一条不会被串到 App 的回复里(reply-sinks 是按 chat 记的,只给 LLM 的 reply 工具用)。
 */
export interface ReplyScope { push(text: string): void }

const als = new AsyncLocalStorage<ReplyScope>()

/** 当前异步上下文里的回复作用域;没有 ⇒ undefined(照常外发)。 */
export const scopedReply = (): ReplyScope | undefined => als.getStore()

/** 在一个回复作用域里跑 fn;返回 fn 的结果和这一轮被截住的回复(按先后)。 */
export async function withReplyScope<T>(fn: () => Promise<T>): Promise<{ result: T; replies: string[] }> {
  const replies: string[] = []
  const result = await als.run({ push: (text) => { replies.push(text) } }, fn)
  return { result, replies }
}

/** 把一个"直发微信"的 sendMessage 包成"有作用域就截住"的版本;返回值形状保持给调用方能用。 */
export function scopedSend<A extends unknown[], R>(send: (chatId: string, text: string, ...rest: A) => Promise<R>): (chatId: string, text: string, ...rest: A) => Promise<R> {
  return (chatId, text, ...rest) => {
    const scope = scopedReply()
    if (scope) { scope.push(text); return Promise.resolve({ msgId: `scoped:${Date.now()}` } as unknown as R) }
    return send(chatId, text, ...rest)
  }
}
