/**
 * authorize() 逐格对照(架构终态 C2):每一处逐工具判定换成 domain/authorize.ts 之前,把原来的实现**原样**抄在这里当
 * 对照(legacy*,只改了函数名;判定规则那一处 decideTool 用 C1 之前的四行原文 legacyDecideTool),
 * 新旧两份在同一组格子上跑,结果、问主人的那一下(谁、什么话、哪个码、多久)、日志、通道调用都要一位不差。
 *
 * 留下的格子:面(对话 Gemini、一起做的放行规则、终端会话)× 档位 × 权限模式 × 对话模式 × 能力表 askUser ×
 * 工具(每个 wechat MCP 名、坏名字)× 有没有 admin × 主人怎么答 × 取消 × 放行规则的每一种裁决。
 *
 * 删掉的面(docs/maintainer/mutation-baseline-2026-10.md「第三轮」「第四轮」):
 *   - OpenAI 兼容闸门(2026-10-28 第三轮):openai-gate.ts 删前删后都是 100,权限几份上一个独有的都没杀;
 *   - 对话 Claude、定时任务只读档、一起做 Claude(2026-10-28 第四轮):先在 permission-relay.table.test.ts、
 *     wire-model-options.job-gate.test.ts、workbench-can-use-tool.table.test.ts 把它们独有杀的那几十个变异直接写成表,
 *     删后三份源文件的变异分数都不低于删前,才删。
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { compilePolicy } from './policy'
import { classifyToolUse, JOB_PROFILE, REVIEW_PROFILE, TIER_PROFILES, type TierProfile, type ToolKind, type UserTier } from './user-tier'
import type { PermissionMode } from './permission-mode'
import type { Mode } from './conversation'
import { authorize, OWNER_RULE_SURFACES } from './authorize'
import type { SpawnContext } from '../ports/agent-provider'
import { makeGeminiToolGate, type GeminiGateDeps, type ToolGate } from '../adapters/executors/gemini/gemini-agent-provider'
import { WORKBENCH_PERMISSION_DESCRIPTION_MAX, WORKBENCH_PERMISSION_TIMEOUT_MS, WORKBENCH_PERMISSION_TOOL_MAX, makeRunPermissions, type PermissionDecide, type PermissionFacts, type PermissionOutcome, type WorkbenchPermissionAudit } from '../adapters/workbench/permissions'
import type { PendingWorkbenchPermission, PermissionDecision } from '../ports/workbench'
import { makeTerminalDecide } from '../daemon/permission-gate'
import type { ChatOwnerRules } from '../adapters/permission-rules/chat'
import type { Decision, Verdict } from './permission-rules/types'

// ───────────────────────── 改之前的实现(原样) ─────────────────────────

/** C1 之前三家各抄一份的那四行(tool-decision.test.ts 已证明 decideTool 与它一格不差)。 */
function legacyDecideTool(tp: TierProfile, kind: ToolKind, askUser: 'per-tool' | 'never' = 'never'): 'allow' | 'relay' | 'deny' {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'
  return askUser === 'per-tool' ? 'relay' : 'allow'
}
// gemini-agent-provider.ts makeGeminiToolGate
const LEGACY_GEMINI_TIMEOUT_MS = 120_000

/** Inlined (NOT imported from permission-relay.ts, which would recreate the
 *  gemini→permission-relay→capability-matrix→gemini import cycle) djb2-ish hash →
 *  5-char base36. The relay hash MUST be exactly 5 alphanumeric chars so the admin's
 *  WeChat reply matches pending-permissions.ts's PERMISSION_REPLY_RE
 *  (/^([yn])\s+([A-Za-z0-9]{5})$/i) — anything else can NEVER be approved. A base36
 *  uint32 is 1–7 chars, so padStart guarantees the low end and slice(-5) the high end:
 *  the result is ALWAYS exactly 5 alphanumeric chars. */
function legacyGeminiHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

/** Build the per-spawn tool gate. Replicates makeCanUseTool's allow/relay/deny
 *  but returns ToolGateDecision and normalizes the wechat MCP server's BARE tool
 *  names (`reply`) into the `mcp__wechat__reply` form classifyToolUse expects. */
