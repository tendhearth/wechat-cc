/**
 * 一轮怎么跑,在开跑之前**一次**定完(架构终态第 5 条):模式、参与者、档位、权限模式、哪家 provider 被拒、
 * 守护放不放行。以前这些散在七处、各读各的 access.json;现在 `planTurn` 读一次 access,产出 `TurnPlan`,
 * 三种派法只读它。
 *
 * - `admit()` 是纯函数:给它模式、候选参与者、access 快照,算出档位、被拒的、筛过的参与者、回落到谁。
 * - `planTurn()` 是外面那层:解析候选(老数据回填会写库)、读 access、调 admit、过一次网络守护(异步,
 *   可能再拿掉几位)、最后定「几个人在跑」。没接守护时同步返回 —— 取消 / latest-wins 抢占靠同步登记,不能多让一拍。
 *
 * 一轮一个快照(以前一轮里会读三四次 access):主人在一轮中途改 access.json,从下一条消息起生效,不在半截里变档。
 */
import type { Mode, ProviderId } from '../conversation'
import type { InboundMsg } from '../prompt-format'
import type { PermissionMode } from '../capability-matrix'
import { providerCallTarget } from '../provider-registry'
import { providerDenialFor, type ProviderDenial } from '../provider-policy'
import { resolveEffectiveTier, resolveTier, TIER_PROFILES, effectivePermissionMode, type TierProfile, type UserTier } from '../user-tier'
import type { Access } from '../../lib/access'
import { decideCall, unprotectedMessage } from '../../lib/network-gate'
import type { CoordinatorCtx } from './ctx'
import type { TurnRecord } from './types'

type GroupMode = Mode & { kind: 'parallel' | 'chatroom' }

/** 这一轮的权限,一次算定。 */
export interface TurnAuth {
  /**
   * 原始档位(**不**吃 --dangerously 的提权):判哪家 provider 能用只看它 —— --dangerously⇒admin 不许给访客解锁
   * agy(所有对话共用一个 'trusted' 令牌,agy-mcp-config.ts)或 cursor(ACP:工作区内的编辑不经权限卡,
   * guestSafe(cap) === false)。
   */
  rawTier: UserTier
  /** 生效档位(--dangerously ⇒ admin,访客除外):进 acquire 的 tierProfile。 */
  tier: UserTier
  tierProfile: TierProfile
  /** 这个 chat 的权限模式(访客永远 strict)。 */
  permissionMode: PermissionMode
}

/** 一轮的计划:在这一轮真正开跑的那一刻定(见 index.ts 的 dispatchInner)。 */
export type TurnPlan =
  /** 单模型:solo / primary_tool,或者 /both、/chat 退成一家。`recordMode` 是 TurnRecord 上记的模式。 */
  | { kind: 'solo'; providerId: ProviderId; recordMode: TurnRecord['mode']; auth: TurnAuth; notes: string[] }
  | { kind: 'parallel'; participants: ProviderId[]; auth: TurnAuth }
  | { kind: 'chatroom'; participants: ProviderId[]; auth: TurnAuth }
  /** 单模型那一家按档位不许用(派发时的兜底闸,见 dispatchRefused)。 */
  | { kind: 'refused'; providerId: ProviderId; denial: ProviderDenial; auth: TurnAuth; notes: string[] }
  /** 全被网络守护挡下,话已经回过了。 */
  | { kind: 'paused'; notes: string[] }

export interface AdmitInput {
  chatId: string
  mode: Mode
  /** parallel / chatroom 的候选(还没按档位筛);solo / primary_tool 不看。 */
  candidates?: ProviderId[]
  access: Access
  permissionMode: PermissionMode
  trustedProviders: readonly ProviderId[] | undefined
  isRegistered(p: ProviderId): boolean
  /** 只用在日志里。 */
  registered: readonly ProviderId[]
  defaultProviderId: ProviderId
}

export interface Admission {
  auth: TurnAuth
  /** 过守护之前的打算:单模型(一家)还是一组。 */
  kind: 'solo' | 'parallel' | 'chatroom'
  participants: ProviderId[]
  recordMode: TurnRecord['mode']
  /** 单模型那一家被拒的原因;一组时为 null(被拒的已经从 participants 里剔掉)。 */
  denial: ProviderDenial | null
  /** 现在就记的日志(参与者被筛 / 封顶)。 */
  logs: string[]
  /** 派发时才记的日志(回落到默认 / 退成单模型)。 */
  notes: string[]
}

