import type { AnswerRouteReceipt, AnswerTarget } from '../../domain/answer-target'
import type { InboundMsg } from '../../domain/prompt-format'
import { answerCandidates, fallbackAnswerTarget, type AnswerJudge } from './answer-fallback'
import { namedAnswerTarget, type AnswerProvider } from './answer-target'
import type { InboundCtx, Middleware } from './types'

interface Deps {
  providers?: () => readonly AnswerProvider[]
  unavailableNames?: () => readonly string[]
  judge?: AnswerJudge
  now?: () => number
  clearFocus?: (chatId: string) => void
  sendMessage?: (chatId: string, text: string) => Promise<unknown>
}
interface Original {
  msg: InboundMsg
  receipt: AnswerRouteReceipt
  options?: readonly AnswerProvider[]
  queued: boolean
  expiresAt: number
}
const TTL = 10 * 60_000
const cc = (): AnswerTarget => Object.freeze({ kind: 'cc', reason: 'answer_correction' })
const clean = (text: string) => text.trim().replace(/[。！!？?]$/, '').trim()
const named = (text: string, p: AnswerProvider) => [p.id, ...p.names].some(n => n.toLowerCase() === text.toLowerCase())
const name = (p: AnswerProvider) => p.names.find(n => n !== p.id) ?? p.names[0] ?? p.id

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 评审 P2:只认「让 A 还是 B(来)答」这种明摆着在挑答话者的句式;「总结 A 和 B 回答失败的原因」不算。 */
function eitherOr(text: string, ps: readonly AnswerProvider[]): boolean {
  const alt = ps.flatMap(p => [p.id, ...p.names]).filter(n => n.trim()).map(esc).sort((a, b) => b.length - a.length).join('|')
  return new RegExp(`^(?:让|请|请让|找)?\\s*(?:${alt})\\s*(?:还是|或者|或)\\s*(?:${alt})\\s*(?:来)?(?:回答|答|说说|看看)`, 'i').test(text.trim())
}