function legacyGeminiGate(deps: GeminiGateDeps): (ctx: SpawnContext) => ToolGate {
  return (ctx: SpawnContext): ToolGate => {
    // Per-spawn relay counter — each session owns its own, so hashes don't couple
    // across chats. Combined with chatId in the hash input → unique per relay.
    let relaySeq = 0
    return async (toolName, input) => {
      if (!compilePolicy('gemini', ctx.tierProfile, ctx.permissionMode).gateEnabled) return { allow: true }
      // Reject any bare name already containing '__': prefixing `mcp__wechat__`
      // onto it (e.g. `mcp__wechat__shell` → `mcp__wechat__mcp__wechat__shell`)
      // yields a malformed name classifyToolUse may misclassify as unknown→allow,
      // letting a gated tool slip through. Deny outright.
      if (toolName.includes('__')) return { allow: false, message: `invalid tool name '${toolName}'` }
      const kind = classifyToolUse(`mcp__wechat__${toolName}`, input)
      const base = deps.lookupBase(deps.modeFor(ctx.chatId), ctx.permissionMode)
      const decision = legacyDecideTool(ctx.tierProfile, kind, base.askUser)
      if (decision === 'allow') return { allow: true }
      if (decision === 'deny') return { allow: false, message: `tool '${toolName}' (${kind}) not allowed for this tier` }
      const admin = deps.adminFor(ctx.chatId)
      if (!admin) return { allow: false, message: 'no admin configured to approve permission requests' }
      const seq = ++relaySeq
      const hash = legacyGeminiHash(`${ctx.chatId}:${toolName}:${seq}`)
      const answer = await deps.askUser(admin, `Gemini wants to run ${toolName}`, hash, LEGACY_GEMINI_TIMEOUT_MS)
      if (answer === 'allow') return { allow: true }
      const message = answer === 'undelivered'
        ? 'could not reach the owner for approval (their message window is likely closed) — tell the user to try again shortly or have the owner message first'
        : answer === 'timeout' ? 'no reply in time; denied' : 'denied by operator'
      return { allow: false, message }
    }
  }
}


// core/workbench/permissions.ts makeRunPermissions
interface Entry {
  permission: PendingWorkbenchPermission
  expiresAt: number
  finish: (allowed: boolean, outcome: PermissionOutcome) => void
  /** 冻住期间撤掉的到期计时器,放开时按剩下的时间重起(网络守护暂停,2026-10-03)。 */
  rearm: (ms: number) => void
  disarm: () => void
}

