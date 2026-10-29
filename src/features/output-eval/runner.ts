/**
 * 输出评测在 daemon 里跑的那一下(设计稿 docs/design/2026-10-29-output-eval.md「怎么做到用的是生产那一套」)。
 *
 * 跟 selftest(daemon/selftest.ts)一样起一次性会话、收一轮、finally 里收尾;不一样的是**提示词用生产那一份**:
 * `appendInstructions = buildInstructions(执行者, 档位, chatId, 模型)`,跟 session-manager 起会话时同一个组装点。
 *
 *  - reply:提示词按样本的档位(admin / trusted,缺省 admin);发样本那句话;收齐后过 buildTurnReply(私聊)+ splitBubbles。
 *  - brief:提示词按 JOB_PROFILE(早报那一轮的档);发 buildBriefText 拼的信封;最后那段过 attachAsks,再按 tick 场合过 buildTurnReply。
 *  - reference:resolveTaskReference + makeCheapJudge(生产的便宜模型)。
 *  - judge:生产的便宜模型原样回答(CLI 拿去按 parseJudgeAnswer 读)。
 *
 * **不发微信、不写对话库、不批权限**:
 *  - 会话不经 SessionManager / 协调器 / replyDelivery,chatId 是 `eval-<uuid>`,跑完 close + 作废令牌;
 *  - 会话按 JOB_PROFILE(定时任务的只读档)起、strict:它的 relay 是空的 ⇒ 不在 allow 里的工具一律拒、不弹拍板卡
 *    (Claude 走 profileGate;Codex 是 read-only 沙箱、没有应答者 ⇒ 审批一律拒);也不给 requestPermission;
 *  - 会话令牌按 guest 铸,只放行 GET /v1/health(同 selftest):wechat MCP 里发消息、写记忆的工具够不着 daemon。
 *  提示词按样本的档位组装、会话按只读档起 —— 这就是「只读档、不批权限」;要动手的样本不在这一版范围里。
 * 网络守护不用这里管:registry 里每个 provider 的 spawn / cheapEval 都套了 withNetworkGate。
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectTurn, type TurnSummary } from '../../ports/agent-provider'
import type { ProviderRegistry } from '../../app/provider-registry'
import type { ProviderId } from '../../domain/conversation'
import { JOB_PROFILE, TIER_PROFILES, sessionAuthEnv, tierNameFromProfile, type TierProfile, type UserTier } from '../../domain/user-tier'
import { buildTurnReply, type ReplyContext } from '../../domain/turn-reply'
import { replyTextStrategyFor } from '../../domain/capability-matrix'
import type { PickedAsk } from '../../domain/owner-asks'
import { splitBubbles } from '../../daemon/reply-bubbles'
import { routesForToken } from '../../daemon/internal-api/route-tiers'
import { attachAsks, buildBriefMaterial, buildBriefText, type BriefInputs } from '../jobs'
import { makeCheapJudge, resolveTaskReference, type FocusState, type TaskCandidate } from '../workbench'

/** 跟 daemon 的轮次看门狗同一个缺省(一段时间没事件就算卡住)。 */
const DEFAULT_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 3_000
/** 会话令牌的兜底寿命(finally 里的作废才是主路)。 */
const TOKEN_TTL_MS = 10 * 60_000
/** 草稿项目:不在 STATE_DIR 底下(那里是令牌和账号文件)。会话只读,也不该在主人的项目里跑。 */
export const EVAL_PROJECT_PATH = join(tmpdir(), 'wechat-cc-eval', 'project')

export interface EvalRunnerDeps {
  registry: Pick<ProviderRegistry, 'get' | 'getCheapEval' | 'getCheapEvalBudgetMs'>
  /** 样本没点名执行者时用谁(daemon 的缺省执行者)。 */
  defaultProviderId: () => ProviderId
  /** 生产的系统提示词组装点(bootstrap 的 buildInstructions)。 */
  buildInstructions: (providerId: ProviderId, tierProfile: TierProfile, chatId: string, model?: string) => string
  /** 生产的「这家现在用哪个模型」(session-manager 同一个);缺省 ⇒ 执行者自己的缺省。 */
  currentModelFor?: (providerId: ProviderId) => string | undefined
  mintSessionToken: (tier: UserTier, key: string, opts?: { routeAllow?: ReadonlySet<string>; ttlMs?: number }) => string
  invalidateSession: (key: string) => void
  log: (tag: string, line: string) => void
  /**
   * 跑完收掉这个一次性 chatId 在 STATE_DIR 里留下的痕迹:组装提示词时读记忆会建一个空的 `memory/<chatId>/`
   * (生产里每个新对话都这样),评测每跑一条就多一个,夜里整理记忆还会去扫它们。
   */
  forgetChat?: (chatId: string) => void
  projectDir?: string
  now?: () => number
  uuid?: () => string
}

