/** 对话审批的共同等待边界。取消不依赖主人回答，也不接受迟到的批准。 */
export type ChatApprovalAnswer = 'allow' | 'deny' | 'timeout' | 'undelivered' | 'cancelled'
export interface ChatApprovalChannel {
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<Exclude<ChatApprovalAnswer, 'cancelled'>>
  /** 删除 pending 登记并让旧卡失效。 */
  revoke?(hash: string): void
}

export async function askForChatApproval(args: {
  channel: ChatApprovalChannel; target: string; prompt: string; hash: string; timeoutMs: number; signal?: AbortSignal
}): Promise<ChatApprovalAnswer> {
  const { channel, target, prompt, hash, timeoutMs, signal } = args
  if (signal?.aborted) return 'cancelled'
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<ChatApprovalAnswer>(resolve => {
      onAbort = () => {
        try { channel.revoke?.(hash) } catch { /* 等待仍立即结束。 */ }
        resolve('cancelled')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const answer = channel.askUser(target, prompt, hash, timeoutMs)
        // askUser 可能同步触发取消；登记之后再撤一次，避免留下新卡。
        if (signal?.aborted) onAbort()
        void answer.then(v => resolve(signal?.aborted ? 'cancelled' : v), () => resolve('deny'))
      } catch { resolve('deny') }
    })
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
