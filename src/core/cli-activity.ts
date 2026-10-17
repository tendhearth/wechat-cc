/**
 * cli-activity.ts — 终端会话「现在在干什么」(2026-10-17):从会话记录尾巴读出最近几步,手机上看着它跑。
 *
 * 和「看 码」(cli-transcript.ts)的区别:那边只要对话文字;这里还要动作 —— 跑了什么命令、改了哪个文件、
 * 派了什么子任务 —— 每一步翻成一句人话(「运行 npm test」「改 main.ts」)。只读、不改记录,密钥照样打码。
 *
 * 三家的记录形状见 cli-transcript.ts 文件头。动作的形状:
 * - Claude:assistant 的 content 里 { type: tool_use, name, input };name 是 Bash / Edit / Read / Task / mcp__x__y …
 * - Codex(老):response_item.payload { type: function_call, name: shell|exec_command, arguments: JSON 串 }
 *   或 { type: local_shell_call, action: { command } }
 * - Codex(新):payload { type: custom_tool_call, name: exec, input: JS 源码 },里面是 tools.exec_command({cmd:"…"})
 *   / tools.apply_patch("*** Update File: …")。读不出就退回「用工具 exec」,不猜。
 * - Cursor:记录里只有文字,没有动作 ⇒ 只出文字。
 */
import type { CliSource } from './cli-events'
import { parseTranscript, redactSecrets } from './cli-transcript'

export type CliActivityKind = 'you' | 'said' | 'step'
/**
 * detail(2026-10-17,只在 step 上):点开这一步能看的 —— 改文件是 diff(`- 旧` / `+ 新`),跑命令是输出尾巴。
 * error:这一步的工具报错了(命令非零退出 / 工具 is_error)。
 */
export interface CliActivityItem { kind: CliActivityKind; text: string; at: number | null; detail?: string; error?: boolean; verb?: StepVerb; target?: string }
/** free:这一句是模型自己写的(Claude 给命令写的说明),不是我们拼的固定说法 ⇒ 不拆 verb/target。 */
interface Step { text: string; detail?: string; callId?: string; keepOutput?: boolean; free?: boolean }

/**
 * 一步 = 动作 + 对象(2026-10-17):text 是拼好的中文(手机网页、微信用);verb + target 给要按语言显示的端(App 英文界面)。
 * 每个 verb 对应 text 里固定的一种说法,stepPhrase 从 text 反解 —— 说法只在 ZH 这一处定义。
 */
export type StepVerb = 'run' | 'edit' | 'write' | 'delete' | 'read' | 'search' | 'find' | 'subtask' | 'web' | 'websearch' | 'todo' | 'todos' | 'plan' | 'tend' | 'tool' | 'bgoutput'
const ZH: Array<[StepVerb, string, string]> = [
  // [verb, 前缀, 后缀]:target 在中间;前后缀都为空串以外的固定句(没有 target)写在前缀里、后缀放 '\0' 标记整句匹配。
  ['bgoutput', '看后台命令的输出', '\0'], ['todos', '更新清单', '\0'], ['plan', '更新计划', '\0'], ['tend', '照看子任务', '\0'],
  ['websearch', '上网搜「', '」'], ['search', '搜「', '」'], ['find', '找文件 ', ''], ['subtask', '派子任务:', ''], ['web', '看网页 ', ''],
  ['todo', '清单:', ''], ['run', '运行 ', ''], ['edit', '改 ', ''], ['write', '写 ', ''], ['delete', '删 ', ''], ['read', '读 ', ''], ['tool', '用 ', ''],
]
export function stepPhrase(text: string): { verb: StepVerb; target: string } | null {
  for (const [verb, pre, post] of ZH) {
    if (post === '\0') { if (text === pre) return { verb, target: '' }; continue }
    if (text.startsWith(pre) && text.endsWith(post) && text.length > pre.length + post.length) return { verb, target: text.slice(pre.length, text.length - post.length) }
  }
  return null
}

