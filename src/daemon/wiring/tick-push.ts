/**
 * 伙伴主动找主人那一拍(20 分钟一拍,从 tick-bodies.ts 原样搬出):到点的跟进 → 日程判断 → 来访叙述。
 * 日程判断在哪些事里挑,由登记进来的候选决定(daemon/companion/contributions.ts,登记表在 tick-bodies.ts);这里不认识任何一个。
 */
import { inQuietHours } from '../../domain/quiet-hours'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadAgentConfig } from '../../lib/agent-config'
import { loadCompanionConfig } from '../companion/config'
import { makeObservationsStore } from '../observations/store'
import { resolveEffectiveTier } from '../../domain/user-tier'
import { dueGuestVisit, guestLabel, type GuestVisitState } from '../companion/guest-visits'
import { buildGuestVisitNarrationPrompt } from '../../domain/visit'
import { makeMemoryFS } from '../memory/fs-api'
import { parseAgenda, selectDue, markResolved, unmarkResolved } from '../companion/agenda'
import { makeMessagesStore, type MessagesStore } from '../../lib/messages-store'
import { careLevel, shouldSpeak } from '../companion/calibration'
import { readJsonFile } from '../../lib/read-json-file'
import { judgeCandidates, buildPlanPrompt, parsePlan, pickFallback, constrainPlan, shouldReask, formatLocal, PLAN_EVAL_TIMEOUT_MS, PLAN_MAX_OBSERVATIONS, type Consideration, type PlanAction, type PlanContext, type PlanLogEntry } from '../../domain/companion-plan'
import { readPlanLog, appendPlanLog } from '../companion/plan-memory'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { TickDispatch } from './tick-dispatch'
import { buildPushTickText } from './tick-texts'
import type { CompanionAction, CompanionTickCtx } from '../companion/contributions'
import { writeJsonAtomic } from '../../lib/json-file'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** 来访叙述发不出去(sendText 回了 {error}):在 say 的生产者里抛,外面撤水位。 */
class GuestNarrationSendFailed extends Error {}