/** 请求本身不成立(HTTP 层回非 200,码在 workbench-errors 表里)。 */
export interface EvalRefused { ok: false; code: 'eval_unknown_provider' | 'eval_no_cheap_model' }

export interface EvalTurnResult {
  ok: boolean
  kind: 'reply' | 'brief'
  providerId: string
  model?: string
  /** 真会进微信的文字(静默 ⇒ '')。 */
  finalText: string
  /** 按生产规则分好的气泡(没开「一条发完」;静默 ⇒ [])。 */
  bubbles: string[]
  silent: boolean
  /** 模型写下的最后那段原文(NO_REPLY、候选占位都还在)。 */
  rawFinalText: string
  narration: string[]
  /** 这一轮所有文字事件的原文(按顺序)。 */
  segments: string[]
  toolCalls: string[]
  /** brief:拍板候选接上了没有。 */
  attached?: boolean
  error?: string
  errorCode?: string
  durationMs: number
}

export interface EvalReferenceResult {
  ok: true
  kind: 'reference'
  resolution: { kind: string; taskId?: string; via?: string; options?: string[] }
  durationMs: number
}

export type EvalJudgeResult = { ok: true; kind: 'judge'; answer: string; durationMs: number } | { ok: false; kind: 'judge'; error: string; durationMs: number }

export interface ReplyInput { text: string; tier?: 'admin' | 'trusted'; providerId?: string; model?: string; timeoutMs?: number }
export interface BriefInput { material: BriefInputs; asks?: PickedAsk[]; asksBase?: number; nowIso?: string; providerId?: string; model?: string; timeoutMs?: number }
export interface ReferenceInput { text: string; quotedText?: string | null; candidates: TaskCandidate[]; focus?: FocusState | null; nowMs?: number }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function makeEvalRunner(deps: EvalRunnerDeps) {
  const now = deps.now ?? Date.now
  const uuid = deps.uuid ?? randomUUID