/** 手机一屏看得完的量:最多这么多步,每句最多这么多字。 */
export const ACTIVITY_MAX_ITEMS = 40
export const ACTIVITY_TEXT_MAX = 600
const STEP_MAX = 120
/** 点开一步最多看这么多:diff 留开头若干行,输出留结尾若干行(结论通常在最后)。 */
export const DETAIL_MAX = 1500
const DETAIL_LINES = 40

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s)
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/** 旧 → 新 两段文字的简单对照:不做真 diff,只把两边整段列出(前后相同的行去掉,只留改了的那一截)。 */
export function textDiff(oldText: string, newText: string): string {
  const a = oldText.split('\n'), b = newText.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out = [...a.slice(head, a.length - tail).map(l => `- ${l}`), ...b.slice(head, b.length - tail).map(l => `+ ${l}`)]
  return out.join('\n')
}
function headLines(t: string): string {
  const lines = t.split('\n')
  const kept = lines.slice(0, DETAIL_LINES).join('\n')
  const cut = lines.length > DETAIL_LINES ? `${kept}\n…(还有 ${lines.length - DETAIL_LINES} 行)` : kept
  return cut.length > DETAIL_MAX ? cut.slice(0, DETAIL_MAX - 1) + '…' : cut
}
function tailLines(t: string): string {
  const lines = t.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n')
  const kept = lines.slice(-DETAIL_LINES).join('\n')
  const cut = lines.length > DETAIL_LINES ? `…(前面还有 ${lines.length - DETAIL_LINES} 行)\n${kept}` : kept
  return cut.length > DETAIL_MAX ? '…' + cut.slice(-(DETAIL_MAX - 1)) : cut
}
/** Codex apply_patch 的补丁:按文件切开,每个文件只留 `+` / `-` 行。 */
function patchSections(patch: string): Array<{ verb: string; file: string; detail: string }> {
  const out: Array<{ verb: string; file: string; detail: string }> = []
  const re = /\*\*\* (Update|Add|Delete) File: ([^\n]+)\n?/g
  const heads = [...patch.matchAll(re)]
  heads.forEach((h, i) => {
    const body = patch.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1]!.index : undefined)
    const lines = body.split('\n').filter(l => /^[+-]/.test(l) && !l.startsWith('***')).map(l => `${l[0]} ${l.slice(1)}`)
    out.push({ verb: h[1] === 'Add' ? '写' : h[1] === 'Delete' ? '删' : '改', file: baseName(h[2]!.trim()), detail: lines.join('\n') })
  })
  return out
}

/** 一条命令 → 「运行 …」:只取第一行,多行的标个省略。 */
function runStep(cmd: string): string {
  // `cd 某目录 && 真正的命令`:目录主人已经知道(项目名就在标题上),只留后半截。
  const body = cmd.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
  const first = body.split('\n')[0] ?? ''
  return `运行 ${oneLine(first)}${body.includes('\n') ? ' …' : ''}`
}

const claudeBashNote = (input: Record<string, unknown>) => oneLine(str(input['description']))

/** Claude 的工具名 + 参数 → 一句人话。认不出的写「用 <名字>」。 */
export function claudeStep(name: string, input: Record<string, unknown>): string {
  const file = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  switch (name) {
    // Claude 自己给命令写的一句说明比命令本身好懂,有就用它。
    case 'Bash': return claudeBashNote(input) || runStep(str(input['command']))
    case 'BashOutput': return '看后台命令的输出'
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `改 ${baseName(file)}`
    case 'Write': return `写 ${baseName(file)}`
    case 'Read': return `读 ${baseName(file)}`
    case 'Grep': return `搜「${oneLine(str(input['pattern']))}」`
    case 'Glob': return `找文件 ${oneLine(str(input['pattern']))}`
    case 'Task': case 'Agent': return `派子任务:${oneLine(str(input['description']) || str(input['prompt']))}`
    case 'WebFetch': return `看网页 ${hostOf(str(input['url']))}`
    case 'WebSearch': return `上网搜「${oneLine(str(input['query']))}」`
    case 'TodoWrite': {
      const todos = Array.isArray(input['todos']) ? input['todos'] as Array<Record<string, unknown>> : []
      const doing = todos.find(t => t && t['status'] === 'in_progress')
      const label = doing ? str(doing['activeForm']) || str(doing['content']) : ''
      return label ? `清单:${oneLine(label)}` : '更新清单'
    }
    default: {
      // mcp__<服务>__<工具>:服务名常是 plugin_playwright_playwright 这种,对主人没意义 —— 只留工具名。
      const m = /^mcp__.+?__(.+)$/.exec(name)
      return `用 ${m ? m[1] : name}`
    }
  }
}

/** Claude 改文件的那几个工具:直接从参数里拼出 diff(不用等结果)。 */
function claudeDetail(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Edit') return textDiff(str(input['old_string']), str(input['new_string']))
  if (name === 'MultiEdit' && Array.isArray(input['edits'])) {
    return (input['edits'] as Array<Record<string, unknown>>).map(e => textDiff(str(e?.['old_string']), str(e?.['new_string']))).join('\n⋯\n')
  }
  if (name === 'Write') return str(input['content']).split('\n').map(l => `+ ${l}`).join('\n')
  return undefined
}
/** 结果值得看的工具:命令、搜索、子任务、网页。读文件的结果就是文件本身,不放。 */
const CLAUDE_KEEP_OUTPUT = new Set(['Bash', 'BashOutput', 'Grep', 'Glob', 'Task', 'Agent', 'WebFetch', 'WebSearch'])

