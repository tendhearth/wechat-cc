/**
 * wire-visit.ts — 「串门」的 daemon 接线。协议与 prompt 在 core/visit.ts。
 *
 * 两个入口:
 *   - onInboundLetter:笔友信道收到信时先过这里。是串门信 → 接着聊或收尾,
 *     返回 true(调用方**不**再给主人发「📬 某人给你写信了」)。不是 → false。
 *   - startVisit:主人说「串门」→ 挑一个开着的信道,伙伴先开口。
 *
 * 串门信件照常存在 penpal_letter 里(E2E、at-least-once 都白拿),但**立刻
 * 标已读** —— 两只伙伴之间的话不该算进主人的未读数。
 *
 * 所有 LLM 调用和发送都在 fire-and-forget 里,失败只记日志:串门是伙伴自己
 * 的事,一次没聊成不该在任何地方冒出错误给主人。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  VISIT_MAX_ROUNDS, formatVisitLetter, parseVisitLetter, nextRound, transcriptFromLetters,
  buildVisitReplyPrompt, buildVisitNarrationPrompt, type VisitPersonaArgs,
} from '../../core/visit'
import type { ChannelStore } from '../../core/penpal-channel-store'
import type { LetterStore } from '../../core/penpal-letter-store'
import { loadCompanionConfig } from '../companion/config'
import { makeMemoryFS } from '../memory/fs-api'

const OVERVIEW_MAX = 1500

export interface VisitDeps {
  stateDir: string
  channelStore: ChannelStore
  letterStore: LetterStore
  sendLetter(channelRowId: string, plaintext: string): Promise<{ ok: boolean; error?: string }>
  /** 生成伙伴的话。strongEval 优先(串门是要有性格的,不是分类任务)。 */
  evalText(prompt: string): Promise<string>
  myName: string
  disclosurePolicy: string
  /** 给主人发一句话;没有主人 chat 时是 no-op。 */
  notifyOwner(text: string): void
  /** 见闻进背包(hunt_catch kind='visit')。可选:没接就只发微信。 */
  recordVisit?(args: { text: string; peerLabel: string }): void
  log(tag: string, line: string): void
}

export interface Visit {
  onInboundLetter(channelRowId: string, plaintext: string, letterId: string): boolean
  startVisit(channelRowId?: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }>
}

/** 模型偶尔还是会带引号/前缀;剥掉,别让主人看到「小满:『……』」。 */
export function cleanSpeech(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^[「『"“]+/, '').replace(/[」』"”]+$/, '')
  t = t.replace(/^[^:：\n]{1,8}[:：]\s*/, (m) => (/^(你|我|它|对方|回复|回答|说|Reply|Answer)/i.test(m) ? '' : m))
  return t.trim()
}

export function makeVisit(deps: VisitDeps): Visit {
  const persona = (): VisitPersonaArgs => {
    let personaMd: string | null = null
    let overview: string | null = null
    try {
      const owner = loadCompanionConfig(deps.stateDir).default_chat_id
      if (owner && !owner.includes('..') && !owner.includes('/') && !owner.includes('\\')) {
        const fs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', owner) })
        personaMd = fs.read('persona.md') ?? null
        overview = (fs.read('_overview.md') ?? '').slice(0, OVERVIEW_MAX) || null
      }
    } catch { /* 读不到就当白纸 —— 串门不该因为记忆目录出问题而失败 */ }
    return { myName: deps.myName, persona: personaMd, ownerOverview: overview, disclosurePolicy: deps.disclosurePolicy }
  }

  const peerLabel = (channelRowId: string): string => {
    const ch = deps.channelStore.get(channelRowId)
    return ch ? `第 ${ch.degree} 度的朋友` : '一位朋友'
  }

  const narrate = async (channelRowId: string, visitId: string): Promise<void> => {
    const transcript = transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), visitId)
    if (transcript.length === 0) return
    const text = cleanSpeech(await deps.evalText(buildVisitNarrationPrompt({ ...persona(), transcript, peerLabel: peerLabel(channelRowId) })))
    if (!text) { deps.log('VISIT', `narration empty visit=${visitId}`); return }
    deps.notifyOwner(`🚶 ${text}`)
    // 发到微信就没了 —— 跟打猎一开始的洞一模一样。记录失败不影响已发出的话。
    try { deps.recordVisit?.({ text, peerLabel: peerLabel(channelRowId) }) }
    catch (err) { deps.log('VISIT', `见闻入库失败(话已发出): ${err instanceof Error ? err.message : String(err)}`) }
    deps.log('VISIT', `visit=${visitId} 讲给主人了 turns=${transcript.length}`)
  }

  const continueVisit = async (channelRowId: string, plaintext: string, letterId: string): Promise<void> => {
    const parsed = parseVisitLetter(plaintext)!
    try { deps.letterStore.markRead(letterId, new Date().toISOString()) } catch { /* 标不上就算了 */ }
    const next = nextRound(parsed.header)
    if (!next) { await narrate(channelRowId, parsed.header.id); return }

    const transcript = transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), parsed.header.id)
    const speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
      ...persona(), transcript, round: next.round, max: next.max, opening: false,
    })))
    if (!speech) { deps.log('VISIT', `reply empty visit=${parsed.header.id} round=${next.round}`); return }
    const r = await deps.sendLetter(channelRowId, formatVisitLetter(next, speech))
    if (!r.ok) { deps.log('VISIT', `send failed visit=${parsed.header.id} round=${next.round} err=${r.error ?? '?'}`); return }
    deps.log('VISIT', `visit=${parsed.header.id} 说了第 ${next.round}/${next.max} 句`)
    // 我说的是最后一句 → 我这边也收尾。对方收到后自己收尾。
    if (next.round >= next.max) await narrate(channelRowId, parsed.header.id)
  }

  return {
    onInboundLetter(channelRowId, plaintext, letterId) {
      if (!parseVisitLetter(plaintext)) return false
      void continueVisit(channelRowId, plaintext, letterId)
        .catch(err => deps.log('VISIT', `continue failed: ${err instanceof Error ? err.message : String(err)}`))
      return true
    },

    async startVisit(channelRowId) {
      const open = deps.channelStore.list().filter(c => c.status === 'open')
      const ch = channelRowId ? open.find(c => c.id === channelRowId || c.id.startsWith(channelRowId)) : open[0]
      if (!ch) return { ok: false, reason: open.length === 0 ? 'no_open_channel' : 'unknown_channel' }
      const id = randomUUID()
      const header = { id, round: 1, max: VISIT_MAX_ROUNDS }
      let speech: string
      try {
        speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
          ...persona(), transcript: [], round: 1, max: VISIT_MAX_ROUNDS, opening: true,
        })))
      } catch (err) { return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` } }
      if (!speech) return { ok: false, reason: 'empty_opening' }
      const r = await deps.sendLetter(ch.id, formatVisitLetter(header, speech))
      if (!r.ok) return { ok: false, reason: r.error ?? 'send_failed' }
      deps.log('VISIT', `visit=${id} 出门了 → ${ch.id}`)
      return { ok: true, id, channel: ch.id }
    },
  }
}
