import { randomUUID } from 'node:crypto'
import { authorize, type AuthSubject } from '../../domain/authorize'
import { TIER_PROFILES } from '../../domain/user-tier'
import type { PendingWorkbenchPermission, PermissionDecision } from '../../ports/workbench'
import { inspectPermissionCommand, type CommandSnapshot } from './permission-command'
import { matchRule } from '../permission-rules/rules-file'
import type { Rule } from '../../domain/permission-rules/types'
import { EDIT_REPORTING_PROVIDERS } from '../permission-rules/decide'
import { redactSecrets } from '../../domain/cli-transcript'
import type { PermissionExecutionEnvironment } from './permission-executable'

/**
 * 执行者报上来要批准的调用(Claude 的 canUseTool 落到「问」、Codex app-server 的审批、ACP 的权限卡、OpenAI 兼容任务的
 * requestPermission):判定在 domain/authorize.ts(架构终态 C2)—— 起点是问;面是 workbench ⇒ 先过主人的放行规则,
 * 规则拿了主意(放 / 拒)就照办,否则登记、问主人。一起做只给主人用,档位那一层在执行者那头已经过了(Claude)或
 * 本来就没有(Codex / ACP 自己只报要批准的),这里的档位只是占位,不参与判定。
 */
const REPORTED_SUBJECT: AuthSubject = { surface: 'workbench', tier: TIER_PROFILES.admin, permissionMode: 'strict', executor: 'claude' }
const REPORTED = { name: 'reported', kind: 'subagent', reported: true } as const

export const WORKBENCH_PERMISSION_TIMEOUT_MS = 5 * 60_000
export const WORKBENCH_PERMISSION_TOOL_MAX = 160
export const WORKBENCH_PERMISSION_DESCRIPTION_MAX = 20_000

export type PermissionOutcome = PermissionDecision | 'aborted' | 'expired' | 'cancelled' | 'ended'

export type WorkbenchPermissionAudit =
  | { type: 'request'; permission: PendingWorkbenchPermission }
  | { type: 'outcome'; permission: PendingWorkbenchPermission; outcome: PermissionOutcome; /** 放行规则替主人拿的主意(没有 = 主人 / 到期 / 取消)。 */ by?: RuleDecider }

/** 放行规则(2026-10-19)谁拿的主意:规则表 / 初审 / 红线。 */
export type RuleDecider = 'rule' | 'review' | 'floor'
/** 执行者能给的原文(拿不到就不给,规则不猜)。 */
export interface PermissionFacts { tool: string; description?: string; command?: string; paths?: string[]; cwd?: string; requiresBoundExecution?: true }
export type PermissionDecide = (facts: PermissionFacts) => Promise<{ verdict: 'allow' | 'deny' | 'ask'; by: string }>

interface Entry {
  facts: PermissionFacts
  snapshot: CommandSnapshot
  permission: PendingWorkbenchPermission
  expiresAt: number
  finish: (allowed: boolean, outcome: PermissionOutcome) => boolean
  /** 冻住期间撤掉的到期计时器,放开时按剩下的时间重起(网络守护暂停,2026-10-03)。 */
  rearm: (ms: number) => void
  disarm: () => void
}