function legacyRunPermissions(opts: {
  taskId: string
  timeoutMs?: number
  audit?: (event: WorkbenchPermissionAudit) => void
  /** 放行规则:登记之前先问。allow / deny ⇒ 不登记、不发 request 审计(主人收不到通知),只记 outcome 带 by。 */
  decide?: PermissionDecide
}) {
  const entries = new Map<string, Entry>()
  let closed = false
  /** 暂停时刻(网络守护把执行者冻住时):期间不算进五分钟的批准期限。null = 没暂停。 */
  let pausedAt: number | null = null
  const audit = (event: WorkbenchPermissionAudit): boolean => {
    try { opts.audit?.(event); return true } catch { return false }
  }

  function request(
    raw: { tool: string; description: string; command?: string; paths?: string[]; cwd?: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (closed || typeof raw?.tool !== 'string' || typeof raw?.description !== 'string') return Promise.resolve(false)
    const tool = raw.tool.trim()
    const description = raw.description.trim()
    if (!tool || !description || tool.length > WORKBENCH_PERMISSION_TOOL_MAX ||
        description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX || signal?.aborted) return Promise.resolve(false)
    if (!opts.decide) return register(tool, description, signal)
    const facts: PermissionFacts = { tool, description }
    if (typeof raw.command === 'string' && raw.command.trim()) facts.command = raw.command
    if (Array.isArray(raw.paths) && raw.paths.length && raw.paths.every(p => typeof p === 'string' && p)) facts.paths = [...raw.paths]
    if (typeof raw.cwd === 'string' && raw.cwd) facts.cwd = raw.cwd
    return opts.decide(facts).catch(() => ({ verdict: 'ask' as const, by: 'default' })).then(d => {
      if (closed || signal?.aborted) return false
      if ((d.verdict === 'allow' || d.verdict === 'deny') && (d.by === 'rule' || d.by === 'review' || d.by === 'floor')) {
        const permission: PendingWorkbenchPermission = { id: randomUUID(), taskId: opts.taskId, tool, description, createdAt: Date.now() }
        const audited = audit({ type: 'outcome', permission, outcome: d.verdict, by: d.by })
        return audited && d.verdict === 'allow'
      }
      return register(tool, description, signal)
    })
  }

  function register(tool: string, description: string, signal?: AbortSignal): Promise<boolean> {
    const permission: PendingWorkbenchPermission = {
      id: randomUUID(),
      taskId: opts.taskId,
      tool,
      description,
      createdAt: Date.now(),
    }
    return new Promise<boolean>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.finish(false, 'aborted')
      const finish = (allowed: boolean, outcome: PermissionOutcome) => {
        if (settled) return
        settled = true
        entries.delete(permission.id)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const audited = audit({ type: 'outcome', permission, outcome })
        resolve(audited ? allowed : false)
      }
      const timeoutMs = opts.timeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS
      const rearm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(false, 'expired'), Math.max(0, ms)); timer.unref?.() }
      const disarm = () => { if (timer) clearTimeout(timer); timer = undefined }
      const entry: Entry = { permission, expiresAt:permission.createdAt + Math.max(0,timeoutMs), finish, rearm, disarm }
      entries.set(permission.id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (pausedAt === null) rearm(timeoutMs)
      if (!audit({ type: 'request', permission })) finish(false,'ended')
    })
  }

  return {
    request,
    pending: (): PendingWorkbenchPermission[] => Array.from(entries.values(), entry => ({ ...entry.permission })),
    /** 网络守护冻住执行者:批准期限停表(到期计时器撤掉;放开时期限按冻住的时长顺延)。 */
    pause(): void {
      if (pausedAt !== null) return
      pausedAt = Date.now()
      for (const entry of entries.values()) entry.disarm()
    },
    /** 放开:冻住的那段不算,期限顺延,计时器按剩下的时间重起。 */
    resume(): void {
      if (pausedAt === null) return
      const held = Date.now() - pausedAt
      pausedAt = null
      for (const entry of entries.values()) { entry.expiresAt += held; entry.rearm(entry.expiresAt - Date.now()) }
    },
    resolve(id: string, decision: PermissionDecision): boolean {
      const entry = entries.get(id)
      if (!entry) return false
      if (pausedAt === null && Date.now() >= entry.expiresAt) {
        entry.finish(false,'expired')
        return false
      }
      entry.finish(decision === 'allow', decision)
      return true
    },
    rejectAll(outcome: Extract<PermissionOutcome, 'cancelled' | 'ended'> = 'ended'): void {
      closed = true
      for (const entry of [...entries.values()]) entry.finish(false, outcome)
    },
  }
}


// ───────────────────────── 格子 ─────────────────────────

const TIER_NAMES: UserTier[] = ['admin', 'trusted', 'guest']
const ALL_PROFILES: [string, TierProfile][] = [...TIER_NAMES.map(t => [t, TIER_PROFILES[t]] as [string, TierProfile]), ['job', JOB_PROFILE], ['review', REVIEW_PROFILE]]
const PERMISSION_MODES: PermissionMode[] = ['strict', 'dangerously']
const CHAT_MODES: Mode['kind'][] = ['solo', 'primary_tool', 'parallel', 'chatroom']
const ANSWERS = ['allow', 'deny', 'timeout', 'undelivered'] as const