/** Codex 新格式:exec 工具的 JS 源码里抠出命令 / 补丁的文件;一段里可能有好几条,各出一步。 */
export function codexExecSteps(source: string): Step[] {
  const steps: Step[] = []
  // 按 `tools.xxx(` 切段(不靠括号配对:命令里常有 `$(…)`),每段到下一个 `tools.` 为止。
  const starts = [...source.matchAll(/tools\.(exec_command|apply_patch)\(/g)]
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!
    const from = m.index! + m[0].length
    const body = source.slice(from, i + 1 < starts.length ? starts[i + 1]!.index : undefined)
    if (m[1] === 'exec_command') {
      const cmd = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
      if (cmd) { let c = cmd[1]!; try { c = JSON.parse(`"${c}"`) as string } catch { /* 留原样 */ } steps.push({ text: runStep(c), keepOutput: true }) }
    } else {
      // 补丁是一个 JS 字符串字面量:先解开转义再按文件切。
      const lit = /^\s*"((?:[^"\\]|\\.)*)"/.exec(body)
      let patch = lit ? lit[1]! : body
      try { if (lit) patch = JSON.parse(`"${lit[1]}"`) as string } catch { /* 解不开就按原样切 */ }
      for (const f of patchSections(patch)) steps.push({ text: `${f.verb} ${f.file}`, ...(f.detail ? { detail: f.detail } : {}) })
    }
  }
  return steps
}

function codexFunctionStep(name: string, args: string): Step {
  let a: Record<string, unknown> = {}
  try { a = JSON.parse(args) as Record<string, unknown> } catch { /* 参数不是 JSON:只报名字 */ }
  if (name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    const c = a['command'] ?? a['cmd']
    const cmd = Array.isArray(c) ? (c[0] === 'bash' && c[1] === '-lc' ? str(c[2]) : c.map(String).join(' ')) : str(c)
    return { text: runStep(cmd), keepOutput: true }
  }
  if (name === 'apply_patch') return codexExecSteps(`tools.apply_patch(${JSON.stringify(str(a['input']) || args)})`)[0] ?? { text: '改文件' }
  if (name === 'spawn_agent') return { text: `派子任务:${oneLine(str(a['task_name']) || str(a['agent_type']))}` }
  if (name === 'followup_task' || name === 'send_message' || name === 'wait_agent' || name === 'list_agents') return { text: '照看子任务' }
  if (name === 'update_plan') return { text: '更新计划' }
  return { text: `用 ${name}` }
}

