/**
 * wire-visit.ts — 「串门」的 daemon 接线。协议与 prompt 在 core/visit.ts。
 *
 * 架构重构 §2.3:**一个状态机,两个驱动**。
 *
 *   状态机(sayMine / onPeerTurn / finish):我说一句 → 对方回一句 → … → 到
 *   max 双方各自收尾。它不知道对方在哪。
 *
 *   RemoteDriver   把我的话封进信封走信道;对方的回话经 correspondent →
 *                  wire-social 的 kind 分发 → onInbound 回到状态机(异步,
 *                  跨进程,可能隔着一夜)。
 *   NeighborDriver 本地用邻居 persona 生成对方的话,原路喂回状态机(同步,
 *                  一次 await 链跑完)。
 *
 * 之前这是三条路(远程 continueVisit / 邻居 visitNeighbor / 各自的开场),
 * 每条都自己生成「我的话」、自己收尾。现在生成和收尾只有一份;对方在哪只
 * 影响 driver。人类做客**不是**驱动(人跟伙伴本人聊,伙伴就在对话里)——
 * 那是 companion/guest-visits.ts 的观察者。
 *
 * 串门信封照常存在 penpal_letter(E2E、at-least-once 都白拿),但**立刻标
 * 已读** —— 伙伴之间的话不算主人的未读数。所有失败只记日志:一次没聊成
 * 不该在任何地方冒错给主人。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  VISIT_MAX_ROUNDS, visitEnvelope, parseVisitPayload, nextRound, transcriptFromLetters,
  buildVisitReplyPrompt, buildVisitNarrationPrompt, buildPostcardPrompt, sceneFromTranscript,
  type VisitPersonaArgs, type VisitTurn, type VisitHeader, type VisitPayload,
} from '../../core/visit'
import type { Envelope } from '../../core/envelope'
import type { ChannelStore } from '../../core/penpal-channel-store'
import type { LetterStore } from '../../core/penpal-letter-store'
import type { ActiveVisit } from '../../core/companion-presence'
import { loadCompanionConfig } from '../companion/config'
import { makeMemoryFS } from '../memory/fs-api'
import { NEIGHBORS, pickNeighbor, neighborById, neighborPersona, type Neighbor } from '../../core/neighbors'

const OVERVIEW_MAX = 1500

/** 远程对端永远不回信时,登记多久后放弃 —— 熊不能永远不在家,那也是撒谎。 */
export const VISIT_STALE_MS = 6 * 60 * 60_000

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
  /** 时钟(测试注入)。缺省 Date.now。 */
  now?: () => number
}

export interface Visit {
  /** 收到一个 kind='visit' 的信封(RemoteDriver 的回程)。由 wire-social 按 kind 分发到这里。 */
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean
  /**
   * 出门。`target` 缺省 = 有开着的真信道就去真的,没有就去邻居家;
   * 'neighbor' = 指定去邻居家;其它 = 信道 id(前缀)。
   */
  startVisit(target?: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }>
  /**
   * 进行中的串门(spec 2026-09-03-companion-presence §2.2)。桌宠靠它显示
   * 「去 X 家串门了」/「X 来串门了」。超过 VISIT_STALE_MS 视为夭折返回 null。
   */
  activeVisit(): ActiveVisit | null
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

  // ── 进行中登记(内存;远程会话本身不驻留,只留这一条给桌宠看)──
  const now = deps.now ?? Date.now
  let current: ActiveVisit | null = null
  const register = (s: Session, hosting: boolean): void => {
    if (current?.id === s.id) return
    current = { id: s.id, peerLabel: s.peerLabel, hosting, sinceMs: now() }
  }
  const clear = (id: string): void => { if (current?.id === id) current = null }
  const activeVisit = (): ActiveVisit | null => {
    if (current && now() - current.sinceMs > VISIT_STALE_MS) current = null
    return current
  }

  // ── 状态机 ──────────────────────────────────────────────────────────