/** route 与 consume 共用的短期原句；不落盘、不记录正文，不改变 Mode。 */
export function makeAnswerRouting(deps: Deps) {
  const now = deps.now ?? Date.now
  const originals = new Map<string, Original>()
  const prepared = new WeakMap<InboundCtx, Original>()
  const notices = new WeakMap<InboundCtx, string>()
  const notice = (ctx: InboundCtx, text: string): AnswerTarget => {
    notices.set(ctx, text)
    return Object.freeze({ kind: 'clarify', reason: 'answer_notice' })
  }
  const current = (chatId: string) => {
    const r = originals.get(chatId)
    if (r && r.expiresAt <= now()) { originals.delete(chatId); return undefined }
    return r
  }
  const remember = (ctx: InboundCtx, target: AnswerTarget, options?: readonly AnswerProvider[]): Original => {
    // 不复制主人的召回/话题；选择时只还原原句、附件与消息身份。
    const { text, quote, attachments, msgType, createTimeMs, msgId } = ctx.msg
    const msg: InboundMsg = { chatId: ctx.msg.chatId, userId: ctx.msg.userId, accountId: ctx.msg.accountId, text, msgType, createTimeMs, ...(msgId ? { msgId } : {}), ...(quote ? { quote: { ...quote } } : {}), ...(attachments ? { attachments: attachments.map(a => ({ ...a })) } : {}) }
    const receipt: AnswerRouteReceipt = { requestId: ctx.requestId, target, state: 'pending' }
    const r = { msg, receipt, options, queued: target.kind !== 'clarify', expiresAt: now() + TTL }
    originals.set(ctx.msg.chatId, r)
    prepared.set(ctx, r)
    if (r.queued) ctx.msg.answerRoute = receipt
    return r
  }
  const restore = (ctx: InboundCtx, r: Original, target: AnswerTarget): AnswerTarget => {
    r.receipt.target = target
    r.options = undefined
    r.queued = true
    ctx.msg.text = r.msg.text
    ctx.msg.msgType = r.msg.msgType
    // 保留选择消息的传输/历史身份；原句去重由 receipt.requestId 承担。
    // App 用 createTimeMs 派生历史 ID，改回原时刻会覆盖（或丢掉）最终答复。
    ctx.msg.attachments = r.msg.attachments
    ctx.msg.quote = r.msg.quote
    delete ctx.msg.recall; delete ctx.msg.topics; delete ctx.msg.topicsUnsure; delete ctx.msg.matters
    ctx.msg.answerRoute = r.receipt
    return target
  }
  const choose = (ctx: InboundCtx, r: Original, provider: string | null): AnswerTarget => {
    const p = provider ? deps.providers?.().find(p => p.id === provider && p.available) : null
    if (provider && !p) return notice(ctx, '这位目前不可用，这句尚未送出。要我来答的话，回「你来」。')
    const target: AnswerTarget = p ? Object.freeze({ kind: 'oneoff', provider: p.id, reason: 'answer_choice' }) : cc()
    if (r.queued) {
      r.receipt.target = target
      return notice(ctx, '已改好尚未送出的原句目标，只对这一句生效。')
    }
    return restore(ctx, r, target)
  }
  function before(ctx: InboundCtx): AnswerTarget | null {
    const text = clean(ctx.msg.text ?? ''), ps = deps.providers?.() ?? []
    const r = current(ctx.msg.chatId)
    const switchMatch = /^换成\s*(.+?)\s*(?:来)?(?:回答|答)$/.exec(text)
    const change = switchMatch ? ps.find(p => named(switchMatch[1]!, p)) : undefined
    const correction = text === '跟 CC 说' || text === '跟CC说' || text === '不是这件' || !!switchMatch
    if (correction) {
      deps.clearFocus?.(ctx.msg.chatId)
      if (r?.receipt.state === 'sent' || r?.receipt.state === 'submitted') {
        return notice(ctx, r.receipt.state === 'sent'
          ? '原句已送达。已退出路由焦点，不会自动改投或重放；如需停止，请沿原入口停止；改投请重新确认原句。'
          : '原句已提交，可能已经送达。已退出路由焦点，不会自动改投或重放；改投请重新确认原句。')
      }
      if (text === '不是这件') {
        if (r) r.receipt.state = 'cancelled'
        originals.delete(ctx.msg.chatId)
        return notice(ctx, '已退出路由焦点，尚未送出的原句已取消。')
      }
      if (!r || r.receipt.state === 'cancelled') return notice(ctx, '已退出路由焦点。请把要回答的原句再说一次。')
      if (switchMatch && !change) return notice(ctx, '没有找到这位可用的答话者，原句尚未改投。')
      return choose(ctx, r, change?.id ?? null)
    }
    if (r && !r.queued && r.receipt.state === 'pending') {
      const idx = /^\d{1,2}$/.test(text) ? Number(text) - 1 : -1
      const p = r.options?.find(p => named(text, p)) ?? (idx >= 0 ? r.options?.[idx] : undefined)
      if (/^(?:你来|你来答|我来|CC|CC来答)$/i.test(text)) return choose(ctx, r, null)
      if (p) return choose(ctx, r, p.id)
      // 下一句答非所问：旧问作废，不把以后某个名字绑定回来。
      originals.delete(ctx.msg.chatId)
    }
    const mentions = answerCandidates(ctx.msg.text ?? '', ps)
    if (mentions.length > 1 && eitherOr(ctx.msg.text ?? '', mentions)) {
      // 按主人说出名字的先后编号(「让 Codex 还是 Claude」⇒ Codex 是 1),不按注册顺序。
      const at = (p: AnswerProvider) => Math.min(...[p.id, ...p.names].map(n => { const i = (ctx.msg.text ?? '').toLowerCase().indexOf(n.toLowerCase()); return i < 0 ? Infinity : i }))
      const options = mentions.filter(p => p.available).sort((a, b) => at(a) - at(b))
      if (options.length > 1) {
        const target: AnswerTarget = Object.freeze({ kind: 'clarify', candidates: options.map(p => ({ provider: p.id, name: name(p) })), reason: 'ambiguous_provider' })
        remember(ctx, target, options)
        return target
      }
      return Object.freeze({ kind: 'cc', reason: 'uncertain_provider' })
    }
    const target = namedAnswerTarget(ctx.msg.text ?? '', ps, deps.unavailableNames?.())
    if (target && target.kind !== 'cc') remember(ctx, target, target.kind === 'clarify' ? ps.filter(p => p.id === target.provider) : undefined)
    return target
  }
  async function fallback(ctx: InboundCtx): Promise<AnswerTarget> {
    const ps = deps.providers?.() ?? []
    if (!deps.judge || !answerCandidates(ctx.msg.text, ps).length) return Object.freeze({ kind: 'cc', reason: 'default_cc' })
    const r = prepared.get(ctx) ?? remember(ctx, Object.freeze({ kind: 'cc', reason: 'default_cc' }))
    const initial = r.receipt.target
    const target = await fallbackAnswerTarget(ctx.msg.text, ps, deps.judge)
    // 等模型时主人可能已纠正；过时的模型结果不能覆盖新目标。
    if (r.receipt.target !== initial || r.receipt.state === 'cancelled') return r.receipt.target
    r.receipt.target = target.kind === 'oneoff' && !deps.providers?.().some(p => p.id === target.provider && p.available) ? initial : target
    return r.receipt.target
  }
  const consume: Middleware = async (ctx, next) => {
    if (ctx.msg.answerRoute?.state === 'cancelled') { ctx.consumedBy = 'command'; return }
    const t = ctx.target
    const text = notices.get(ctx) ?? (t?.kind === 'clarify' && t.candidates
      ? `这句要交给 ${t.candidates.map((p, i) => `${p.name}（${i + 1}）`).join(' 还是 ')}？还是我来答？`
      : undefined)
    if (text && deps.sendMessage) { ctx.consumedBy = 'command'; await deps.sendMessage(ctx.msg.chatId, text); return }
    await next()
  }
  return { before, fallback, consume,
    reserve: (ctx: InboundCtx) => { remember(ctx, Object.freeze({ kind: 'cc', reason: 'default_cc' })) },
    corrected: (ctx: InboundCtx): AnswerTarget | null => {
      const receipt = ctx.msg.answerRoute
      return receipt && (receipt.state === 'cancelled' || receipt.target.reason === 'answer_choice' || receipt.target.reason === 'answer_correction') ? receipt.target : null
    },
    rememberMatter: (ctx: InboundCtx, target: AnswerTarget) => {
    if (target.kind === 'matter' && (ctx.intent?.data as { kind?: string } | undefined)?.kind === 'command') {
      const r = prepared.get(ctx)
      if (r) r.receipt.target = target
      else remember(ctx, target)
    } else {
      const r = prepared.get(ctx)
      if (r && originals.get(ctx.msg.chatId) === r) originals.delete(ctx.msg.chatId)
      delete ctx.msg.answerRoute
    }
  } }
}
