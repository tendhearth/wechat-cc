/**
 * rules-file.ts — 状态目录 `permission-rules.json` 的解析 / 序列化与规则匹配。
 *
 * 主人或 CC 会直接手改这份 JSON,所以解析从不抛:整份坏了 ⇒ 当关闭(EMPTY_RULES)+ 一条错误;
 * 单条坏了(then 不认识、正则编不过、正则太长)⇒ 只丢那一条,其余照用,错误里写出它的 id。
 * 正则限 200 字、匹配只看命令前 2000 字 —— 主人手写的 `(a+)+$` 也拖不垮一次拍板。
 */
import { homedir } from 'node:os'
import { canonPath, canonText, isUnder, type Platform } from './paths'
import type { PermissionAsk, Rule, RuleWhen, RulesFile, Verdict } from './types'

export const RULES_FILE = 'permission-rules.json'
export const EMPTY_RULES: RulesFile = { version: 1, enabled: false, review: 'off', rules: [] }
export const PATTERN_MAX = 200
export const COMMAND_MATCH_MAX = 2000

/**
 * 正则的安全子集(终审 10-19:只拦「量词套量词」挡不住 `(a|a)+`、`\w*\w*$`、`a?a?a?…`,而 JS 正则掐不了超时、
 * 跑在 daemon 主线程上)。收的形状:分组后面只许跟 `?`、且组里没有量词;无界量词(* + {n,})最多 1 个;量词总数 ≤ 4。
 * 这样最坏是 O(n²)(命令截 2000 字),主人写的 `^git (status|diff)\b.*`、`^(npm|bun) test$` 都在里面。
 */