export function makeRunPermissions(opts: {
  taskId: string
  root?: string
  provider?: string
  stateDir?: string
  /** Only an adapter that owns direct execution can assert this contract.
   * CLI boolean bridges do not supply it; even absolute names may be functions. */
  executionEnvironment?: () => PermissionExecutionEnvironment | undefined
  timeoutMs?: number
  audit?: (event: WorkbenchPermissionAudit) => void
  /** 放行规则:登记之前先问。allow / deny ⇒ 不登记、不发 request 审计(主人收不到通知),只记 outcome 带 by。 */
  decide?: PermissionDecide
}) {
  const entries = new Map<string, Entry>()
  const rules: Rule[] = []
  let closed = false
  /** 暂停时刻(网络守护把执行者冻住时):期间不算进五分钟的批准期限。null = 没暂停。 */
  let pausedAt: number | null = null
  const audit = (event: WorkbenchPermissionAudit): boolean => {
    try { opts.audit?.(event); return true } catch { return false }
  }

  function request(
    raw: { tool: string; description: string; command?: string; paths?: string[]; cwd?: string; requiresBoundExecution?: true },
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (closed || typeof raw?.tool !== 'string' || typeof raw?.description !== 'string') return Promise.resolve(false)
    const tool = raw.tool.trim()
    const description = raw.description.trim()
    if (!tool || !description || tool.length > WORKBENCH_PERMISSION_TOOL_MAX ||
        description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX || signal?.aborted) return Promise.resolve(false)
    const first = authorize(REPORTED_SUBJECT, { ...REPORTED, name: tool })
    // 没接放行规则(opts.decide 不传)⇒ 照旧直接登记、问主人(同步登记,和改之前一样)。
    const facts: PermissionFacts = { tool, description }
    if (typeof raw.command === 'string' && raw.command.trim()) facts.command = raw.command
    if (Array.isArray(raw.paths) && raw.paths.length && raw.paths.every(p => typeof p === 'string' && p)) facts.paths = [...raw.paths]
    if (typeof raw.cwd === 'string' && raw.cwd) facts.cwd = raw.cwd
    if (raw.requiresBoundExecution === true) facts.requiresBoundExecution = true
    const registerOrReuse = (reuse = true, snapshot = inspectPermissionCommand(facts, opts)) => {
      // The shared gate may have awaited a review: inspect the bytes only now.
      reuse = reuse && EDIT_REPORTING_PROVIDERS.has(opts.provider ?? '')
      if (reuse && snapshot.hash && matchRule(rules, snapshot.ask)?.then === 'allow') {
        const permission: PendingWorkbenchPermission = { id: randomUUID(), taskId: opts.taskId, tool, description, createdAt: Date.now() }
        return Promise.resolve(audit({ type: 'outcome', permission, outcome: 'allow', by: 'rule' }))
      }
      return register(facts, reuse ? snapshot : { ...snapshot, hash: undefined }, signal)
    }
    if (!opts.decide || !first.consultOwnerRules) return registerOrReuse()
    return opts.decide(facts).catch(() => ({ verdict: 'ask' as const, by: 'unavailable' })).then(d => {
      if (closed || signal?.aborted) return false
      const ruled = authorize(REPORTED_SUBJECT, { ...REPORTED, name: tool }, { ownerRuling: d })
      const snapshot = inspectPermissionCommand(facts, opts)
      if (ruled.verdict === 'allow' && snapshot.requiresBoundExecution) return registerOrReuse(false, snapshot)
      if (ruled.verdict !== 'ask' && ruled.by) {
        const permission: PendingWorkbenchPermission = { id: randomUUID(), taskId: opts.taskId, tool, description, createdAt: Date.now() }
        const audited = audit({ type: 'outcome', permission, outcome: ruled.verdict, by: ruled.by })
        return audited && ruled.verdict === 'allow'
      }
      // Explicit deny/ask and red lines from the shared gate take precedence.
      return registerOrReuse(d.by === 'default', snapshot)
    })
  }

  function register(facts: PermissionFacts, snapshot: CommandSnapshot, signal?: AbortSignal): Promise<boolean> {
    const { tool, description = '' } = facts
    const permission: PendingWorkbenchPermission = {
      id: randomUUID(),
      taskId: opts.taskId,
      tool,
      description: snapshot.scripts.length || snapshot.requiresBoundExecution ? `${description}\n\n预览是批准时的快照，运行以当时内容为准。允许仅限本请求、本轮和这一次调用；脚本及运行时依赖可能变化。` : description,
      createdAt: Date.now(),
      ...(snapshot.hash ? { canAllowTask: true } : {}),
      ...(snapshot.scripts.length ? { scripts: snapshot.scripts.map(s => s.content.length > 2000 ? { ...s, content: s.content.slice(0, 2000), truncated: true } : { ...s }) } : {}),
    }
    return new Promise<boolean>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.finish(false, 'aborted')
      const finish = (allowed: boolean, outcome: PermissionOutcome) => {
        if (settled) return false
        settled = true
        entries.delete(permission.id)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const audited = audit({ type: 'outcome', permission, outcome })
        resolve(audited ? allowed : false)
        return audited
      }
      const timeoutMs = opts.timeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS
      const rearm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(false, 'expired'), Math.max(0, ms)); timer.unref?.() }
      const disarm = () => { if (timer) clearTimeout(timer); timer = undefined }
      const entry: Entry = { permission, facts, snapshot, expiresAt:permission.createdAt + Math.max(0,timeoutMs), finish, rearm, disarm }
      entries.set(permission.id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (pausedAt === null) rearm(timeoutMs)
      if (!audit({ type: 'request', permission })) finish(false,'ended')
    })
  }

  return {
    request,
    /** Initial and late-subscription notifications share this projection.
     * Failed candidate names can themselves be inline code; only verified file
     * metadata may leave the approval surface. */
    notice(id: string): string {
      const entry = entries.get(id)
      if (!entry) return ''
      const { permission, snapshot, facts } = entry
      const label = snapshot.requiresBoundExecution
        ? `${permission.tool} · 需要你单次批准，详情请在批准卡查看。`
        : `${permission.tool} · ${facts.command ? redactSecrets(facts.command).slice(0, 1200) : '详情请在批准卡查看。'}`
      const files = snapshot.scripts.filter(s => s.sha256).map(s => `脚本 ${s.path}\nSHA-256: ${s.sha256}\n内容请在桌面或手机批准卡查看。`)
      if (snapshot.scripts.some(s => !s.sha256)) files.push('有文件无法安全读取，详情请在批准卡查看。')
      return [label, ...files].join('\n\n')
    },
    script(id: string, path: string, sha256: string, offset: number): { content: string; nextOffset: number | null } {
      const script = entries.get(id)?.snapshot.scripts.find(s => s.path === path && s.sha256 === sha256)
      if (!script || !Number.isSafeInteger(offset) || offset < 0 || offset > script.content.length) throw Error('permission_stale')
      const end = Math.min(offset + 8000, script.content.length)
      return { content: script.content.slice(offset, end), nextOffset: end < script.content.length ? end : null }
    },
    deadline: (id: string): number | null => pausedAt !== null ? null : entries.get(id)?.expiresAt ?? 0,
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
      if (decision === 'allow_task') {
        if (!EDIT_REPORTING_PROVIDERS.has(opts.provider ?? '') || !entry.permission.canAllowTask || !entry.snapshot.hash) return false
        const current = inspectPermissionCommand(entry.facts, opts)
        if (current.hash !== entry.snapshot.hash) { entry.finish(false, 'ended'); return false }
        const audited=entry.finish(true,decision)
        if(audited)rules.push({ id: `task-${id}`, when: { surface: 'workbench', scope: opts.taskId, provider: opts.provider, tool: entry.facts.tool, commandHash: current.hash }, then: 'allow', note: '主人批准本任务内同命令' })
        return audited
      }
      return entry.finish(decision === 'allow', decision)
    },
    rejectAll(outcome: Extract<PermissionOutcome, 'cancelled' | 'ended'> = 'ended'): void {
      closed = true
      rules.length = 0
      for (const entry of [...entries.values()]) entry.finish(false, outcome)
    },
  }
}

export type RunPermissions = ReturnType<typeof makeRunPermissions>