/** wechat MCP 的每一个名字(classifyToolUse 认得的全部,加 reply 族与一个不认得的)。 */
const WECHAT_SUBS = [
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate', 'sticker_feedback',
  'share_page', 'memory_list', 'memory_read', 'memory_write', 'memory_edit', 'memory_delete',
  'observations_list', 'observations_read', 'observations_write', 'observations_archive',
  'a2a_send', 'social_seek', 'wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit',
  'knowledge_search', 'federated_query', 'contact_profile', 'top_contacts', 'relationship_subgraph', 'connectors', 'graph_status',
  'extraction_batch', 'record_facts', 'contact_facts', 'find_facts', 'set_fact_status', 'extraction_status', 'person_brief',
  'config_get', 'config_set', 'provider_switch', 'message', 'diagnostic_turns', 'diagnostic_health', 'daemon_restart', 'session_release', 'model_get', 'model_set',
  'locate_file', 'attach_file', 'calendar_agenda', 'cc_letter', 'list_stickers', 'save_sticker', 'set_chat_pref', 'terminal_say', 'terminal_say_result',
  'terminal_sessions', 'today_digest', 'view_image', 'voice', 'not_a_real_tool',
]

let cells = 0

/**
 * 2026-10-25 起对话也走放行规则,但只在主人自己的对话里。逐格对照照样跑,并且**接上**规则:
 *   - 访客 / 信任(以及定时 / 审查档):接一份「什么都放」的规则,isOwnerChat 说不是主人 —— 结果必须和改之前一位不差,
 *     规则一次都不许被问(decide 计数为 0);
 *   - 主人:接一份「什么都没命中」(ask · default)的规则 —— 规则没拿主意,结果也必须和改之前一位不差。
 * 主人对话里规则真拿主意(放 / 拒)的那几格,见文末「放行规则生效的面」和 core/permission-rules/chat.test.ts。
 */
const ALLOW_ALL: Decision = { verdict: 'allow', by: 'rule', ruleId: 'everything', reason: 'x' }
const NO_RULE: Decision = { verdict: 'ask', by: 'default', reason: '没有规则覆盖' }
function wiredRules(owner: boolean, counter: { decide: number }): ChatOwnerRules {
  return {
    isOwnerChat: () => owner,
    decide: async () => { counter.decide++; return owner ? NO_RULE : ALLOW_ALL },
    noteAllowed: () => () => {},
  }
}

describe('authorize 逐格对照:对话 · Gemini 闸门', () => {
  const BARE = [...WECHAT_SUBS, 'Bash', 'Read', 'mcp__wechat__shell', 'a__b', '__', 'shell']
  it('档位(含定时 / 审查档)× 权限模式 × 对话模式 × 能力表 askUser × 有没有 admin × 主人怎么答 × 裸名', async () => {
    for (const [tn, tierProfile] of ALL_PROFILES) for (const permissionMode of PERMISSION_MODES) for (const mode of CHAT_MODES)
      for (const askUser of ['per-tool', 'never'] as const) for (const admin of ['owner', null] as const) for (const answer of ANSWERS) {
        const counter = { decide: 0 }
        const ownerRules = wiredRules(tn === 'admin', counter)
        const run = async (build: (d: GeminiGateDeps) => (ctx: SpawnContext) => ToolGate) => {
          const trace: unknown[] = []
          const gate = build({
            ownerRules: () => ownerRules,
            askUser: async (...a) => { trace.push(['ask', ...a]); return answer },
            adminFor: (c) => { trace.push(['admin?', c]); return admin },
            modeFor: (c) => { trace.push(['mode?', c]); return mode },
            lookupBase: (m, p) => { trace.push(['base?', m, p]); return { askUser } as never },
          })({ chatId: 'chat', tierProfile, permissionMode } as SpawnContext)
          const out: unknown[] = []
          for (const name of BARE) out.push(await gate(name, { text: 'hi', command: 'rm -rf /' }))
          return { out, trace }
        }
        expect(await run(makeGeminiToolGate), `${tn}/${permissionMode}/${mode}/${askUser}/${admin}/${answer}`).toEqual(await run(legacyGeminiGate))
        if (tn !== 'admin') expect(counter.decide, `${tn} 对话不许问规则`).toBe(0)
        cells += BARE.length
      }
  })
})