export function makePushTick(deps: TickDeps, dispatch: TickDispatch, actions: readonly CompanionAction[]): (opts?: { nowIso?: string }) => Promise<void> {
  const { dispatchBlockedReason, dispatchToChat } = dispatch
  const byId = new Map(actions.map(a => [a.id, a] as const))

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
    if (level === 'off') return // care off = master proactive kill-switch: no agenda/gap/hunt sends (別烦我 silences everything); hunt's own pref only gates hunt within a care-enabled chat
    // 免打扰时段(第二轮对标 #5):主人设的这段时间 CC 不主动找他(agenda / 问候 / 打猎 / 串门 / 记忆都等到之后)。
    // 在任何登记之前拦 —— 到期的 agenda 不打勾,时段过了照常发。
    if (inQuietHours(prefs.quiet, Date.parse(nowIso), loadCompanionConfig(deps.stateDir).timezone ?? 'Asia/Shanghai')) {
      deps.log('CARE', `skip chat=${chatId} reason=quiet_hours`)
      return
    }

    const lastInboundAtIso = (await messagesStore.latestInboundTs(chatId)) ?? undefined
    const ledger = deps.careLedger.get(chatId)

    // Gate on the agenda: only wake the agent if a self-authored intention is
    // due (per-chat memory/<chatId>/agenda.md).
    const agendaFs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', chatId) })
    const agendaMd = agendaFs.read('agenda.md') ?? ''
    const due = selectDue(parseAgenda(agendaMd), today)

    if (due.length > 0) {
      // Fire the single oldest-due item this tick; the rest wait for later ticks.
      const item = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))[0]!
      const decision = shouldSpeak({ kind: 'agenda', level, nowIso, ledger, lastInboundAtIso })
      if (!decision.ok) {
        deps.log('CARE', `skip chat=${chatId} kind=agenda reason=${decision.reason}`)
        return
      }
      await dispatchToChat(chatId, {
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
      })
      return
    }

    // ── 日程判断(spec 2026-09-05-companion-plan)──────────────────────────
    // 候选由各功能交(daemon/companion/contributions.ts,登记在 tick-bodies.ts),按登记顺序各问一次 shouldSpeak
    // (冷却 / care 门 / 无回复暂停一律不变);模型只能在候选里选一个或选 none。没有模型 / 超时 / 解析失败 → 固定顺序。
    const actx: CompanionTickCtx = { chatId, isOwnerChat: chatId === defaultChatId, nowIso, level, prefs, ledger, lastInboundAtIso }
    const considered: Consideration[] = []
    for (const a of actions) {
      const lv = a.speakLevel(actx)
      if (lv !== null) considered.push({ action: a.id, level: lv })
    }
    const { candidates: allCandidates, rejected } = judgeCandidates(considered, { nowIso, ledger, lastInboundAtIso }, shouldSpeak)
    for (const r of rejected) deps.log('CARE', `skip chat=${chatId} kind=${r.action} reason=${r.reason}`)
    if (allCandidates.length === 0) return

    // 发不出去就别先烧模型:断线 / 会话在忙的时候,要经微信送的候选(打猎、问候)
    // 反正到不了主人手里(memory: no-retry-storm-when-disconnected)。needsWechat:false 的
    // 是例外 —— 串门走笔友信道,不是一条微信,链路断了照样能出门。
    // 这道预判闸本身也可能抛(resolveDispatch 里 loadAccess / loadProjects /
    // getMode / isInFlight 都是真调用):抛了不该把一拍能出的门(visit)也
    // 一起掀翻 —— 当作没堵,真发那一步(dispatchToChat)还会再判一次。
    let blocked: string | null
    try { blocked = dispatchBlockedReason(chatId) }
    catch (err) { deps.log('PLAN', `预判闸探测失败,当作没堵(真发前还会再判一次): ${errMsg(err)}`); blocked = null }
    let candidates = allCandidates
    if (blocked) {
      candidates = allCandidates.filter(c => byId.get(c.action)?.needsWechat === false)
      if (candidates.length === 0) { deps.log('PLAN', `skip chat=${chatId} reason=${blocked}`); return }
    }

    const today10 = formatLocal(nowIso).slice(0, 10)
    const nowMs = Date.parse(nowIso)
    const run = async (action: PlanAction, target?: string): Promise<boolean | 'refused'> => {
      const a = action === 'none' ? undefined : byId.get(action)
      return a ? await a.run(actx, target) : false
    }
    const record = (decision: PlanAction, why: string, source: PlanLogEntry['source']) => {
      try { appendPlanLog(deps.stateDir, today10, { at: nowIso, chatId, candidates: candidates.map(c => c.action), decision, why, source }) }
      catch (err) { deps.log('PLAN', `plan-log 写不进去(不影响这一拍): ${errMsg(err)}`) }
    }
    /**
     * 先做,做完才记 —— 台账写的是「做过了」,不是「打算做」。真发那一步还有
     * 自己的闸(断线 / 会话在忙),记在前面就会把没发出去的一拍记成发过了,
     * 下一拍的退避与 earlierToday 都跟着骗人。做砸了也要记(标 `(failed) `),
     * 然后照抛 —— 上层每个 chat 各自 catch。runner 自己判断「真发出去了
     * 没有」:两道闸之间状态变了(比如预判过闸之后、真发之前微信掉线 /
     * 会话又忙起来了)导致送时被跳过 → 标 `(skipped) `,不算「做过了」。
     */
    const runAndRecord = async (action: PlanAction, why: string, source: PlanLogEntry['source'], target?: string) => {
      let dispatched: boolean | 'refused'
      try { dispatched = await run(action, target) } catch (err) {
        // 评审 #193 P2-3:网络守护拒了那一次模型调用 —— 什么都没做,不进台账,下一拍再来。
        if (isNetworkUnprotectedError(err)) dispatched = 'refused'
        else { record(action, `(failed) ${why}`, source); throw err }
      }
      if (dispatched === 'refused') { deps.log('PLAN', `skip chat=${chatId} action=${action}: network unprotected — nothing sent, not recorded; next tick retries`); return }
      record(action, dispatched ? why : `(skipped) ${why}`, source)
    }
    const fallback = async (reason: string) => {
      const pick = pickFallback(candidates)!
      deps.log('PLAN', `fallback chat=${chatId} reason=${reason} → ${pick}`)
      await runAndRecord(pick, `fallback:${reason}`, 'fallback')
    }

    const evaluate = deps.planEval ?? deps.boot.registry.getCheapEval() ?? null
    if (!evaluate) { await fallback('no_evaluator'); return }

    const earlier = readPlanLog(deps.stateDir, today10)
    if (!shouldReask(earlier, chatId, nowMs)) { deps.log('PLAN', `skip chat=${chatId} reason=backoff`); return }

    // 每个登记的候选交它那一格处境与可点名的去处(只读、自己 catch)—— 不管这一拍它是不是候选,同以前。
    const targetsOf = new Map<PlanAction, string[]>()
    let planParts: Partial<Pick<PlanContext, 'journal' | 'social'>> = {}
    for (const a of actions) {
      let info: ReturnType<NonNullable<CompanionAction['planInfo']>> | undefined
      try { info = a.planInfo?.(actx) } catch { info = undefined }   // 某一格读不出来 = 那一格没接线,不掀翻这一拍
      if (!info) continue
      if (info.targets) targetsOf.set(a.id, info.targets.map(t => t.id))
      if (info.context) planParts = { ...planParts, ...info.context }
    }
    const planCtx = await buildContext()
    deps.log('PLAN', `ask chat=${chatId} candidates=[${candidates.map(c => c.action).join(',')}]`)

    let raw: string
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      raw = await Promise.race([
        evaluate(buildPlanPrompt(planCtx)),
        // 超时也要收摊:问成功了还挂着一个 20 秒的定时器,会把事件循环
        // (重启、测试拆台)按住不放。
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), PLAN_EVAL_TIMEOUT_MS) }),
      ])
    } catch (err) {
      // 评审 #193 P2-3:判断这一步被网络守护拒了 = 这一拍没判断过。不按老顺序硬做(那等于没问
      // 就替它做了决定),不进 plan-log(也就不退避),下一拍再问。
      if (isNetworkUnprotectedError(err)) {
        deps.log('PLAN', `skip chat=${chatId}: plan judge needs a protected provider and the network is unprotected — nothing done; next tick retries`)
        return
      }
      await fallback(err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error')
      return
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const parsed = parsePlan(raw)
    if (!parsed.ok) { await fallback(`parse:${parsed.reason}`); return }
    const { plan, downgraded } = constrainPlan(parsed.plan, candidates, targetsOf.get(parsed.plan.action) ?? [])
    if (downgraded) deps.log('PLAN', `downgraded chat=${chatId} action=${parsed.plan.action} → none`)
    deps.log('PLAN', `→ ${plan.action}${plan.target ? ` target=${plan.target}` : ''} (${plan.why})`)
    // none / 降级:什么都不会跑,当场记。
    if (plan.action === 'none') { record('none', plan.why, downgraded ? 'downgraded' : 'model'); return }
    await runAndRecord(plan.action, plan.why, 'model', plan.target)

    /**
     * 给伙伴看的处境。只读,每个来源各自 try/catch —— 判断这一步永远不该
     * 因为某个子系统没接线 / 抛了而让整拍失败。
     */
    async function buildContext(): Promise<PlanContext> {
      const hoursAgo = (iso?: string) => iso && !Number.isNaN(Date.parse(iso)) ? Math.round((nowMs - Date.parse(iso)) / 3_600_000) : null
      let observations: PlanContext['observations'] = []
      try {
        const rows = await makeObservationsStore(deps.db, chatId, { migrateFromFile: join(deps.stateDir, 'memory', chatId, 'observations.jsonl') }).listActive()
        observations = rows.slice(-PLAN_MAX_OBSERVATIONS).map(o => ({ tone: o.tone ?? null, body: o.body }))
      } catch { observations = [] }
      let personaExcerpt = ''
      try { personaExcerpt = readFileSync(join(deps.stateDir, 'memory', chatId, 'persona.md'), 'utf8') } catch { personaExcerpt = '' }
      return {
        nowLocal: formatLocal(nowIso),
        ownerLastInboundMinutesAgo: lastInboundAtIso ? Math.round((nowMs - Date.parse(lastInboundAtIso)) / 60_000) : null,
        today: { lastHuntHoursAgo: hoursAgo(ledger.lastHuntAtIso), lastVisitHoursAgo: hoursAgo(ledger.lastVisitAtIso), lastProactiveHoursAgo: hoursAgo(ledger.lastProactiveAtIso) },
        candidates, rejected, journal: planParts.journal ?? null, social: planParts.social ?? null, observations, personaExcerpt,
        earlierToday: earlier.filter(e => e.chatId === chatId).map(e => ({ at: e.at, decision: e.decision, why: e.why })),
      }
    }
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
        state.narrated[chatId] = latestInboundTs
        state.visits = { ...(state.visits ?? {}), [chatId]: ((state.visits ?? {})[chatId] ?? 0) + 1 }
        changed = true
        const uncount = (): void => {
          const n = (state.visits ?? {})[chatId] ?? 0
          if (n > 1) state.visits = { ...state.visits, [chatId]: n - 1 }
          else if (state.visits) { const { [chatId]: _drop, ...rest } = state.visits; state.visits = rest }
        }
        // 没讲出去 ⇒ 只撤这一位的水位和这一次的计数,前面几位这一拍讲完的照常保留(评审 #194)
        const unmark = (): void => {
          if (priorMark === undefined) delete state.narrated[chatId]; else state.narrated[chatId] = priorMark
          uncount()
        }
        const name = guestLabel(deps.boot.conversationStore?.getIdentity(chatId)?.last_user_name, chatId)
        let told = ''
        let noModel = false
        let outcome: Awaited<ReturnType<typeof speech.say>>
        try {
          outcome = await speech.say({ kind: 'guest_visit', chatId: ownerChat, nowMs }, async (turn) => {
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
            try { r = await turn.sendText(ownerChat, text) } catch (err) { throw new GuestNarrationSendFailed(errMsg(err)) }
            if (r.error) throw new GuestNarrationSendFailed(r.error)
            told = text
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
          deps.log('VISIT', `guest visit not told: chat=${chatId} — ${outcome.reason}; marked as seen`)
          continue
        }
        if ('defer' in outcome) { unmark(); break }   // 免打扰 / 都送不到:这一拍什么都不动,之后照讲
        if (noModel) { unmark(); continue }
        if (!told) continue
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