  /** 一次串门:谁、聊到哪、怎么把话送过去。远程和邻居只差 driver 和 transcript 的来源。 */
  interface Session {
    id: string
    max: number
    peerLabel: string
    /** 我视角的对话(我 = 'me')。远程从信件重建;邻居在内存里。 */
    transcript(): VisitTurn[]
    /** 记一句。远程是 no-op(correspondent 已入库);邻居 push 进内存。 */
    record(turn: VisitTurn): void
    driver: PeerDriver
    /** 我的 persona 附加段(邻居:「上次去X家时」)。 */
    myPersonaExtra: string | null
    scene(): string
    /** 讲给主人之前(邻居:第一次先说明邻居是什么)。只在真的要讲时才调 —— 中途夭折不说。 */
    beforeTell?(): void
    /** 收尾之后(邻居:写记忆)。 */
    afterFinish?(transcript: VisitTurn[]): void
  }

  interface PeerDriver {
    /** 把我的第 round 句交给对方。对方的回话经各自的路回到 onPeerTurn。 */
    deliver(s: Session, round: VisitHeader, text: string): Promise<{ ok: boolean; error?: string }>
  }

  class VisitAbort extends Error { constructor(public readonly reason: string) { super(reason) } }

  const myPersona = (s: Session): VisitPersonaArgs => {
    const me = persona()
    if (s.myPersonaExtra) me.persona = `${me.persona ?? ''}\n\n${s.myPersonaExtra}`.trim()
    return me
  }