function tsOf(d: Record<string, unknown>): number | null {
  const t = d['timestamp']
  if (typeof t !== 'string') return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/** 一行记录里的动作(没有动作 ⇒ 空)。 */
function stepsOf(d: Record<string, unknown>, source: CliSource): Step[] {
  if (source === 'claude') {
    if (d['type'] !== 'assistant') return []
    const content = (d['message'] as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((x): x is { type: string; id?: string; name?: string; input?: Record<string, unknown> } => !!x && typeof x === 'object' && (x as { type?: string }).type === 'tool_use')
      .map(x => {
        const name = x.name ?? '?', input = x.input && typeof x.input === 'object' ? x.input : {}
        const detail = claudeDetail(name, input)
        return { text: claudeStep(name, input), ...(detail ? { detail } : {}), ...(x.id ? { callId: x.id } : {}), keepOutput: CLAUDE_KEEP_OUTPUT.has(name), free: name === 'Bash' && !!claudeBashNote(input) }
      })
  }
  if (source === 'codex') {
    if (d['type'] !== 'response_item') return []
    const p = d['payload'] as Record<string, unknown> | undefined
    if (!p) return []
    const callId = str(p['call_id']) || undefined
    const withId = (steps: Step[]) => {
      // 一次调用可能拆成好几步(exec 里跑了几条命令):输出挂在最后一步上。
      const last = steps[steps.length - 1]
      if (last && callId) last.callId = callId
      return steps
    }
    if (p['type'] === 'function_call') return withId([codexFunctionStep(str(p['name']), str(p['arguments']))])
    if (p['type'] === 'local_shell_call') {
      const cmd = (p['action'] as { command?: unknown } | undefined)?.command
      return withId([{ text: runStep(Array.isArray(cmd) ? cmd.map(String).join(' ') : str(cmd)), keepOutput: true }])
    }
    if (p['type'] === 'custom_tool_call') {
      const input = str(p['input'])
      if (p['name'] === 'apply_patch') return withId(codexExecSteps(`tools.apply_patch(${JSON.stringify(input)})`))
      const steps = codexExecSteps(input)
      return withId(steps.length ? steps : [{ text: `用 ${str(p['name']) || '工具'}` }])
    }
  }
  return []
}

/** 结果正文:字符串或 [{type:text|input_text|output_text, text}]。 */
function resultText(v: unknown): string {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  return v.map(x => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n')
}
/**
 * Codex exec 的输出外面包着「Script completed / Wall time / Output:」和一段段 JSON({output, exit_code}):
 * 能解开就只留里面的 output,顺带认出非零退出。
 */
function codexOutput(raw: string): { text: string; error: boolean } {
  let error = false
  const parts: string[] = []
  const body = raw.replace(/^Script (?:completed|failed)[\s\S]*?Output:\n?/, m => { if (m.startsWith('Script failed')) error = true; return '' })
  for (const chunk of body.split('\n')) {
    const t = chunk.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const j = JSON.parse(t) as { output?: unknown; exit_code?: unknown; metadata?: { exit_code?: unknown } }
        const code = typeof j.exit_code === 'number' ? j.exit_code : typeof j.metadata?.exit_code === 'number' ? j.metadata.exit_code : 0
        if (code !== 0) error = true
        if (typeof j.output === 'string') { parts.push(j.output); continue }
        // 工具调用的结果({content:[{type:text,text}]}):只留文字
        const inner = resultText((j as { content?: unknown }).content)
        if (inner) { parts.push(inner); continue }
      } catch { /* 不是 JSON:原样留 */ }
    }
    parts.push(chunk)
  }
  return { text: parts.join('\n'), error }
}
/** 一行记录里的结果:[调用 id, 正文, 是否报错]。 */
function resultsOf(d: Record<string, unknown>, source: CliSource): Array<{ callId: string; text: string; error: boolean }> {
  if (source === 'claude') {
    if (d['type'] !== 'user') return []
    const content = (d['message'] as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((x): x is { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean } => !!x && typeof x === 'object' && (x as { type?: string }).type === 'tool_result')
      .filter(x => typeof x.tool_use_id === 'string')
      .map(x => ({ callId: x.tool_use_id!, text: resultText(x.content), error: x.is_error === true }))
  }
  if (source === 'codex' && d['type'] === 'response_item') {
    const p = d['payload'] as Record<string, unknown> | undefined
    if (!p || (p['type'] !== 'function_call_output' && p['type'] !== 'custom_tool_call_output') || typeof p['call_id'] !== 'string') return []
    const o = codexOutput(resultText(p['output']))
    return [{ callId: p['call_id'], text: o.text, error: o.error }]
  }
  return []
}

/**
 * 最近的几步,旧 → 新。文字走 parseTranscript(同一套过滤 harness / 打码),动作按行插在原位置。
 * 连续同一句动作(比如一串「读 x」)只留一条。
 */
export function parseActivity(jsonl: string, source: CliSource, max = ACTIVITY_MAX_ITEMS): CliActivityItem[] {
  const items: CliActivityItem[] = []
  const byCall = new Map<string, { item: CliActivityItem; keepOutput: boolean }>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const at = tsOf(d)
    // 文字:复用 parseTranscript 的一行口径(它会过滤 harness、打码)。
    for (const t of parseTranscript(line, source)) {
      items.push({ kind: t.role === 'user' ? 'you' : 'said', text: clip(t.text, ACTIVITY_TEXT_MAX), at })
    }
    for (const s of stepsOf(d, source)) {
      const text = clip(redactSecrets(s.text), STEP_MAX)
      const detail = s.detail ? headLines(redactSecrets(s.detail)) : undefined
      const prev = items[items.length - 1]
      // 连续同一句、都没有可看的内容 ⇒ 合并成一条(一串「读 x」)。
      let item: CliActivityItem
      if (prev && prev.kind === 'step' && prev.text === text && !prev.detail && !detail) { prev.at = at ?? prev.at; item = prev }
      else {
        const ph = s.free ? null : stepPhrase(text)
        item = { kind: 'step', text, at, ...(detail ? { detail } : {}), ...(ph ? { verb: ph.verb, target: ph.target } : {}) }
        items.push(item)
      }
      if (s.callId) byCall.set(s.callId, { item, keepOutput: s.keepOutput === true })
    }
    for (const r of resultsOf(d, source)) {
      const hit = byCall.get(r.callId)
      if (!hit) continue
      byCall.delete(r.callId)
      if (r.error) hit.item.error = true
      // diff 已经在了就不拿输出盖掉;只有值得看输出的工具(命令、搜索…)才挂输出。报错的一律挂上,好知道为什么。
      if (!hit.item.detail && (hit.keepOutput || r.error) && r.text.trim()) hit.item.detail = tailLines(redactSecrets(r.text))
    }
  }
  return items.slice(-max)
}
