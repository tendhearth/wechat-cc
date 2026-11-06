/**
 * 伙伴主动找主人那一拍(20 分钟一拍,从 tick-bodies.ts 原样搬出):到点的跟进 → 日程判断 → 来访叙述。
 * 日程判断在哪些事里挑,由登记进来的候选决定(ports/companion-contributions.ts,登记表在 daemon/wiring/tick-bodies.ts);这里不认识任何一个。
 */
import { createHash } from 'node:crypto'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import { join } from 'node:path'
import { loadAgentConfig } from '../../lib/agent-config'
import { loadCompanionConfig } from '../../lib/companion-config'
import { resolveEffectiveTier } from '../../domain/user-tier'
import { dueGuestVisit, guestLabel, type GuestVisitState } from './guest-visits'
import { buildGuestVisitNarrationPrompt } from '../../domain/visit'
import { makeMemoryFS } from '../../adapters/store/memory-fs'
import { parseAgenda, selectDue, markResolved, unmarkResolved } from './agenda'
import { makeMessagesStore, type MessagesStore } from '../../lib/messages-store'
import { careLevel, shouldSpeak } from './calibration'
import { readJsonFile } from '../../lib/read-json-file'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { TickDispatch } from './tick-dispatch'
import { buildPushTickText } from './tick-texts'
import type { CompanionAction, CompanionTickCtx } from '../../ports/companion-contributions'
import { writeJsonAtomic } from '../../lib/json-file'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** 来访叙述发不出去(sendText 回了 {error}):在 say 的生产者里抛,外面撤水位。 */
class GuestNarrationSendFailed extends Error { readonly code = 'not_sent' }