/** 放行规则能给出的每一种裁决(verdict × by),外加认不出的 by 与抛错。 */
const RULINGS: (Decision | { verdict: Verdict; by: string } | 'throws')[] = [
  ...(['allow', 'ask', 'deny'] as const).flatMap(verdict => (['rule', 'review', 'floor', 'default', 'other'] as const).map(by => ({ verdict, by }))),
  'throws',
]

describe('authorize 逐格对照:一起做 · 放行规则(makeRunPermissions)', () => {
  const settle = async (factory: typeof makeRunPermissions, decide: PermissionDecide | undefined, answer: 'allow' | 'deny' | 'none', aborted: boolean) => {
    const audits: unknown[] = []
    const perms = factory({ taskId: 't', timeoutMs: 60_000, audit: e => audits.push({ type: e.type, tool: e.permission.tool, description: e.permission.description, ...(e.type === 'outcome' ? { outcome: e.outcome, by: e.by } : {}) }), ...(decide ? { decide } : {}) })
    const c = new AbortController(); if (aborted) c.abort()
    const p = perms.request({ tool: 'Bash', description: 'run', command: 'git status', paths: ['/p/a'], cwd: '/p' }, c.signal)
    const syncPending = perms.pending().length
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const pending = perms.pending()
    if (answer !== 'none') for (const e of pending) perms.resolve(e.id, answer)
    else perms.rejectAll('ended')
    return { result: await p, syncPending, pending: pending.length, audits }
  }
  it('每一种裁决 × 主人怎么答 × 取消与否,外加没接放行规则', async () => {
    for (const ruling of [...RULINGS, 'unwired' as const]) for (const answer of ['allow', 'deny', 'none'] as const) for (const aborted of [false, true]) {
      const decide: PermissionDecide | undefined = ruling === 'unwired' ? undefined : async () => { if (ruling === 'throws') throw Error('x'); return ruling }
      expect(await settle(makeRunPermissions, decide, answer, aborted), `${JSON.stringify(ruling)}/${answer}/${aborted}`).toEqual(await settle(legacyRunPermissions as typeof makeRunPermissions, decide, answer, aborted))
      cells++
    }
  })
})

describe('authorize 逐格对照:终端会话(cli-permission-relay 的 decide)', () => {
  const req = { session_id: 's', tool_name: 'Bash', cwd: '/p', source: 'claude', command: 'git status' } as never
  // permission-gate.decide 实际能给出的裁决:关着 / 出错 ⇒ ask·default;decideCore ⇒ deny·rule、ask·floor、ask·rule、
  // ask·default、allow·rule、allow·review(decide.ts)。原来取 .verdict,一起做原来只认 by ∈ rule/review/floor —— 这几种上两者相同。
  const REACHABLE: Decision[] = [
    { verdict: 'ask', by: 'default', reason: '' }, { verdict: 'deny', by: 'rule', reason: '' }, { verdict: 'ask', by: 'floor', reason: '' },
    { verdict: 'ask', by: 'rule', reason: '' }, { verdict: 'allow', by: 'rule', reason: '' }, { verdict: 'allow', by: 'review', reason: '' },
  ]
  it('permission-gate 能给出的每一种裁决:与原来的 (await gate.decide(...)).verdict 相同', async () => {
    for (const d of REACHABLE) {
      const seen: unknown[] = []
      const gate = { decide: async (src: unknown) => { seen.push(typeof src); return d } }
      const decide = makeTerminalDecide(gate, async () => ({ surface: 'terminal' }) as never)
      expect(await decide(req), JSON.stringify(d)).toBe(d.verdict)
      expect(seen).toEqual(['function'])   // 规则关着时不造请求:照旧交一个函数进去
      cells++
    }
  })
  it('gate 抛错 ⇒ 照旧往外抛(中继那边 catch 成 ask)', async () => {
    const decide = makeTerminalDecide({ decide: async () => { throw Error('boom') } })
    await expect(decide(req)).rejects.toThrow('boom')
  })
})

