import {matterToolFailure} from '../../../packages/protocol/src/workbench-errors'
import {PlanInputError,type PlanTarget,type PlanLegs} from '../workbench/matter-plan-input'
import { randomBytes } from 'node:crypto'
import { toolInputPreview,redactPreviewText } from '../../domain/workbench/tool-input-preview'
import { shareName } from '../../domain/matters/share-scope'
import { redactSecrets } from '../../domain/cli-transcript'

/** 三个对话通道用同一份预览；先打码，再截断。 */
export function renderChatApprovalPrompt(provider: string, tool: string, input: unknown, requestId: string, title?: string, resolved?:MatterPlanPreview): string {
  if(/(?:^|__)matter_plan$/.test(tool)&&input&&typeof input==='object'){
    const plan=input as {title?:unknown;target?:unknown;legs?:unknown}
    if(Array.isArray(plan.legs)&&plan.legs.length>=1&&plan.legs.length<=6){
      const clip=(v:unknown,n:number)=>{const s=redactPreviewText(redactSecrets(typeof v==='string'?v:JSON.stringify(v)??'')).replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s}
      const legs=resolved?.legs??plan.legs
      const showPath=(path:string)=>redactPreviewText(redactSecrets(path)).replace(/\r/g,'\\r').replace(/\n/g,'\\n')
      const workspace=resolved?.registrationPath
        ? `${clip(resolved.projectName,100)}（${showPath(resolved.registrationPath)}${resolved.projectPath===resolved.registrationPath?'':`，由 ${showPath(resolved.projectPath)} 指过去`}）· 还没登记，批准后登记为工作项目`
        : clip(resolved?`${resolved.projectName}（${resolved.projectPath}）`:plan.target,320)
      return `${provider} · matter_plan [approval:${requestId}]\n${plan.legs.length===1?'确认交办':'确认拆法'}：${clip(plan.title,120)}\n工作区：${workspace}${resolved?.target.kind==='project'&&resolved.target.isolation==='worktree'?`\n独立工作区 · 起点：${clip(resolved.target.base??'项目默认分支',80)}`:''}\n`+legs.map((leg,i)=>{const l=leg as {executor?:unknown;brief?:unknown};return `第 ${i+1} 棒 · ${clip(l?.executor,64)}：${clip(l?.brief,Math.min(400,Math.floor(1300/(plan.legs as unknown[]).length)))}`}).join('\n')+(plan.legs.length===1?'\n批准后开工。':'\n批准后按此顺序接力；失败或提问就停。')
    }
  }
  if(/(?:^|__)matter_share$/.test(tool)&&input&&typeof input==='object'){
    const share=input as {matter?:unknown;title?:unknown;name?:unknown;mode?:unknown}
    // 卡上写的名字就是会存下来的那个(同一个归一);名字不合格、档位不是「能讨论 / 只看」的,不出这张卡,落到下面的原样预览。
    const name=shareName(share.name),title=typeof share.title==='string'?redactPreviewText(redactSecrets(share.title)).replace(/[\s「」]+/g,' ').trim().slice(0,80):''
    if(name&&title&&typeof share.matter==='string'&&/^[a-f0-9]{8}$/.test(share.matter)&&(share.mode===undefined||share.mode==='discuss'||share.mode==='view'))
      return `${provider} · matter_share [approval:${requestId}]\n确认分享:把「${title}」这件事(${share.matter})开给「${name}」,${share.mode==='view'?'对方只能看':'对方能看、能在里面说话'}。\n拿到链接的人看得到这件事的分工、过程记录和产出的文件名,看不到你的其他对话和别的事。链接 14 天有效,可以随时关掉。`
  }
  const preview = toolInputPreview(input, true) ?? '[input omitted: too large or unreadable]'
  const safeTitle = title ? toolInputPreview({ title }) : null
  const text = redactSecrets(`${provider} wants to run ${tool} [approval:${requestId}]${safeTitle ? `\n${safeTitle}` : ''}\n${preview}`)
  const suffix = '\n[preview truncated]'
  return text.length <= 2000 ? text : text.slice(0, 2000 - suffix.length) + suffix
}

/** 对话审批的共同等待边界。取消不依赖主人回答，也不接受迟到的批准。 */
export type ChatApprovalAnswer = 'allow' | 'deny' | 'timeout' | 'undelivered' | 'cancelled'
export type TerminalParticipationResolver=(action:'attach'|'detach',input:unknown,chatId:string)=>{body:unknown;code:string;cwd:string;title:string}
export type MatterPlanResolver=(input:unknown,chatId:string,provider:string)=>MatterPlanPreview|Promise<MatterPlanPreview>
type MatterPlanPreview=PlanTarget&{legs?:PlanLegs}
export interface ChatApprovalChannel {
  noteMatterApproval?:(tool:string,input:unknown,chatId:string,provider:string)=>void
  resolveMatterPlan?:MatterPlanResolver
  resolveTerminalParticipation?:TerminalParticipationResolver
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


/** Resolve before asking. The approved project identity is carried into local tool execution. */
export async function prepareChatApprovalPrompt(provider:string,tool:string,input:unknown,requestId:string,channel:Pick<ChatApprovalChannel,'resolveMatterPlan'|'resolveTerminalParticipation'>,chatId:string,title?:string):Promise<string> {
  if(tool==='mcp__wechat__terminal_attach'||tool==='mcp__wechat__terminal_detach'){
    if(!channel.resolveTerminalParticipation)throw Error('终端挂入尚未准备好')
    const action=tool.endsWith('_attach')?'attach':'detach'
    const preview=channel.resolveTerminalParticipation(action,input,chatId)
    // Bind approval to the exact identity, not a prefix or mutable matter selection.
    for(const key of Object.keys(input as object))delete (input as Record<string,unknown>)[key]
    Object.assign(input as object,preview.body)
    const clean=(text:string)=>redactPreviewText(redactSecrets(text)).replace(/\s+/g,' ').slice(0,500)
    return `${provider} · terminal_${action} [approval:${requestId}]\n确认${action==='attach'?'挂入':'摘下'}终端：${clean(preview.code)}\n目录：${clean(preview.cwd)}\n事名：${clean(preview.title)}`
  }
  let resolved:MatterPlanPreview|undefined
  if(tool==='mcp__wechat__matter_plan'&&channel.resolveMatterPlan){
    try{
      resolved=await channel.resolveMatterPlan(input,chatId,provider.toLowerCase())
      if(!resolved.registrationPath&&input&&typeof input==='object'){
        const args=input as Record<string,unknown>
        delete args.project;delete args.isolation;delete args.base
        args.target=resolved.target
        if(resolved.legs)args.legs=resolved.legs
      }
    }catch(error){
      const code=error instanceof Error?error.message:'matter_plan_failed'
      const details=error instanceof PlanInputError?error:undefined
      throw Error(matterToolFailure(code,false,'plan',details?.projects,details?.executors,details?.defaultUnavailableMessage,details?.candidateNames,details?.placeChoices).message)
    }
  }
  return renderChatApprovalPrompt(provider,tool,input,requestId,title,resolved)
}


export function noteChatApproval(channel:Pick<ChatApprovalChannel,'noteMatterApproval'>,provider:string,tool:string,input:unknown,chatId:string):void {
  if(tool==='mcp__wechat__matter_plan'||tool==='mcp__wechat__matter_handoff'||tool==='mcp__wechat__matter_share'||tool==='mcp__wechat__terminal_attach'||tool==='mcp__wechat__terminal_detach')channel.noteMatterApproval?.(tool,input,chatId,provider.toLowerCase())
}