/** 纯函数:模式 + 候选 + access 快照 → 这一轮的档位、参与者、被拒的。不读不写任何外部状态。 */
export function admit(input: AdmitInput): Admission {
  const { chatId, mode, access, permissionMode, trustedProviders, defaultProviderId } = input
  const rawTier = resolveTier(chatId, access)
  const tier = resolveEffectiveTier(chatId, access, permissionMode)
  const auth: TurnAuth = {
    rawTier,
    tier,
    tierProfile: TIER_PROFILES[tier],
    permissionMode: effectivePermissionMode(chatId, access, permissionMode),
  }
  const one = (providerId: ProviderId, recordMode: TurnRecord['mode'], logs: string[], notes: string[]): Admission =>
    ({ auth, kind: 'solo', participants: [providerId], recordMode, denial: providerDenialFor(providerId, rawTier, trustedProviders), logs, notes })

  switch (mode.kind) {
    case 'solo':
      // Persisted mode references a provider that's no longer registered (e.g. user removed agent).
      // Fall back to default and log loudly so we notice.
      if (!input.isRegistered(mode.provider)) {
        return one(defaultProviderId, 'solo', [], [`chat=${chatId} persisted provider '${mode.provider}' not registered; falling back to ${defaultProviderId}`])
      }
      return one(mode.provider, 'solo', [], [])
    case 'primary_tool':
      // RFC 03 P4 — dispatch to the primary; the peer is reachable via the delegate-mcp tool that's
      // already loaded in the primary's session config. Behaviourally identical to solo+primary at the
      // dispatch layer.
      if (!input.isRegistered(mode.primary)) {
        return one(defaultProviderId, 'primary_tool', [], [`chat=${chatId} primary_tool primary '${mode.primary}' not registered; falling back to solo+${defaultProviderId}`])
      }
      return one(mode.primary, 'primary_tool', [], [])
    case 'parallel':
    case 'chatroom': {
      const list = input.candidates ?? []
      const logs: string[] = []
      // Belt-and-suspenders: also strip 'agy' out of an EXPLICIT participants
      // list here, not just validateMode. validateMode is the primary,
      // user-facing rejection (setMode throws before the row is ever
      // persisted), but this filter is the dispatch-time backstop for any
      // row that predates that guard (or was written directly to the store,
      // bypassing setMode — see the N-way participants tests) — the shared-
      // token hazard this is defending is worth a second, cheap check.
      // 2026-10-10 评审:solo 在派发时按档位查 provider(providerDenialFor),多家模式原先只剥 agy ⇒ 访客
      // `/both claude cursor` 能把 Cursor 以访客档拉起来(工作区内编辑不经权限卡),也绕过主人的 trusted_providers。
      // 这里同一道门、同样用原始档位(不吃 --dangerously 的提权):被拒的参与者剔掉,剩 ≤1 家时退回 solo。
      let filtered = list.filter(p => input.isRegistered(p) && p !== 'agy' && providerDenialFor(p, rawTier, trustedProviders) === null)
      if (filtered.length < list.length) {
        logs.push(`chat=${chatId} participants filtered ${list.join(',')} → ${filtered.join(',')} (registry: ${input.registered.join(',')})`)
      }
      if (filtered.length > 3) {
        filtered = filtered.slice(0, 3)
        logs.push(`chat=${chatId} participants > 3; capping at ${filtered.join(',')}`)
      }
      if (filtered.length === 0) {
        return one(defaultProviderId, mode.kind, logs, [`chat=${chatId} ${mode.kind} resolved to empty participants; falling back to solo+${defaultProviderId}`])
      }
      return { auth, kind: mode.kind, participants: filtered, recordMode: mode.kind, denial: null, logs, notes: [] }
    }
  }
}

/** 过完守护之后定形:还剩几个人在跑。 */
function settle(chatId: string, a: Admission, admitted: ProviderId[]): TurnPlan {
  // 单模型回落到默认的那句日志照记(以前在挡下之前就记了);一组全被挡下没有回落,不记。
  if (admitted.length === 0) return { kind: 'paused', notes: a.kind === 'solo' ? a.notes : [] }
  if (a.kind === 'solo') return { kind: 'solo', providerId: admitted[0]!, recordMode: a.recordMode, auth: a.auth, notes: a.notes }
  if (admitted.length === 1) {
    return {
      kind: 'solo', providerId: admitted[0]!, recordMode: a.kind, auth: a.auth,
      notes: [`chat=${chatId} ${a.kind} resolved to single participant ${admitted[0]}; degrading to solo`],
    }
  }
  return a.kind === 'parallel'
    ? { kind: 'parallel', participants: admitted, auth: a.auth }
    : { kind: 'chatroom', participants: admitted, auth: a.auth }
}

export interface Planner {
  /**
   * `quiet`:只是预估(submitTurn 排队之前,用来决定 /chat 排队还是抢占)—— 不记日志、守护挡下也不回话。
   * 预估出来的计划**不许**拿去跑:档位 / 被拒 / 守护在真正开跑时(锁里)重新定。
   */
  planTurn(msg: InboundMsg, mode: Mode, opts?: { quiet?: boolean }): TurnPlan | Promise<TurnPlan>
}