describe('放行规则生效的面(2026-10-25 起:终端会话、一起做、主人自己的对话)', () => {
  const admin = { tier: TIER_PROFILES.admin, permissionMode: 'strict' as const, executor: 'claude' as const }
  const destructive = { name: 'Bash', kind: 'shell_destructive' as const }
  it('OWNER_RULE_SURFACES 是三个面;定时任务永远不看', () => {
    expect([...OWNER_RULE_SURFACES].sort()).toEqual(['chat', 'terminal', 'workbench'])
    const job = authorize({ ...admin, surface: 'job', tier: JOB_PROFILE }, destructive, { ownerRuling: { verdict: 'allow', by: 'rule' } })
    expect(job.consultOwnerRules).toBe(false)
    expect(job.reason).not.toBe('owner_rules')
  })
  it('对话:不是主人自己的对话(ownerChat 没给 / 为假)⇒ 落到「问」也不看规则,裁决递进来也不认', () => {
    for (const ownerChat of [undefined, false]) {
      const s = { ...admin, surface: 'chat' as const, ...(ownerChat === undefined ? {} : { ownerChat }) }
      expect(authorize(s, destructive)).toMatchObject({ verdict: 'ask', consultOwnerRules: false })
      expect(authorize(s, destructive, { ownerRuling: { verdict: 'allow', by: 'rule' } })).toMatchObject({ verdict: 'ask', reason: 'tier', consultOwnerRules: false })
    }
  })
  it('对话 · 主人自己的:落到「问」⇒ 先问规则;规则放 / 拒照办,只认 by rule(初审、红线、没命中 ⇒ 还是问)', () => {
    const s = { ...admin, surface: 'chat' as const, ownerChat: true }
    expect(authorize(s, destructive)).toMatchObject({ verdict: 'ask', reason: 'tier', consultOwnerRules: true })
    expect(authorize(s, destructive, { ownerRuling: { verdict: 'allow', by: 'rule' } })).toMatchObject({ verdict: 'allow', reason: 'owner_rules', by: 'rule' })
    expect(authorize(s, destructive, { ownerRuling: { verdict: 'deny', by: 'rule' } })).toMatchObject({ verdict: 'deny', reason: 'owner_rules', by: 'rule' })
    for (const r of [{ verdict: 'allow', by: 'review' }, { verdict: 'ask', by: 'floor' }, { verdict: 'ask', by: 'rule' }, { verdict: 'ask', by: 'default' }, { verdict: 'allow', by: 'default' }] as const) {
      expect(authorize(s, destructive, { ownerRuling: r }), JSON.stringify(r)).toMatchObject({ verdict: 'ask', reason: 'tier', consultOwnerRules: false })
    }
    // 档位直接放 / 拒的格子根本不问规则(主人对话里普通 shell 本来就放)
    expect(authorize(s, { name: 'Bash', kind: 'shell' })).toMatchObject({ verdict: 'allow', consultOwnerRules: false })
  })
  it('对话 · openai(问不了):规则在「问落成拒」之前看,规则没拿主意照旧拒', () => {
    const s = { ...admin, executor: 'openai' as const, surface: 'chat' as const, ownerChat: true }
    expect(authorize(s, destructive)).toMatchObject({ verdict: 'deny', reason: 'relay_unavailable', consultOwnerRules: true })
    expect(authorize(s, destructive, { ownerRuling: { verdict: 'allow', by: 'rule' } })).toMatchObject({ verdict: 'allow', reason: 'owner_rules' })
    expect(authorize(s, destructive, { ownerRuling: { verdict: 'ask', by: 'floor' } })).toMatchObject({ verdict: 'deny', reason: 'relay_unavailable' })
    expect(authorize({ ...s, ownerChat: false }, destructive)).toMatchObject({ verdict: 'deny', reason: 'relay_unavailable', consultOwnerRules: false })
  })
  it('格子总数(防有人把循环删空了)', () => {
    expect(cells).toBeGreaterThan(45_000)
  })
})