  /** 起一次性会话、发一句、收齐一轮;任何路径都 close + 作废令牌。 */
  async function oneTurn(a: {
    kind: 'reply' | 'brief'; providerId: string; model?: string; promptProfile: TierProfile
    text: string; timeoutMs?: number; context: ReplyContext; transformFinal?: (raw: string) => string
  }): Promise<EvalTurnResult | EvalRefused> {
    const entry = deps.registry.get(a.providerId)
    if (!entry) return { ok: false, code: 'eval_unknown_provider' }
    const startedAt = now()
    const projectPath = deps.projectDir ?? EVAL_PROJECT_PATH
    mkdirSync(projectPath, { recursive: true })
    // `eval-<uuid>`:不带 `/`(记忆那一层把 chatId 当目录名,带 `/` 直接拒 —— 沙盒抓到的)
    const chatId = `eval-${uuid()}`
    // provider/alias/chatId 三段(internal-api 从会话键取 callerChatId 的形状,同 session-manager / selftest)
    const sessionKey = `${a.providerId}/eval/${chatId}`
    const tier = tierNameFromProfile(JOB_PROFILE)
    const token = deps.mintSessionToken(tier, sessionKey, { routeAllow: routesForToken('selftest'), ttlMs: TOKEN_TTL_MS })
    const base = { kind: a.kind, providerId: a.providerId, ...(a.model !== undefined ? { model: a.model } : {}) }
    const empty = { finalText: '', bubbles: [] as string[], silent: false, rawFinalText: '', narration: [] as string[], segments: [] as string[], toolCalls: [] as string[] }
    let session: Awaited<ReturnType<typeof entry.provider.spawn>> | undefined
    try {
      const appendInstructions = deps.buildInstructions(a.providerId, a.promptProfile, chatId, a.model)
      session = await entry.provider.spawn(
        { alias: 'eval', path: projectPath },
        {
          tierProfile: JOB_PROFILE,
          permissionMode: 'strict',
          chatId,
          mcpEnv: sessionAuthEnv(tier, token),
          appendInstructions,
          ...(a.model !== undefined ? { model: a.model } : {}),
        },
      )
      const summary: TurnSummary = await collectTurn(session.dispatch(a.text), { timeoutMs: a.timeoutMs ?? DEFAULT_TIMEOUT_MS })
      const raw = summary.finalText ?? ''
      let finalRaw = raw
      if (a.transformFinal) { try { finalRaw = a.transformFinal(raw) } catch (e) { deps.log('EVAL', `transformFinal threw: ${errMsg(e)}`) } }
      // 回复交付的那一半(reply-delivery.ts):静默 ⇒ 不发;否则聊天型的多段各自分条,其余整段分条。
      const { reply } = buildTurnReply({ finalText: finalRaw, narration: summary.narration ?? [] }, [], a.context, replyTextStrategyFor(a.providerId))
      const text = reply.silent ? '' : reply.text.trim()
      const sources = reply.segments && reply.segments.length > 0 && !reply.silent ? reply.segments : [text]
      const bubbles = text === '' ? [] : sources.flatMap(s => splitBubbles(s))
      return {
        ok: !summary.error, ...base,
        finalText: text, bubbles, silent: reply.silent, rawFinalText: raw,
        narration: summary.narration ?? [], segments: summary.assistantText, toolCalls: summary.toolCalls,
        ...(a.transformFinal ? { attached: finalRaw !== raw } : {}),
        ...(summary.error !== undefined ? { error: summary.error } : {}),
        ...(summary.errorCode !== undefined ? { errorCode: summary.errorCode } : {}),
        durationMs: now() - startedAt,
      }
    } catch (err) {
      deps.log('EVAL', `${a.kind} on ${a.providerId} failed: ${errMsg(err)}`)
      const code = typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
      return { ok: false, ...base, ...empty, error: errMsg(err), ...(code ? { errorCode: code } : {}), durationMs: now() - startedAt }
    } finally {
      if (session) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([session.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('close timed out')), CLOSE_TIMEOUT_MS) })])
        } catch (err) {
          deps.log('EVAL', `session.close failed for ${sessionKey}: ${errMsg(err)}`)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      deps.invalidateSession(sessionKey)
      try { deps.forgetChat?.(chatId) } catch (err) { deps.log('EVAL', `forgetChat failed for ${chatId}: ${errMsg(err)}`) }
    }
  }

  const pick = (providerId?: string, model?: string) => {
    const p = providerId ?? deps.defaultProviderId()
    const m = model ?? deps.currentModelFor?.(p)
    return { providerId: p, ...(m !== undefined ? { model: m } : {}) }
  }

  return {
    reply(i: ReplyInput) {
      return oneTurn({
        kind: 'reply', ...pick(i.providerId, i.model), promptProfile: TIER_PROFILES[i.tier ?? 'admin'],
        text: i.text, context: 'dm', ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
      })
    },

    brief(i: BriefInput) {
      const nowIso = i.nowIso ?? new Date(now()).toISOString()
      const material = buildBriefMaterial(i.material)
      const picked = i.asks ?? []
      const asks = picked.length ? { count: picked.length, base: i.asksBase ?? 0 } : undefined
      return oneTurn({
        kind: 'brief', ...pick(i.providerId, i.model), promptProfile: JOB_PROFILE,
        text: buildBriefText({ jobId: 'eval-brief', nowIso, material, ...(asks ? { asks } : {}) }),
        context: 'tick', transformFinal: (raw) => attachAsks(raw, picked).text,
        ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
      })
    },

    async reference(i: ReferenceInput): Promise<EvalReferenceResult> {
      const startedAt = now()
      const cheap = deps.registry.getCheapEval()
      const r = await resolveTaskReference({
        text: i.text, candidates: i.candidates, nowMs: i.nowMs ?? now(),
        ...(i.quotedText !== undefined ? { quotedText: i.quotedText } : {}),
        ...(i.focus !== undefined ? { focus: i.focus } : {}),
        ...(cheap ? { judge: makeCheapJudge(cheap), judgeTimeoutMs: deps.registry.getCheapEvalBudgetMs() } : {}),
      })
      const resolution = r.kind === 'ambiguous' ? { kind: r.kind, options: r.options.map(o => o.id) } : r
      return { ok: true, kind: 'reference', resolution, durationMs: now() - startedAt }
    },

    async judge(prompt: string): Promise<EvalJudgeResult | EvalRefused> {
      const cheap = deps.registry.getCheapEval()
      if (!cheap) return { ok: false, code: 'eval_no_cheap_model' }
      const startedAt = now()
      try {
        return { ok: true, kind: 'judge', answer: await cheap(prompt), durationMs: now() - startedAt }
      } catch (err) {
        return { ok: false, kind: 'judge', error: errMsg(err), durationMs: now() - startedAt }
      }
    },
  }
}

export type EvalRunner = ReturnType<typeof makeEvalRunner>