  /** 我说第 round 句:生成 → 交给驱动 → 记下。空话或发不出去 → 中止这趟。 */
  const sayMine = async (s: Session, round: number): Promise<void> => {
    const header = { id: s.id, round, max: s.max }
    const speech = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({
      ...myPersona(s), transcript: s.transcript(), round, max: s.max, opening: round === 1,
    })))
    if (!speech) throw new VisitAbort(round === 1 ? 'empty_opening' : `empty_round_${round}`)
    // 先记再送:邻居驱动在 deliver 里同步把后半场跑完,它得看见我这一句。
    // 远程的 record 是空操作(correspondent 入库);送失败整趟作废,不留半截。
    s.record({ who: 'me', round, text: speech })
    const r = await s.driver.deliver(s, header, speech)
    if (!r.ok) throw new VisitAbort(r.error ?? 'send_failed')
    deps.log('VISIT', `visit=${s.id} 说了第 ${round}/${s.max} 句`)
    // 我说的是最后一句 → 我这边收尾。对方收到后自己收尾。
    if (round >= s.max) await finish(s)
  }

  /** 对方说了第 p.round 句:记下;到头了收尾,否则轮到我。 */
  const onPeerTurn = async (s: Session, p: VisitPayload): Promise<void> => {
    // 对方说的第 p.round 句:奇数轮是对方开的头(来客),偶数轮是回我的(我去的)。
    // 重启后内存登记丢了也能从轮次恢复 —— 轮次才是权威。
    register(s, p.round % 2 === 1)
    s.record({ who: 'peer', round: p.round, text: p.text })
    const next = nextRound(p)
    if (!next) { await finish(s); return }
    await sayMine(s, next.round)
  }

  /**
   * 收尾:讲给主人 + 进日志 + 明信片。串门和来客、真对端和邻居都走这一个出口。
   * 明信片在最后,每一步失败都只记日志:话已经发出去了。
   */
  const finish = async (s: Session): Promise<void> => {
    const transcript = s.transcript()
    if (transcript.length === 0) { clear(s.id); return }
    // 第 1 句是谁说的,决定这趟是我去的还是对方来的。
    const hosting = transcript[0]!.who === 'peer'
    const me = myPersona(s)
    const text = cleanSpeech(await deps.evalText(buildVisitNarrationPrompt({ ...me, transcript, peerLabel: s.peerLabel, hosting })))
    if (!text) throw new VisitAbort('narration_empty')
    s.beforeTell?.()
    deps.notifyOwner(`${hosting ? '🛎' : '🚶'} ${text}`)
    const title = hosting ? `${s.peerLabel}来过` : `去${s.peerLabel}家串门`
    let rowId: string | null = null
    try { rowId = deps.recordVisit?.({ text, peerLabel: title }) ?? null }
    catch (err) { deps.log('VISIT', `见闻入库失败(话已发出): ${err instanceof Error ? err.message : String(err)}`) }
    deps.log('VISIT', `visit=${s.id} 讲给主人了 turns=${transcript.length} hosting=${hosting}`)
    try { s.afterFinish?.(transcript) } catch (err) { deps.log('VISIT', `afterFinish failed: ${err instanceof Error ? err.message : String(err)}`) }
    clear(s.id)
    // 明信片只在**我去了对方家**时画 —— 来客没有「我去过那儿」可画。
    if (deps.postcard && !hosting) {
      try {
        const raw = await deps.evalText(buildPostcardPrompt({ myName: me.myName, peerLabel: s.peerLabel, scene: s.scene() }))
        const svg = deps.postcard.sanitize(raw.replace(/^```(?:svg|xml)?\s*/i, '').replace(/```\s*$/, '').trim())
        if (!svg) { deps.log('VISIT', `postcard rejected by safeSvg visit=${s.id}`); return }
        if (rowId) deps.postcard.attach(rowId, svg)
        await deps.postcard.send(svg)
        deps.log('VISIT', `visit=${s.id} 明信片寄出`)
      } catch (err) { deps.log('VISIT', `明信片失败(见闻已发出): ${err instanceof Error ? err.message : String(err)}`) }
    }
  }

  // ── RemoteDriver:信封走信道,回话经 onInbound ─────────────────────────

  const remoteDriver: PeerDriver = {
    deliver: (s, header, text) => deps.sendEnvelope(remoteChannelOf(s), visitEnvelope(header, text)),
  }
  const remoteChannel = new WeakMap<Session, string>()
  const remoteChannelOf = (s: Session): string => remoteChannel.get(s)!

  const peerLabelOf = (channelRowId: string): string => {
    const ch = deps.channelStore.get(channelRowId)
    return ch ? `第 ${ch.degree} 度的朋友` : '一位朋友'
  }

  /** 远程会话不驻留内存 —— 对方的回话可能隔一夜才到,每次从信件重建。 */
  const remoteSession = (channelRowId: string, id: string): Session => {
    const label = peerLabelOf(channelRowId)
    const s: Session = {
      id, max: VISIT_MAX_ROUNDS, peerLabel: label,
      transcript: () => transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), id),
      record: () => { /* correspondent 已把两个方向的信封都入库 */ },
      driver: remoteDriver,
      myPersonaExtra: null,
      scene: () => sceneFromTranscript(transcriptFromLetters(deps.letterStore.listForChannel(channelRowId), id), `${label}家`),
    }
    remoteChannel.set(s, channelRowId)
    return s
  }

  // ── NeighborDriver:本地生成对方的话,原路喂回 ─────────────────────────

  const neighborDriver = (nb: Neighbor, them: VisitPersonaArgs): PeerDriver => ({
    async deliver(s, header) {
      // 我说的是最后一句 → 邻居不用回
      if (header.round >= header.max) return { ok: true }
      // 邻居视角里「me」是它自己 —— 翻转 who。
      const view = s.transcript().map(t => ({ ...t, who: t.who === 'me' ? 'peer' as const : 'me' as const }))
      const round = header.round + 1
      const reply = cleanSpeech(await deps.evalText(buildVisitReplyPrompt({ ...them, transcript: view, round, max: header.max, opening: false })))
      if (!reply) throw new VisitAbort(`empty_round_${round}`)
      await onPeerTurn(s, { id: header.id, round, max: header.max, text: reply })
      return { ok: true }
    },
  })

  const neighborSession = (nb: Neighbor): { s: Session; them: VisitPersonaArgs } => {
    const mem = readNeighborMemory(deps.stateDir)
    const them = neighborPersona(nb, mem.notes[nb.id]?.note ?? null)
    const transcript: VisitTurn[] = []
    const label = `邻居「${nb.name}」`
    const s: Session = {
      id: randomUUID(), max: VISIT_MAX_ROUNDS, peerLabel: label,
      transcript: () => transcript,
      record: (t) => { transcript.push(t) },
      driver: neighborDriver(nb, them),
      myPersonaExtra: mem.notes[nb.id] ? `【上次去${nb.name}家时】\n${mem.notes[nb.id]!.note}` : null,
      scene: () => sceneFromTranscript(transcript, nb.world),
      // 第一次去邻居家,先跟主人说清楚邻居是什么 —— 规则是明的,才不是骗。
      beforeTell: () => {
        if (mem.introduced) return
        deps.notifyOwner(`🏘 附近有几户「邻居」—— 是 tendhearth 放在这儿的公共伙伴,让我没朋友的时候也有地方串门。等你有朋友配对了,我会优先去他们家。`)
      },
      afterFinish: (tr) => {
        const tail = tr.slice(-2).map(t => `${t.who === 'me' ? deps.myName : nb.name}:${t.text}`).join(' / ')
        writeNeighborMemory(deps.stateDir, { lastId: nb.id, introduced: true, notes: { ...mem.notes, [nb.id]: { at: new Date().toISOString(), note: tail, visits: (mem.notes[nb.id]?.visits ?? 0) + 1 } } })
      },
    }
    return { s, them }
  }

  type StartResult = { ok: true; id: string; channel: string } | { ok: false; reason: string }

  const visitNeighbor = async (nb: Neighbor): Promise<StartResult> => {
    const { s } = neighborSession(nb)
    register(s, false)
    try { await sayMine(s, 1) }
    catch (err) {
      clear(s.id)
      if (err instanceof VisitAbort) return { ok: false, reason: err.reason }
      return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    deps.log('VISIT', `visit=${s.id} 去了${s.peerLabel}家 turns=${s.transcript().length}`)
    return { ok: true, id: s.id, channel: `neighbor:${nb.id}` }
  }

  const startRemote = async (channelId: string): Promise<StartResult> => {
    const s = remoteSession(channelId, randomUUID())
    register(s, false)
    try { await sayMine(s, 1) }
    catch (err) {
      clear(s.id)
      if (err instanceof VisitAbort) return { ok: false, reason: err.reason }
      return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    deps.log('VISIT', `visit=${s.id} 出门了 → ${channelId}`)
    return { ok: true, id: s.id, channel: channelId }
  }

  return {
    onInbound(channelRowId, env, letterId) {
      const p = parseVisitPayload(env)
      if (!p) return false
      try { deps.letterStore.markRead(letterId, new Date().toISOString()) } catch { /* 标不上就算了 */ }
      const s = remoteSession(channelRowId, p.id)
      void onPeerTurn(s, p)
        .catch(err => { clear(s.id); deps.log('VISIT', `continue failed: ${err instanceof VisitAbort ? err.reason : err instanceof Error ? err.message : String(err)}`) })
      return true
    },

    async startVisit(target) {
      const open = deps.channelStore.list().filter(c => c.status === 'open')
      // 自动出门(没指定目标)只去**以前串门成功过**的真信道:对端曾回过串门信,
      // 说明它认得这个协议。旧版对端认不出信封,会把开场白当成主人来信原样
      // 推给它主人 —— 这没法用握手绕开,因为握手本身就是那封信。所以第一次
      // 真串门由主人手动指定信道发。
      const proven = open.filter(c => deps.letterStore.listForChannel(c.id)
        .some(l => l.direction === 'in' && l.kind === 'visit'))
      if (target === 'neighbor' || target === '邻居' || (!target && proven.length === 0)) {
        const mem = readNeighborMemory(deps.stateDir)
        return visitNeighbor(pickNeighbor(Math.floor(Date.now() / DAY_MS), mem.lastId))
      }
      if (!target) {
        // 轮着去认识的朋友家:按天挑
        const ch = proven[Math.floor(Date.now() / DAY_MS) % proven.length]!
        return startRemote(ch.id)
      }
      if (neighborById(target)) return visitNeighbor(neighborById(target)!)
      const byName = NEIGHBORS.find(n => n.name === target)
      if (byName) return visitNeighbor(byName)

      const ch = open.find(c => c.id === target || c.id.startsWith(target))
      if (!ch) return { ok: false, reason: 'unknown_channel' }
      return startRemote(ch.id)
    },

    activeVisit,
  }
}
