/**
 * permission-gate.ts — 放行规则在 daemon 里的那一层(spec 2026-10-19-permission-rules-design):
 * 读规则文件(按 mtime 缓存,主人 / CLI 改了下一条请求就生效)、接便宜模型初审、写留痕、防一路放行。
 * 三处入口(终端会话中继、一起做、主人自己的对话 —— 后者经 makeChatOwnerRules)只认 `decide()`,它永不抛:任何意外 ⇒ ask(= 今天的老路)。
 *
 * 记不下来就不放:CC 替主人批了却找不到记录,是反目标里的第一条 —— 留痕失败的 allow / deny 一律改回 ask。
 * 初审调的是 registry.getCheapEval(),它自己按网络守护跳过不安全的候选;被拒 / 抛错 ⇒ ask,不重试。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { decide as decideCore, parseReviewAnswer, reviewPrompt, type Review } from '../adapters/permission-rules/decide'
import { EMPTY_RULES, parseRulesFile, RULES_FILE, serializeRulesFile, STARTER_VERSION, withStarterRules } from '../adapters/permission-rules/rules-file'
import { writeFileAtomic } from '../lib/json-file'
import type { AskSource, Decision, PermissionAsk, RulesFile, Verdict } from '../domain/permission-rules/types'
import { authorize, type AuthSubject } from '../domain/authorize'
import { TIER_PROFILES } from '../domain/user-tier'
import type { PermissionDecisionsStore } from './permission-decisions-store'
import type { CliPermissionRequest } from '../app/cli-permission-relay'
import type { AllowHook, ChatOwnerRules, RuleAllowNotice } from '../adapters/permission-rules/chat'
import { repoRootOf } from '../adapters/git/worktree-workspaces'

export const RUNAWAY_WINDOW_MS = 10 * 60_000
export const RUNAWAY_MAX = 20
const DAY_MS = 24 * 3600_000

export interface PermissionGate {
  /** beforeAllow:见 ChatOwnerRules.decide —— 规则说放、写留痕之前调;null ⇒ 回 ask、不留痕。 */
  decide(ask: AskSource, beforeAllow?: AllowHook): Promise<Decision>
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
const OFF: Decision = { verdict: 'ask', by: 'default', reason: '放行规则关着' }
const NOT_SHOWN: Decision = { verdict: 'ask', by: 'default', reason: '放行提醒送不到这一轮,交给你' }

/** 最深的、存在的祖先 realpath 后接上剩下那截 —— 软链指到工作区外的路径照实算外面(终审 10-19)。 */
function realish(p: string): string {
  let head = p, tail = ''
  for (let i = 0; i < 64 && !existsSync(head); i++) {
    const up = dirname(head)
    if (up === head) return p
    tail = tail ? join(basename(head), tail) : basename(head)
    head = up
  }
  try { const r = realpathSync.native(head); return tail ? join(r, tail) : r } catch { return p }
}