export function createPlanner(ctx: CoordinatorCtx): Planner {
  const { deps } = ctx

  /**
   * parallel / chatroom 的候选参与者(还没按档位、守护筛)。
   *
   * Priority:
   *   1. Explicit mode.participants (the user wrote `/chat claude codex cursor`).
   *   2. Legacy backfill — chat row pre-dates the participants column;
   *      use the first 2 registered providers and persist so the user's
   *      "this chat was 2-way" expectation survives a future operator
   *      install of a 3rd provider.
   *   3. Fresh-chat fallback — no row yet; use the full registry.list().
   */
  function resolveCandidates(mode: GroupMode, chatId: string): ProviderId[] {
    // agy final-review CRITICAL 1: never let a registry-derived fallback
    // auto-include agy — `deps.registry.list()` is the live provider set
    // and agy is a normal registered provider there (it just can't ride
    // parallel/chatroom, spec §7). Excluded up front so both the legacy
    // backfill (first-two) and the fresh-chat fallback (full registry)
    // never pick it, regardless of registration order.
    const registryList = deps.registry.list().filter(p => p !== 'agy')
    if (mode.participants !== undefined) return mode.participants
    if (deps.conversationStore.get(chatId)?.mode) {
      // Row exists with no participants — legacy. Backfill to first-two.
      const list = registryList.slice(0, 2)
      // Persist so this is a one-shot. setParticipants is a no-op if the
      // row doesn't have parallel/chatroom kind, but we just read it as
      // parallel/chatroom so the call is safe.
      try {
        deps.conversationStore.setParticipants(chatId, list)
        deps.log('COORDINATOR', `chat=${chatId} legacy ${mode.kind} backfilled participants=${list.join(',')}`)
      } catch (err) {
        deps.log('COORDINATOR', `chat=${chatId} setParticipants failed: ${err instanceof Error ? err.message : err}`)
      }
      return list
    }
    // No row yet — first-ever dispatch in this chat under parallel/chatroom.
    return registryList
  }

  /**
   * 守护 v2:这一轮要用的 provider 里,哪些此刻能出发。被挡下的(需要保护 + 网络不安全)
   * 合并成一句统一的话回给发起的那一面(只说一次、不重试),返回剩下能用的。
   */
  async function admitNetwork(msg: InboundMsg, providers: ProviderId[], quiet: boolean): Promise<ProviderId[]> {
    if (!deps.networkGate) return providers
    const cur = ctx.getMode(msg.chatId)
    const allowed: ProviderId[] = []
    const refused: { label: string; source: 'bx' | 'probe' | 'off'; detail: string }[] = []
    for (const p of providers) {
      const model = cur.kind === 'solo' && cur.provider === p ? cur.model : undefined
      // 评审 #193 P1-1:按这一轮**实际**会连到的目标判 —— 有在用的会话就是它起来时定下的端点 + 模型,
      // 没有就是 provider 按这次的模型报的;都报不出来 ⇒ 按需要保护。不按此刻的配置猜。
      const proj = deps.resolveProject(msg.chatId)
      const target = proj && deps.manager.effectiveTarget
        ? deps.manager.effectiveTarget({ alias: proj.alias, providerId: p, chatId: msg.chatId }, model)
        : providerCallTarget(deps.registry.get(p)?.provider, p, 'session', model !== undefined ? { model } : {})
      const d = await decideCall(deps.networkGate, target)
      if (d.allowed) allowed.push(p)
      else refused.push({ label: d.cls.label, source: d.verdict!.source, detail: d.verdict!.detail })
    }
    if (refused.length > 0 && !quiet) {
      const labels = [...new Set(refused.map(r => r.label))].join('、')
      deps.log('GUARD', `chat=${msg.chatId} protected call refused (${labels}) — network unprotected [${refused[0]!.source}] ${refused[0]!.detail}`, { event: 'network_unprotected', chat_id: msg.chatId })
      await ctx.notice(msg.chatId, unprotectedMessage(refused[0]!, labels))
    }
    return allowed
  }

  return {
    planTurn(msg, mode, opts) {
      const quiet = opts?.quiet === true
      const candidates = mode.kind === 'parallel' || mode.kind === 'chatroom' ? resolveCandidates(mode, msg.chatId) : undefined
      const a = admit({
        chatId: msg.chatId,
        mode,
        candidates,
        access: deps.loadAccess(),
        permissionMode: deps.permissionMode,
        trustedProviders: deps.trustedProviders?.(),
        isRegistered: p => deps.registry.has(p),
        registered: deps.registry.list(),
        defaultProviderId: deps.defaultProviderId,
      })
      if (!quiet) for (const line of a.logs) deps.log('COORDINATOR', line)
      // 被拒的单模型不过守护:它根本不会出发。
      if (a.denial) return { kind: 'refused', providerId: a.participants[0]!, denial: a.denial, auth: a.auth, notes: a.notes }
      // 没接守护就同步返回:不多让出一拍(取消 / latest-wins 抢占都靠同步登记)。
      if (!deps.networkGate) return settle(msg.chatId, a, a.participants)
      return admitNetwork(msg, a.participants, quiet).then(admitted => settle(msg.chatId, a, admitted))
    },
  }
}