export function makePushTick(deps: TickDeps, dispatch: TickDispatch, actions: readonly CompanionAction[]): (opts?: { nowIso?: string }) => Promise<void> {
  const { dispatchBlockedReason, dispatchToChat } = dispatch

  /**
   * Per-chat body: agenda branch (due self-authored intention) takes
   * priority and returns on its own. Nothing due ⇒ 日程判断
   * (spec 2026-09-05-companion-plan):候选由登记进来的各功能交,每个各问一次
   * shouldSpeak(冷却 / care 档 / 无回复暂停一律不变),便宜模型只能在候选
   * 里选一个或选 none;没有模型 / 超时 / 解析失败就按老顺序(pickFallback:hunt → visit → gap)。
   * calibration 的 shouldSpeak() 仍是每一次主动外发唯一经过的关口。
   */
  async function pushTickForChat(
    chatId: string,
    ctx: { defaultChatId: string | undefined; nowIso: string; today: string; messagesStore: MessagesStore },
  ): Promise<void> {
    const { defaultChatId, nowIso, today, messagesStore } = ctx
    // 一拍一次:care 档、打猎 / 串门开关都从同一份 prefs 读(store 可能是磁盘)。
    const prefs = deps.chatPrefs.get(chatId)
    const level = careLevel(chatId, prefs, defaultChatId)
    // 能不能开口只有门说了算(S1):关心档关着(别烦我)/ 免打扰时段里 ⇒ 这一拍什么都不做 —— 在任何登记、任何模型调用之前问
    // (到期的 agenda 不打勾,时段过了照常发)。只问不记账;真发的那一下(dispatchToChat)经 say,那一次才记。
    // 门里的「送不到」不在这里挡:串门不走微信,送不送得到由下面的预判闸按候选分。没接门 ⇒ 不开口(同 dispatchToChat)。
    const gate = deps.speech?.peek({ kind: 'companion', chatId, nowMs: Date.parse(nowIso) })
    if (!gate) { deps.log('CARE', `skip chat=${chatId} reason=speech_not_wired`); return }
    if ('drop' in gate || ('defer' in gate && gate.reason !== 'undeliverable')) {
      // 关心档关着(别的对话没设过就是关)一拍一拍都会走到这里 ⇒ 不记日志,和以前一样静默;免打扰照旧记一行。
      if (gate.reason !== 'care_off') deps.log('CARE', `skip chat=${chatId} reason=${gate.reason}`)
      return
    }

    const lastInboundAtIso = (await messagesStore.latestInboundTs(chatId)) ?? undefined
    const ledger = deps.careLedger.get(chatId)
    const submissions: Promise<unknown>[] = []

    // Gate on the agenda: only wake the agent if a self-authored intention is
    // due (per-chat memory/<chatId>/agenda.md).
    const agendaFs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', chatId), fences: makeMemoryFactsStore(deps.db).fence })
    const agendaMd = agendaFs.read('agenda.md') ?? ''
    const due = selectDue(parseAgenda(agendaMd), today)

    if (due.length > 0) {
      // Fire the single oldest-due item this tick; the rest wait for later ticks.
      const item = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))[0]!
      const decision = shouldSpeak({ kind: 'agenda', level, nowIso, ledger, lastInboundAtIso })
      if (!decision.ok) {
        deps.log('CARE', `skip chat=${chatId} kind=agenda reason=${decision.reason}`)
      } else submissions.push(dispatchToChat(chatId, {
        claim: () => {
          const updated = markResolved(agendaMd, item, today)
          if (updated !== agendaMd) agendaFs.write('agenda.md', updated)
          const ticket = deps.careLedger.claim(chatId, nowIso)
          // 撤回只撤这一次(第二轮评审 #194):只把我们打勾的那一行放回去,文件里期间的其他改动留着;
          // 台账按回执定向撤。
          return () => {
            if (updated !== agendaMd) {
              const cur = agendaFs.read('agenda.md') ?? ''
              const back = unmarkResolved(cur, item, today)
              if (back !== cur) agendaFs.write('agenda.md', back)
            }
            deps.careLedger.unclaim(chatId, ticket)
          }
        },
        buildText: (style) => buildPushTickText({ nowIso, defaultChatId: chatId, intention: item.body, avoid: prefs.avoid }, style),
        nowIso, source: 'agenda', summary: item.body.slice(0, 1000),
        ref: `agenda:${createHash('sha256').update(`${chatId}\0${item.due}\0${item.body}`).digest('hex')}`,
        payloadRef: { due: item.due ?? null, item: createHash('sha256').update(item.body).digest('hex') },
        validate: async at => (await messagesStore.latestInboundTs(chatId)) === (lastInboundAtIso ?? null) && selectDue(parseAgenda(agendaFs.read('agenda.md') ?? ''), today).some(i => i.due === item.due && i.body === item.body) && shouldSpeak({ kind: 'agenda', level: careLevel(chatId, deps.chatPrefs.get(chatId), defaultChatId), nowIso: new Date(at).toISOString(), ledger: deps.careLedger.get(chatId), lastInboundAtIso }).ok,

      }))
    }

    // Every qualified source contributes to one presence snapshot. No local picker.
    const actx: CompanionTickCtx = { chatId, isOwnerChat: chatId === defaultChatId, nowIso, level, prefs, ledger, lastInboundAtIso }
    for (const action of actions) {
      const speakLevel = action.speakLevel(actx)
      if (speakLevel === null) continue
      const decision = shouldSpeak({ kind: action.id, level: speakLevel, nowIso, ledger, lastInboundAtIso })
      if (!decision.ok) { deps.log('CARE', `skip chat=${chatId} kind=${action.id} reason=${decision.reason}`); continue }
      if (action.needsWechat) { const blocked = dispatchBlockedReason(chatId); if (blocked) { deps.log('PLAN', `skip chat=${chatId} reason=${blocked}`); continue } }
      const source = action.id
      let info: ReturnType<NonNullable<CompanionAction['planInfo']>> | undefined
      const targets = () => { try { info = action.planInfo?.(actx) } catch { info = undefined }; return info?.targets?.slice(0, 5).map(t => t.id) ?? [] }
      submissions.push(deps.speech!.propose({
        source, kind: 'companion', chatId, nowMs: Date.parse(nowIso),
        summary: source, ref: `${source}:${chatId}:${nowIso}`, payloadRef: { tick: nowIso },
        getTargets: targets, context: async () => info?.context ?? {},
        validate: async (nowMs) => {
          if ((await messagesStore.latestInboundTs(chatId)) !== (lastInboundAtIso ?? null)) return false
          const livePrefs = deps.chatPrefs.get(chatId)
          if (JSON.stringify(livePrefs.avoid) !== JSON.stringify(prefs.avoid)) return false
          const current = { ...actx, prefs: livePrefs, level: careLevel(chatId, livePrefs, defaultChatId), ledger: deps.careLedger.get(chatId) }
          const lv = action.speakLevel(current)
          return lv !== null && shouldSpeak({ kind: source, level: lv, nowIso: new Date(nowMs).toISOString(), ledger: current.ledger, lastInboundAtIso }).ok && (!action.needsWechat || !dispatchBlockedReason(chatId))
        },
      }, async (outbound, target) => {
        const result = await action.run(actx, target, outbound)
        if (result === 'refused') throw Object.assign(new Error('network unprotected'), { code: 'network_unprotected' })
      }))
    }
    await Promise.all(submissions)

  }

  async function pushTick(opts?: { nowIso?: string }): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    const nowIso = opts?.nowIso ?? new Date().toISOString()
    const today = nowIso.slice(0, 10)

    // Candidates: the owner's chat (if configured) plus every chat that has
    // ever set a care preference — ordered, deduped.
    const candidates: string[] = []
    if (cfg.default_chat_id) candidates.push(cfg.default_chat_id)
    for (const c of deps.chatPrefs.list()) {
      if (!candidates.includes(c)) candidates.push(c)
    }
    if (candidates.length === 0) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }

    const messagesStore = makeMessagesStore(deps.db)

    // Sequential, one chat's error must not abort the others.
    for (const chatId of candidates) {
      try {
        await pushTickForChat(chatId, { defaultChatId: cfg.default_chat_id ?? undefined, nowIso, today, messagesStore })
      } catch (err) {
        if (isNetworkUnprotectedError(err)) deps.log('SCHED', `companion tick skipped for chat=${chatId}: network unprotected — nothing sent, nothing recorded; next tick retries`)
        else deps.log('SCHED', `companion tick failed for chat=${chatId}: ${errMsg(err)}`)
      }
    }

    // 人类做客(2026-09-03,companion/guest-visits.ts):主人的朋友来聊过、
    // 走了 30 分钟 → 伙伴跟主人顺口提一句。每拍都看,自己有水位,不会重复。
    if (cfg.default_chat_id) {
      try { await guestVisitPass(cfg.default_chat_id, nowIso, messagesStore) }
      catch (err) { deps.log('VISIT', `guest pass failed: ${errMsg(err)}`) }
    }
  }

  /**
   * 挑出「不是主人的」chat 里刚聊完的,讲给主人。只讲个大概 —— 来的是主人的
   * 朋友,它跟伙伴说的话不该被逐字转给第三个人(prompt 里明写)。
   */
  async function guestVisitPass(ownerChat: string, nowIso: string, messagesStore: MessagesStore): Promise<void> {
    // 能不能开口全交给 SpeechPolicy(第三批 3a):主人那条对话的 care 档(别烦我 ⇒ 不说,这次来访记作看过)、
    // 免打扰(推后)、两条路都送不到(推后,不调模型 —— no-retry-storm)。判的是**主人那条**对话,不是访客那条。
    // 模型调用放在 say 的生产者里:被拒 / 推后时一个 token 都不花。
    if (!deps.speech) { deps.log('VISIT', 'guest pass skipped: speech policy not wired'); return }
    const speech = deps.speech
    const statePath = join(deps.stateDir, 'companion', 'guest-visits.json')
    const state: GuestVisitState = (() => {
      try { const j = readJsonFile<Partial<GuestVisitState>>(statePath); return { narrated: j.narrated ?? {}, visits: j.visits ?? {} } }
      catch { return { narrated: {}, visits: {} } }
    })()
    const access = deps.loadAccess()
    const nowMs = Date.parse(nowIso)
    let changed = false
    try {
      for (const chatId of await messagesStore.listChatIds()) {
        if (chatId === ownerChat) continue
        if (resolveEffectiveTier(chatId, access, deps.permissionMode) === 'admin') continue
        const latestInboundTs = await messagesStore.latestInboundTs(chatId)
        if (!latestInboundTs) continue
        const mark = state.narrated[chatId]
        if (mark && latestInboundTs <= mark) continue
        const rows = await messagesStore.listSince(chatId, mark ?? '', 40)
        const due = dueGuestVisit({
          chatId, latestInboundTs,
          since: rows.map(r => ({ direction: r.direction, text: r.text, ts: r.ts })),
        }, state, nowMs)
        if (!due) continue
        // 先记水位再讲:讲到一半 daemon 重启,不该下一拍再讲一遍。
        const priorMark = state.narrated[chatId]
        let claimed = false
        const claim = () => {
          claimed = true
          state.narrated[chatId] = latestInboundTs
          state.visits = { ...(state.visits ?? {}), [chatId]: ((state.visits ?? {})[chatId] ?? 0) + 1 }
          changed = true
        }
        const uncount = (): void => {
          if (!claimed) return
          const n = (state.visits ?? {})[chatId] ?? 0
          if (n > 1) state.visits = { ...state.visits, [chatId]: n - 1 }
          else if (state.visits) { const { [chatId]: _drop, ...rest } = state.visits; state.visits = rest }
        }
        // 没讲出去 ⇒ 只撤这一位的水位和这一次的计数,前面几位这一拍讲完的照常保留(评审 #194)
        const unmark = (): void => {
          if (!claimed) return
          if (priorMark === undefined) delete state.narrated[chatId]; else state.narrated[chatId] = priorMark
          uncount()
        }
        const name = guestLabel(deps.boot.conversationStore?.getIdentity(chatId)?.last_user_name, chatId)
        let told = ''
        let noModel = false
        let outcome: Awaited<ReturnType<typeof speech.say>>
        try {
          outcome = await speech.propose({ source: 'guest', summary: `${name} visited`, ref: `guest:${chatId}:${latestInboundTs}`, payloadRef: { chatId, latestInboundTs }, kind: 'guest_visit', chatId: ownerChat, nowMs, validate: async () => (await messagesStore.latestInboundTs(chatId)) === latestInboundTs }, async (turn) => {
            claim()
            let sending = false
            try {
            const evalText = deps.boot.registry.getStrongEval?.(deps.boot.defaultProviderId) ?? deps.boot.registry.getCheapEval()
            // 一时没有可用模型:这次做客不能就此吞掉,等有模型了再讲
            if (!evalText) { noModel = true; return }
            const cfgAgent = loadAgentConfig(deps.stateDir)
            const raw = await evalText(buildGuestVisitNarrationPrompt({
              myName: cfgAgent.bot_name?.trim() || '我',
              persona: null, ownerOverview: null,
              disclosurePolicy: cfgAgent.social_disclosure_policy ?? '别转述朋友的私事。',
              guestName: name,
              lines: due.map(m => ({ who: m.direction === 'in' ? 'guest' as const : 'me' as const, text: m.text })),
            }))
            const text = raw.trim().replace(/^[「『"“]+|[」』"”]+$/g, '')
            if (!text) return
            // sendText **不抛**,失败是回 {error} —— 一定要看(盘点 10-21:以前只有 catch,失败时水位照记,这次来访就丢了)
            let r: { msgId: string; error?: string }
            sending = true
            try { r = await turn.sendText(ownerChat, text) } catch (err) { throw new GuestNarrationSendFailed(errMsg(err)) }
            if (r.error) throw new GuestNarrationSendFailed(r.error)
            told = text
            } catch (err) {
              if (!sending && !isNetworkUnprotectedError(err)) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 'not_sent' })
              throw err
            }
          })
        } catch (err) {
          // 评审 #193 P2-3:讲述被网络守护拒了;或者发不出去 —— 没讲过,这一位的水位放回去;这一拍到此为止
          // (前面已经讲完的几位照常落盘),下一拍再讲。
          if (isNetworkUnprotectedError(err)) {
            unmark()
            deps.log('VISIT', `guest narration skipped: chat=${chatId} — network unprotected; watermark unchanged, next tick retries`)
            break
          }
          if (err instanceof GuestNarrationSendFailed) {
            unmark()
            deps.log('VISIT', `guest narration send failed: chat=${chatId} — watermark unchanged, next tick retries: ${err.message}`)
            break
          }
          throw err
        }
        if ('drop' in outcome) {
          // 别烦我:这次来访记作看过(水位留着、不算讲过),以后打开主动关心也不翻旧账
          uncount()
          state.narrated[chatId] = latestInboundTs
          changed = true
          deps.log('VISIT', `guest visit not told: chat=${chatId} — ${outcome.reason}; marked as seen`)
          continue
        }
        if ('defer' in outcome && outcome.reason === 'delivery_unknown') { uncount(); continue } // at-most-once: preserve the seen watermark, never claim confirmed narration
        if ('defer' in outcome) { unmark(); break }   // 免打扰 / 都送不到:这一拍什么都不动,之后照讲
        if (noModel) { unmark(); continue }
        if (!told) { unmark(); continue }
        try { deps.journal?.recordVisit?.({ chatId: ownerChat, text: told, peerLabel: `${name}来过`, nowIso }) }
        catch (err) { deps.log('VISIT', `guest 见闻入库失败: ${errMsg(err)}`) }
        deps.log('VISIT', `guest visit told: chat=${chatId} name=${name} lines=${due.length}`)
      }
    } finally {
      // 中途抛错也要把已讲完的几位落盘,否则下一拍重讲(重复发给主人)
      if (changed) {
        try { writeJsonAtomic(statePath, state) }
        catch (err) { deps.log('VISIT', `guest state write failed: ${errMsg(err)}`) }
      }
    }
  }

  return pushTick
}
