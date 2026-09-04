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
  VISIT_MAX_ROUNDS, visitEnvelope, parseVisitPayload, nextRound, transcriptFromLetters,
  buildVisitReplyPrompt, buildVisitNarrationPrompt, buildPostcardPrompt, sceneFromTranscript,
  type VisitPersonaArgs, type VisitTurn,
} from '../../core/visit'
import type { Envelope } from '../../core/envelope'
import type { ChannelStore } from '../../core/penpal-channel-store'
import type { LetterStore } from '../../core/penpal-letter-store'
import { loadCompanionConfig } from '../companion/config'
import { makeMemoryFS } from '../memory/fs-api'
import { NEIGHBORS, pickNeighbor, neighborById, neighborPersona, type Neighbor } from '../../core/neighbors'

const OVERVIEW_MAX = 1500

export interface VisitDeps {
  stateDir: string
  channelStore: ChannelStore
  letterStore: LetterStore
  /** 发一个信封到信道(correspondent.sendEnvelope)。 */
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string }>
  /** 生成伙伴的话。strongEval 优先(串门是要有性格的,不是分类任务)。 */
  evalText(prompt: string): Promise<string>
  myName: string
  disclosurePolicy: string
  /** 给主人发一句话;没有主人 chat 时是 no-op。 */
  notifyOwner(text: string): void
  /** 见闻进日志(journal kind='visit')。可选:没接就只发微信。返回行 id 以便补明信片。 */
  recordVisit?(args: { text: string; peerLabel: string }): string | null
  /**
   * 明信片(可选)。draw = 模型出 SVG → 调用方 safeSvg;send = 栅格化后发给主人
   * (macOS 才有栅格化,别的平台 send 可以是 no-op —— 桌面端照样能看内联 SVG)。
   */
  postcard?: {
    sanitize(svg: string): string | null
    attach(rowId: string, svg: string): void
    send(svg: string): Promise<void>
  }
  log(tag: string, line: string): void
}

export interface Visit {
  /** 收到一个 kind='visit' 的信封。由 wire-social 按 kind 分发到这里。 */
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean
  /**
   * 出门。`target` 缺省 = 有开着的真信道就去真的,没有就去邻居家;
   * 'neighbor' = 指定去邻居家;其它 = 信道 id(前缀)。
   */
  startVisit(target?: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }>
}

import { readNeighborMemory, writeNeighborMemory } from '../companion/neighbor-memory'
export { readNeighborMemory, writeNeighborMemory }