export function unsafePattern(src: string): string | null {
  const flat = src.replace(/\\./g, 'x').replace(/\[(?:\\.|[^\]])*\]/g, 'x')   // 转义与字符类各当一个字符
  const groupQ = /\(([^()]*)\)([*+{?])/g
  for (let m; (m = groupQ.exec(flat));) {
    if (m[2] !== '?' || /[*+?{]/.test(m[1]!.replace(/^\?[:=!]/, ''))) return '分组后面跟了量词'
  }
  if (/\([^()]*\([^()]*\)[^()]*\)[*+?{]/.test(flat)) return '分组后面跟了量词'
  const quants = flat.replace(/\(\?[:=!<]/g, '(').match(/[*+?]|\{\d+,?\d*\}/g) ?? []
  const unbounded = quants.filter(q => q === '*' || q === '+' || /^\{\d+,\}$/.test(q)).length
  if (unbounded > 1) return '无界量词(* / +)超过 1 个'
  if (quants.length > 4) return '量词超过 4 个'
  return null
}

const VERDICTS: readonly Verdict[] = ['allow', 'ask', 'deny']
const WHEN_KEYS: readonly (keyof RuleWhen)[] = ['surface', 'provider', 'project', 'tool', 'command', 'paths']

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function parseRulesFile(raw: string): { file: RulesFile; errors: string[] } {
  let v: unknown
  try { v = JSON.parse(raw) } catch (e) { return { file: { ...EMPTY_RULES, rules: [] }, errors: [`规则文件不是合法 JSON:${errMsg(e)}`] } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { file: { ...EMPTY_RULES, rules: [] }, errors: ['规则文件不是一个对象'] }
  const o = v as Record<string, unknown>
  const errors: string[] = []
  const rules: Rule[] = []
  const list = Array.isArray(o.rules) ? o.rules : []
  if (o.rules !== undefined && !Array.isArray(o.rules)) errors.push('rules 不是数组,已忽略')
  list.forEach((item, i) => {
    const r = parseRule(item, i)
    if (typeof r === 'string') errors.push(r)
    else rules.push(r)
  })
  return {
    file: { version: 1, enabled: o.enabled === true, review: o.review === 'low_risk' ? 'low_risk' : 'off', rules,
      ...(typeof o.starter === 'number' && Number.isInteger(o.starter) && o.starter > 0 ? { starter: o.starter } : {}) },
    errors,
  }
}

function parseRule(item: unknown, i: number): Rule | string {
  const fallbackId = `r${i + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item)) return `第 ${i + 1} 条规则不是对象,已丢弃`
  const o = item as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : fallbackId
  if (!VERDICTS.includes(o.then as Verdict)) return `规则 ${id}:then 只能是 allow / ask / deny,已丢弃`
  const whenRaw = o.when && typeof o.when === 'object' && !Array.isArray(o.when) ? o.when as Record<string, unknown> : {}
  const when: RuleWhen = {}
  for (const k of WHEN_KEYS) {
    const val = whenRaw[k]
    if (val === undefined) continue
    if (typeof val !== 'string' || !val) return `规则 ${id}:when.${k} 必须是非空字符串,已丢弃`
    if (val.length > PATTERN_MAX) return `规则 ${id}:when.${k} 超过 ${PATTERN_MAX} 字,已丢弃`
    if (k === 'surface' && val !== 'terminal' && val !== 'workbench') return `规则 ${id}:when.surface 只能是 terminal / workbench,已丢弃`
    if (k === 'command') {
      try { new RegExp(val) } catch (e) { return `规则 ${id}:command 正则编不过(${errMsg(e)}),已丢弃` }
      const unsafe = unsafePattern(val)
      if (unsafe) return `规则 ${id}:command 正则可能卡死(${unsafe}),已丢弃`
    }
    ;(when as Record<string, string>)[k] = val
  }
  const rule: Rule = { id, when, then: o.then as Verdict }
  if (typeof o.note === 'string' && o.note.trim()) rule.note = o.note.trim()
  return rule
}

/**
 * 起步规则(放行 v2 G1,设计稿 2026-10-23-permission-judge-v2-design):只放 v1 代码里本来就算低风险的那几类,写成规则是为了
 * 主人看得见、改得了。**只收精确的 git 只读命令**,不带参数 —— 参数里可能藏 `--output` 这类会写文件的选项(v1 的 isLowRisk
 * 挡它,规则不挡);带参数的、读文件、列目录交给初审(review: low_risk 时),它先过 isLowRisk 再问模型。
 * **不收「跑测试」**:测试执行的是仓库里的代码(设计稿 G2)。
 */
export const STARTER_VERSION = 1
export const STARTER_RULES: readonly Rule[] = [
  // 不写 tool:Claude 叫 Bash、Codex 叫 commandExecution、ACP 叫 execute —— 只有 shell 类请求带命令原文,按命令就够了
  { id: 's1', when: { command: '^git (status|diff|log|show)$' }, then: 'allow', note: '看 git 状态 / 改动 / 历史不用问(起步规则)' },
  { id: 's2', when: { command: '^git (status --short|diff --stat|log --oneline)$' }, then: 'allow', note: '同上,常用的短格式(起步规则)' },
]

/**
 * 什么时候装起步规则:文件不存在,或者是一份**从没装过起步规则**的全空默认值(关着、初审关、零条规则)。
 * 主人手改过(哪怕只开了开关 / 加了一条)⇒ 不动;装过一次(starter 有值)⇒ 永远不再动。回 null = 不用改。
 */
export function withStarterRules(current: RulesFile | null): RulesFile | null {
  if (current && (current.starter !== undefined || current.enabled || current.review !== 'off' || current.rules.length)) return null
  return { version: 1, enabled: true, review: 'low_risk', rules: STARTER_RULES.map(r => ({ ...r, when: { ...r.when } })), starter: STARTER_VERSION }
}

export function serializeRulesFile(f: RulesFile): string {
  return JSON.stringify(f, null, 2) + '\n'
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p)
const globCache = new Map<string, RegExp>()
function globRe(glob: string): RegExp {
  let re = globCache.get(glob)
  if (re) return re
  let s = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*' && glob[i + 1] === '*') { s += '.*'; i++ }
    else if (ch === '*') s += '[^/]*'
    else s += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  re = new RegExp(`^${s}$`)
  globCache.set(glob, re)
  return re
}

function matches(when: RuleWhen, ask: PermissionAsk, platform: Platform): boolean {
  if (when.surface && when.surface !== ask.surface) return false
  if (when.provider && when.provider !== ask.provider) return false
  if (when.project && (!ask.project || !isUnder(ask.project, expandHome(when.project), platform))) return false
  if (when.tool) {
    if (when.tool.endsWith('*')) { if (!ask.tool.startsWith(when.tool.slice(0, -1))) return false }
    else if (when.tool !== ask.tool) return false
  }
  if (when.command) {
    if (!ask.command) return false
    if (!new RegExp(when.command).test(ask.command.slice(0, COMMAND_MATCH_MAX))) return false
  }
  if (when.paths) {
    if (!ask.paths?.length) return false
    const glob = canonText(expandHome(when.paths), platform)
    const re = globRe(glob)
    // win32 上没写盘符的 glob(`/Work/…`)对任何盘都算:比对前把路径的盘符去掉。
    const anyDrive = platform === 'win32' && glob.startsWith('/') && !glob.startsWith('//')
    if (!ask.paths.every(p => { const c = canonPath(p, platform); return re.test(anyDrive ? c.replace(/^[a-z]:/, '') : c) })) return false
  }
  return true
}

/** deny 规则先于一切;其余按表内顺序第一条命中。没命中 ⇒ null。 */
export function matchRule(rules: readonly Rule[], ask: PermissionAsk, platform: Platform = process.platform): Rule | null {
  const deny = rules.find(r => r.then === 'deny' && matches(r.when, ask, platform))
  if (deny) return deny
  return rules.find(r => r.then !== 'deny' && matches(r.when, ask, platform)) ?? null
}