/** 相对路径按项目根(没有就 cwd)解析,`..` 归一,软链展开。 */
export function normalizePaths(ask: PermissionAsk): PermissionAsk {
  if (!ask.paths?.length) return ask
  const base = ask.project ?? ask.cwd
  const paths = ask.paths.map(p => realish(isAbsolute(p) ? resolve(p) : base ? resolve(base, p) : resolve(p)))
  return { ...ask, paths }
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * 开机时装一次起步规则(放行 v2 G1):文件不在、或是一份从没装过的全空默认值 ⇒ 开起来 + 几条精确的 git 只读规则。
 * 文件坏了 / 主人改过 / 装过 ⇒ 一个字节不动。失败只记日志 —— 装不上就照旧关着,跟以前一样问主人。
 */
/** 只说真有的关法:「放行规则关掉」是 admin 行 rules.toggle。 */
export const STARTER_NOTICE = '放行规则开了:Claude / Codex 跑只读的 git 命令(看状态 / 改动 / 历史)我替你批,别的照旧问你。不想要就跟我说「放行规则关掉」。'

/**
 * 微信里「放行规则关掉 / 打开」(admin 行 rules.toggle):只改开关,别的一个字节不动。坏文件不覆盖(主人手改了一半的东西不能被冲掉)。
 * 和 CLI `wechat-cc rules enable|disable`(src/cli/rules.ts)同一个动作;daemon 不能引 cli,所以这里自己写这几行。
 */
export function setRulesEnabled(stateDir: string, enabled: boolean): { ok: true; changed: boolean } | { ok: false; error: string } {
  const file = join(stateDir, RULES_FILE)
  let current: RulesFile = { ...EMPTY_RULES, rules: [] }
  if (existsSync(file)) {
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch (e) { return { ok: false, error: `读不了规则文件:${errMsg(e)}` } }
    const parsed = parseRulesFile(raw)
    if (parsed.errors.length) return { ok: false, error: `规则文件有错,先在电脑上修好(${parsed.errors[0]})` }
    current = parsed.file
  }
  if (current.enabled === enabled) return { ok: true, changed: false }
  // 主人亲手开 / 关过 ⇒ 记上 starter,以后开机不会再替主人装起步规则、改开关
  try { writeFileAtomic(file, serializeRulesFile({ ...current, enabled, starter: current.starter ?? STARTER_VERSION }), { mode: 0o600 }) }
  catch (e) { return { ok: false, error: `写不进规则文件:${errMsg(e)}` } }
  return { ok: true, changed: true }
}

export function ensureStarterRules(stateDir: string, log: (tag: string, line: string) => void): boolean {
  const file = join(stateDir, RULES_FILE)
  let current: RulesFile | null = null
  if (existsSync(file)) {
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch (e) { log('PERMISSION_RULES', `starter: unreadable, left alone: ${errMsg(e)}`); return false }
    const parsed = parseRulesFile(raw)
    if (parsed.errors.length) return false
    current = parsed.file
  }
  const next = withStarterRules(current)
  if (!next) return false
  try { writeFileAtomic(file, serializeRulesFile(next), { mode: 0o600 }) } catch (e) { log('PERMISSION_RULES', `starter: write failed: ${errMsg(e)}`); return false }
  log('PERMISSION_RULES', `starter rules v${next.starter} installed (enabled, review low_risk, ${next.rules.length} rules)`)
  return true
}

export function makePermissionGate(deps: PermissionGateDeps): PermissionGate {
  const now = deps.now ?? (() => Date.now())
  const file = join(deps.stateDir, RULES_FILE)
  // 红线比对用真路径(Windows 上临时目录常是 8.3 短名,请求里的路径经 realpath.native 是长名 —— 两边得一致)。
  let stateDirReal = deps.stateDir
  try { stateDirReal = realpathSync.native(deps.stateDir) } catch { /* 目录还没建:按原样 */ }
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

  /** 正在初审的(还没回)也算一个名额 —— 并发的初审不能一起冲过上限(终审 10-19)。 */
  const inflight = new Map<string, number>()
  const reviewBlocked = (scope: string): boolean => {
    if (recent(scope).length + (inflight.get(scope) ?? 0) < RUNAWAY_MAX) { notified.delete(scope); inflight.set(scope, (inflight.get(scope) ?? 0) + 1); return false }
    if (!notified.has(scope)) {
      notified.add(scope)
      try { deps.notifyOwner(`CC 在「${scope.slice(0, 8)}」上 10 分钟里替你放行了 ${RUNAWAY_MAX} 条,后面的改回问你。`) }
      catch (e) { deps.log('PERMISSION_RULES', `notify failed: ${errMsg(e)}`) }
    }
    return true
  }
  const release = (scope: string) => { const n = (inflight.get(scope) ?? 0) - 1; if (n > 0) inflight.set(scope, n); else inflight.delete(scope) }

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
    async decide(source, beforeAllow) {
      let reserved: string | null = null
      try {
        const { rules } = load()
        if (!rules.enabled) return OFF
        // 已知隐患(留着,和终端共用):normalizePaths 先 resolve 掉 `..` 再展开软链,`link/..` 会按字面消掉而不是按软链目标。
        // 对话里今天走不到(主人对话里带路径的工具按档位直接放,不到规则);以后对话规则要管带路径的工具,先改这里。
        const ask = normalizePaths(typeof source === 'function' ? await source() : source)
        const d = await decideCore(ask, rules, { review: review(), reviewBlocked: (scope) => { const b = reviewBlocked(scope); if (!b) reserved = scope; return b }, stateDir: stateDirReal })
        // 规则说放 ⇒ 先让调用方确认这次真放得了(对话:提醒登记上了),再写留痕 —— 留痕只记最后真发生的事。
        let undo: (() => void) | null = null
        if (d.verdict === 'allow' && beforeAllow) {
          try { undo = beforeAllow(d) } catch { undo = null }
          if (!undo) return NOT_SHOWN
        }
        if (!record(ask, d)) { try { undo?.() } catch { /* 撤销提醒失败只少一行提醒,不改结论 */ } return ASK }
        if (d.by === 'review' && d.verdict === 'allow') reviewAllows.set(ask.scope, [...recent(ask.scope), now()])
        // 日志不写命令原文。
        if (d.by !== 'default') deps.log('PERMISSION_RULES', `${ask.surface}/${ask.provider} ${ask.tool} → ${d.verdict} by ${d.by}${d.ruleId ? ` (${d.ruleId})` : ''}`)
        return d
      } catch (e) {
        deps.log('PERMISSION_RULES', `decide failed (ask): ${errMsg(e)}`)
        return ASK
      } finally {
        if (reserved) release(reserved)
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

/** 同上,但不堵事件循环(2 秒封顶):终端的权限请求一条都不该让 daemon 停下来等 git。 */
export function projectRootOfAsync(cwd: string): Promise<string | null> {
  return new Promise(res => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000, windowsHide: true }, (err, stdout) => {
      const top = !err && typeof stdout === 'string' ? stdout.trim() : ''
      if (!top) return res(null)
      try { res(realpathSync.native(top)) } catch { res(null) }
    })
  })
}

export async function terminalAskAsync(req: CliPermissionRequest): Promise<PermissionAsk> {
  const root = await projectRootOfAsync(req.cwd)
  return terminalAsk(req, () => root)
}

/** hook 报来的一条权限请求 → 放行规则的请求。调用方已确认它来自本机主人(不是脑手转发)。 */
export function terminalAsk(req: CliPermissionRequest, rootOf: (cwd: string) => string | null = projectRootOf): PermissionAsk {
  const ask: PermissionAsk = {
    surface: 'terminal', provider: req.source, tool: req.tool_name,
    cwd: req.cwd, project: rootOf(req.cwd), isolatedWorktree: false, tier: 'admin', scope: req.session_id,
  }
  if (req.command) ask.command = req.command
  if (req.paths?.length) ask.paths = req.paths
  if (req.summary) ask.description = req.summary
  return ask
}

/** 终端会话:hook 报来的是本机主人自己的会话(脑手转发的不走规则,见 cli-permission-relay),档位只是占位、不参与判定。 */
const TERMINAL_SUBJECT: AuthSubject = { surface: 'terminal', tier: TIER_PROFILES.admin, permissionMode: 'strict', executor: 'claude' }

/**
 * 终端会话中继的 `decide`(架构终态 C2):hook 报上来的就是要批准的调用 ⇒ authorize 起点是问;面是 terminal ⇒ 先过
 * 放行规则(gate.decide 读规则文件、初审、留痕),拿到裁决再交回 authorize 落成放 / 拒 / 问。
 */
export function makeTerminalDecide(
  gate: Pick<PermissionGate, 'decide'>,
  askOf: (req: CliPermissionRequest) => Promise<PermissionAsk> = terminalAskAsync,
): (req: CliPermissionRequest) => Promise<Verdict> {
  return async (req) => {
    const reported = { name: req.tool_name, kind: 'subagent', reported: true } as const
    if (!authorize(TERMINAL_SUBJECT, reported).consultOwnerRules) return 'ask'
    return authorize(TERMINAL_SUBJECT, reported, { ownerRuling: await gate.decide(() => askOf(req)) }).verdict
  }
}

/**
 * 主人自己的对话走放行规则(2026-10-25 主人点头):三家逐工具过闸门的执行者(Claude / Gemini / OpenAI 兼容)经
 * core/permission-rules/chat.ts 的 authorizeChatCall 用它。
 *   isOwnerChat  判的那一刻读 access.json(带 5 秒缓存),只认 admins —— 原始档位,不看 --dangerously(那个开关会把每个对话
 *                都当 admin 给 SDK 用,这里不能跟着它走);
 *   decide       同一个 permission-gate(同一份规则文件、红线、留痕、出事就 ask);
 *   noteAllowed  回复交付的那一轮(reply-delivery.noteRuleAllow):登记不上 ⇒ 不放。
 */
export function makeChatOwnerRules(deps: {
  gate: Pick<PermissionGate, 'decide'>
  isOwnerChat: (chatId: string) => boolean
  replyDelivery: { noteRuleAllow(chatId: string, notice: RuleAllowNotice): (() => void) | null }
}): ChatOwnerRules {
  return {
    isOwnerChat: (chatId) => !!chatId && deps.isOwnerChat(chatId),
    decide: (ask, beforeAllow) => deps.gate.decide(ask, beforeAllow),
    noteAllowed: (chatId, notice) => deps.replyDelivery.noteRuleAllow(chatId, notice),
  }
}