const DAY_MS = 86_400_000

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

  /**
   * 讲给主人 + 进背包 + 明信片。串门和来客、真对端和邻居都走这一个出口。
   * 明信片在最后,而且每一步失败都只记日志:话已经发出去了。
   */
  const tellOwner = async (a: { transcript: VisitTurn[]; peerLabel: string; hosting: boolean; visitId: string; scene: string }): Promise<boolean> => {
    const me = persona()
    const text = cleanSpeech(await deps.evalText(buildVisitNarrationPrompt({ ...me, transcript: a.transcript, peerLabel: a.peerLabel, hosting: a.hosting })))
    if (!text) { deps.log('VISIT', `narration empty visit=${a.visitId}`); return false }
    deps.notifyOwner(`${a.hosting ? '🛎' : '🚶'} ${text}`)
    const title = a.hosting ? `${a.peerLabel}来过` : `去${a.peerLabel}家串门`
    let rowId: string | null = null
    try { rowId = deps.recordVisit?.({ text, peerLabel: title }) ?? null }
    catch (err) { deps.log('VISIT', `见闻入库失败(话已发出): ${err instanceof Error ? err.message : String(err)}`) }
    deps.log('VISIT', `visit=${a.visitId} 讲给主人了 turns=${a.transcript.length} hosting=${a.hosting}`)
    // 明信片只在**我去了对方家**时画 —— 来客没有「我去过那儿」可画。
    if (deps.postcard && !a.hosting) {
      try {
        const raw = await deps.evalText(buildPostcardPrompt({ myName: me.myName, peerLabel: a.peerLabel, scene: a.scene }))
        const svg = deps.postcard.sanitize(raw.replace(/^```(?:svg|xml)?\s*/i, '').replace(/```\s*$/, '').trim())
        if (!svg) { deps.log('VISIT', `postcard rejected by safeSvg visit=${a.visitId}`); return true }
        if (rowId) deps.postcard.attach(rowId, svg)
        await deps.postcard.send(svg)
        deps.log('VISIT', `visit=${a.visitId} 明信片寄出`)
      } catch (err) { deps.log('VISIT', `明信片失败(见闻已发出): ${err instanceof Error ? err.message : String(err)}`) }
    }
    return true
  }

  const narrate = async (channelRowId: string, visitId: string): Promise<void> => {
    const transcript = transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), visitId)
    if (transcript.length === 0) return
    // 第 1 句是谁说的,决定这趟是我去的还是对方来的。
    const hosting = transcript[0]!.who === 'peer'
    const label = peerLabel(channelRowId)
    await tellOwner({ transcript, peerLabel: label, hosting, visitId, scene: sceneFromTranscript(transcript, `${label}家`) })
  }

  const continueVisit = async (channelRowId: string, p: import('../../core/visit').VisitPayload, letterId: string): Promise<void> => {
    try { deps.letterStore.markRead(letterId, new Date().toISOString()) } catch { /* 标不上就算了 */ }
    const next = nextRound(p)
    if (!next) { await narrate(channelRowId, p.id); return }

    const transcript = transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), p.id)
    const speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
      ...persona(), transcript, round: next.round, max: next.max, opening: false,
    })))
    if (!speech) { deps.log('VISIT', `reply empty visit=${p.id} round=${next.round}`); return }
    const r = await deps.sendEnvelope(channelRowId, visitEnvelope(next, speech))
    if (!r.ok) { deps.log('VISIT', `send failed visit=${p.id} round=${next.round} err=${r.error ?? '?'}`); return }
    deps.log('VISIT', `visit=${p.id} 说了第 ${next.round}/${next.max} 句`)
    // 我说的是最后一句 → 我这边也收尾。对方收到后自己收尾。
    if (next.round >= next.max) await narrate(channelRowId, p.id)
  }

  /**
   * 去邻居家:整趟在本进程里跑完。两边都是主人自己的模型生成 —— 邻居的
   * persona 在 core/neighbors.ts。没有信件、没有网络;对话只活在这个函数
   * 里,结束时给主人讲一段并进背包,再给这位邻居记一条「上次聊到」。
   */
  const visitNeighbor = async (nb: Neighbor): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }> => {
    const id = randomUUID()
    const mem = readNeighborMemory(deps.stateDir)
    const me = persona()
    const them = neighborPersona(nb, mem.notes[nb.id]?.note ?? null)
    if (mem.notes[nb.id]) me.persona = `${me.persona ?? ''}\n\n【上次去${nb.name}家时】\n${mem.notes[nb.id]!.note}`.trim()
    const transcript: import('../../core/visit').VisitTurn[] = []
    try {
      for (let round = 1; round <= VISIT_MAX_ROUNDS; round++) {
        const mine = round % 2 === 1
        const speaker = mine ? me : them
        // 对方视角里,「me」是它自己 —— 翻转 who
        const view = transcript.map(t => ({ ...t, who: mine ? t.who : (t.who === 'me' ? 'peer' as const : 'me' as const) }))
        const speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
          ...speaker, transcript: view, round, max: VISIT_MAX_ROUNDS, opening: round === 1,
        })))
        if (!speech) return { ok: false, reason: `empty_round_${round}` }
        transcript.push({ who: mine ? 'me' : 'peer', round, text: speech })
      }
    } catch (err) { return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` } }

    const label = `邻居「${nb.name}」`
    // 第一次去邻居家,顺手跟主人说清楚邻居是什么 —— 规则是明的,才不是骗。
    if (!mem.introduced) {
      deps.notifyOwner(`🏘 附近有几户「邻居」—— 是 tendhearth 放在这儿的公共伙伴,让我没朋友的时候也有地方串门。等你有朋友配对了,我会优先去他们家。`)
    }
    const told = await tellOwner({ transcript, peerLabel: label, hosting: false, visitId: id, scene: sceneFromTranscript(transcript, nb.world) })
    if (!told) return { ok: false, reason: 'narration_empty' }
    // 邻居这边记住这趟:最后两句,够下次接话
    const tail = transcript.slice(-2).map(t => `${t.who === 'me' ? me.myName : nb.name}:${t.text}`).join(' / ')
    writeNeighborMemory(deps.stateDir, { lastId: nb.id, introduced: true, notes: { ...mem.notes, [nb.id]: { at: new Date().toISOString(), note: tail, visits: (mem.notes[nb.id]?.visits ?? 0) + 1 } } })
    deps.log('VISIT', `visit=${id} 去了${label}家,讲给主人了 turns=${transcript.length}`)
    return { ok: true, id, channel: `neighbor:${nb.id}` }
  }

  return {
    onInbound(channelRowId, env, letterId) {
      const p = parseVisitPayload(env)
      if (!p) return false
      void continueVisit(channelRowId, p, letterId)
        .catch(err => deps.log('VISIT', `continue failed: ${err instanceof Error ? err.message : String(err)}`))
      return true
    },

    async startVisit(target) {
      const open = deps.channelStore.list().filter(c => c.status === 'open')
      // 自动出门(没指定目标)只去**以前串门成功过**的真信道:对端曾回过串门信,
      // 说明它认得这个协议。旧版对端认不出头部,会把开场白当成主人来信原样
      // 推给它主人(「📬 某人给你写信了:⟪visit id=…⟫」)—— 这没法用握手绕开,
      // 因为握手本身就是那封信。所以第一次真串门由主人手动指定信道发。
      const proven = open.filter(c => deps.letterStore.listForChannel(c.id)
        .some(l => l.direction === 'in' && l.kind === 'visit'))
      if (target === 'neighbor' || target === '邻居' || (!target && proven.length === 0)) {
        const mem = readNeighborMemory(deps.stateDir)
        return visitNeighbor(pickNeighbor(Math.floor(Date.now() / DAY_MS), mem.lastId))
      }
      if (!target) {
        // 轮着去认识的朋友家:按天挑
        const ch = proven[Math.floor(Date.now() / DAY_MS) % proven.length]!
        return startRealVisit(ch.id)
      }
      if (target && neighborById(target)) return visitNeighbor(neighborById(target)!)
      if (target && NEIGHBORS.some(n => n.name === target)) return visitNeighbor(NEIGHBORS.find(n => n.name === target)!)

      const ch = open.find(c => c.id === target || c.id.startsWith(target))
      if (!ch) return { ok: false, reason: 'unknown_channel' }
      return startRealVisit(ch.id)
    },
  }

  async function startRealVisit(channelId: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }> {
    const id = randomUUID()
    const header = { id, round: 1, max: VISIT_MAX_ROUNDS }
    let speech: string
    try {
      speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
        ...persona(), transcript: [], round: 1, max: VISIT_MAX_ROUNDS, opening: true,
      })))
    } catch (err) { return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` } }
    if (!speech) return { ok: false, reason: 'empty_opening' }
    const r = await deps.sendEnvelope(channelId, visitEnvelope(header, speech))
    if (!r.ok) return { ok: false, reason: r.error ?? 'send_failed' }
    deps.log('VISIT', `visit=${id} 出门了 → ${channelId}`)
    return { ok: true, id, channel: channelId }
  }
}
