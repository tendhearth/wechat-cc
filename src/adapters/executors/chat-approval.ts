import { randomBytes } from 'node:crypto'
import { toolInputPreview,redactPreviewText } from '../../domain/workbench/tool-input-preview'
import { redactSecrets } from '../../domain/cli-transcript'

/** 三个对话通道用同一份预览；先打码，再截断。 */
export function renderChatApprovalPrompt(provider: string, tool: string, input: unknown, requestId: string, title?: string): string {
  if(/(?:^|__)matter_plan$/.test(tool)&&input&&typeof input==='object'){
    const plan=input as {title?:unknown;target?:unknown;legs?:unknown}
    if(Array.isArray(plan.legs)&&plan.legs.length>=2&&plan.legs.length<=6){
      const clip=(v:unknown,n:number)=>{const s=redactPreviewText(redactSecrets(typeof v==='string'?v:JSON.stringify(v)??'')).replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s}
      return `${provider} · matter_plan [approval:${requestId}]\n确认拆法：${clip(plan.title,120)}\n工作区：${clip(plan.target,160)}\n`+plan.legs.map((leg,i)=>{const l=leg as {executor?:unknown;brief?:unknown};return `第 ${i+1} 棒 · ${clip(l?.executor,80)}：${clip(l?.brief,160)}`}).join('\n')+'\n批准后按此顺序接力；失败或提问就停。'
    }
  }
  const preview = toolInputPreview(input, true) ?? '[input omitted: too large or unreadable]'
  const safeTitle = title ? toolInputPreview({ title }) : null
  const text = redactSecrets(`${provider} wants to run ${tool} [approval:${requestId}]${safeTitle ? `\n${safeTitle}` : ''}\n${preview}`)
  const suffix = '\n[preview truncated]'
  return text.length <= 2000 ? text : text.slice(0, 2000 - suffix.length) + suffix
}

/** 对话审批的共同等待边界。取消不依赖主人回答，也不接受迟到的批准。 */
export type ChatApprovalAnswer = 'allow' | 'deny' | 'timeout' | 'undelivered' | 'cancelled'
export interface ChatApprovalChannel {
  maxCards?: number
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

/** 一个 dispatch 一份；开卡前同步扣预算，Claude 并发调用也不能越过上限。 */
export class ChatApprovalTurn {
  private cards = 0
  private readonly denied = new Set<string>()
  constructor(private readonly maxCards = 3) {}
  denies(tool: string): boolean { return this.denied.has(tool) }
  async ask(args: Parameters<typeof askForChatApproval>[0] & { tool: string }): Promise<ChatApprovalAnswer> {
    if (args.signal?.aborted) return 'cancelled'
    if (this.denied.has(args.tool) || this.cards >= this.maxCards) return 'deny'
    this.cards++
    const answer = await askForChatApproval(args)
    if (answer !== 'allow') this.denied.add(args.tool)
    return answer
  }
}

export interface ChatApprovalLifecycle {
  beginTurn(): void
  endTurn(): void
}

/** 不从轮内序号或可缺省的 SDK toolUseID 生成，旧卡不能命中新一轮。 */
export function newChatApprovalId(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(-5)
}
