/**
 * permission-gate.ts — 放行规则在 daemon 里的那一层(spec 2026-10-19-permission-rules-design):
 * 读规则文件(按 mtime 缓存,主人 / CLI 改了下一条请求就生效)、接便宜模型初审、写留痕、防一路放行。
 * 两处入口(终端会话中继、一起做)只认 `decide()`,它永不抛:任何意外 ⇒ ask(= 今天的老路)。
 *
 * 记不下来就不放:CC 替主人批了却找不到记录,是反目标里的第一条 —— 留痕失败的 allow / deny 一律改回 ask。
 * 初审调的是 registry.getCheapEval(),它自己按网络守护跳过不安全的候选;被拒 / 抛错 ⇒ ask,不重试。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decide as decideCore, parseReviewAnswer, reviewPrompt, type Review } from '../core/permission-rules/decide'
import { EMPTY_RULES, parseRulesFile, RULES_FILE } from '../core/permission-rules/rules-file'
import type { Decision, PermissionAsk, RulesFile } from '../core/permission-rules/types'
import type { PermissionDecisionsStore } from './permission-decisions-store'
import type { CliPermissionRequest } from '../core/cli-permission-relay'
import { repoRootOf } from '../core/workbench/worktree-workspaces'

export const RUNAWAY_WINDOW_MS = 10 * 60_000
export const RUNAWAY_MAX = 20
const DAY_MS = 24 * 3600_000

export interface PermissionGate {
  decide(ask: PermissionAsk): Promise<Decision>
  status(): { enabled: boolean; review: 'off' | 'low_risk'; rules: number; errors: string[] }
}

export interface PermissionGateDeps {
  stateDir: string
  store: PermissionDecisionsStore | null
  cheapEval: () => ((prompt: string) => Promise<string>) | null
  notifyOwner: (text: string) => void
  now?: () => number
  log: (tag: string, line: string) => void
}

const ASK: Decision = { verdict: 'ask', by: 'default', reason: '放行规则出错,交给你' }
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function makePermissionGate(deps: PermissionGateDeps): PermissionGate {
  const now = deps.now ?? (() => Date.now())
  const file = join(deps.stateDir, RULES_FILE)
  let cache: { key: string; rules: RulesFile; errors: string[] } | null = null
  const reviewAllows = new Map<string, number[]>()
  const notified = new Set<string>()
  let prunedAt = 0

  function load(): { rules: RulesFile; errors: string[] } {
    let key: string
    try { const s = statSync(file); key = `${s.mtimeMs}:${s.size}` } catch { return { rules: EMPTY_RULES, errors: [] } }
    if (cache?.key === key) return cache
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch (e) { return { rules: EMPTY_RULES, errors: [`读不了规则文件:${errMsg(e)}`] } }
    const parsed = parseRulesFile(raw)
    cache = { key, rules: parsed.file, errors: parsed.errors }
    if (parsed.errors.length) deps.log('PERMISSION_RULES', `rules file: ${parsed.errors.length} error(s)`)
    return cache
  }

  const recent = (scope: string): number[] => {
    const cutoff = now() - RUNAWAY_WINDOW_MS
    const list = (reviewAllows.get(scope) ?? []).filter(t => t > cutoff)
    if (list.length) reviewAllows.set(scope, list); else reviewAllows.delete(scope)
    return list
  }

  const reviewBlocked = (scope: string): boolean => {
    if (recent(scope).length < RUNAWAY_MAX) { notified.delete(scope); return false }
    if (!notified.has(scope)) {
      notified.add(scope)
      try { deps.notifyOwner(`CC 在「${scope.slice(0, 8)}」上 10 分钟里替你放行了 ${RUNAWAY_MAX} 条,后面的改回问你。`) }
      catch (e) { deps.log('PERMISSION_RULES', `notify failed: ${errMsg(e)}`) }
    }
    return true
  }

  const review = (): Review | undefined => {
    let fn: ((prompt: string) => Promise<string>) | null
    try { fn = deps.cheapEval() } catch { fn = null }
    if (!fn) return undefined
    return async (ask, notes) => parseReviewAnswer(await fn!(reviewPrompt(ask, notes)))
  }

  function record(ask: PermissionAsk, d: Decision): boolean {
    if (d.verdict === 'ask' || d.by === 'default') return true
    if (!deps.store) return false
    const t = now()
    if (t - prunedAt > DAY_MS) { prunedAt = t; try { deps.store.prune(t) } catch { /* 下次再清 */ } }
    try {
      deps.store.record({
        at: t, surface: ask.surface, provider: ask.provider, project: ask.project, tool: ask.tool,
        summary: ask.command ?? ask.paths?.join(' ') ?? ask.tool,
        verdict: d.verdict, by: d.by, ruleId: d.ruleId ?? null, reason: d.reason, scope: ask.scope,
      })
      return true
    } catch (e) {
      deps.log('PERMISSION_RULES', `record failed (falling back to ask): ${errMsg(e)}`)
      return false
    }
  }

  return {
    async decide(ask) {
      try {
        const { rules } = load()
        const d = await decideCore(ask, rules, { review: review(), reviewBlocked })
        if (!record(ask, d)) return ASK
        if (d.by === 'review' && d.verdict === 'allow') reviewAllows.set(ask.scope, [...recent(ask.scope), now()])
        // 日志不写命令原文。
        if (d.by !== 'default') deps.log('PERMISSION_RULES', `${ask.surface}/${ask.provider} ${ask.tool} → ${d.verdict} by ${d.by}${d.ruleId ? ` (${d.ruleId})` : ''}`)
        return d
      } catch (e) {
        deps.log('PERMISSION_RULES', `decide failed (ask): ${errMsg(e)}`)
        return ASK
      }
    },
    status() {
      const { rules, errors } = load()
      return { enabled: rules.enabled, review: rules.review, rules: rules.rules.length, errors }
    },
  }
}

/** 终端会话的项目根 = cwd 所在仓库的 toplevel(realpath;Windows 走 .native)。不在仓库里 ⇒ null(没有「项目内」待遇)。 */
export function projectRootOf(cwd: string): string | null {
  return repoRootOf(cwd)
}

/** hook 报来的一条权限请求 → 放行规则的请求。调用方已确认它来自本机主人(不是脑手转发)。 */
export function terminalAsk(req: CliPermissionRequest, rootOf: (cwd: string) => string | null = projectRootOf): PermissionAsk {
  const ask: PermissionAsk = {
    surface: 'terminal', provider: req.source, tool: req.tool_name,
    cwd: req.cwd, project: rootOf(req.cwd), isolatedWorktree: false, tier: 'admin', scope: req.session_id,
  }
  if (req.command) ask.command = req.command
  if (req.paths?.length) ask.paths = req.paths
  return ask
}
