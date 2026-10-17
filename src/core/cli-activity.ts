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
export interface CliActivityItem { kind: CliActivityKind; text: string; at: number | null }

/** 手机一屏看得完的量:最多这么多步,每句最多这么多字。 */
export const ACTIVITY_MAX_ITEMS = 40
export const ACTIVITY_TEXT_MAX = 600
const STEP_MAX = 120

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s)
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/** 一条命令 → 「运行 …」:只取第一行,多行的标个省略。 */
function runStep(cmd: string): string {
  // `cd 某目录 && 真正的命令`:目录主人已经知道(项目名就在标题上),只留后半截。
  const body = cmd.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
  const first = body.split('\n')[0] ?? ''
  return `运行 ${oneLine(first)}${body.includes('\n') ? ' …' : ''}`
}

/** Claude 的工具名 + 参数 → 一句人话。认不出的写「用 <名字>」。 */
export function claudeStep(name: string, input: Record<string, unknown>): string {
  const file = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  switch (name) {
    // Claude 自己给命令写的一句说明比命令本身好懂,有就用它。
    case 'Bash': return oneLine(str(input['description'])) || runStep(str(input['command']))
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

/** Codex 新格式:exec 工具的 JS 源码里抠出命令 / 补丁的文件;一段里可能有好几条,各出一步。 */
export function codexExecSteps(source: string): string[] {
  const steps: string[] = []
  // 按 `tools.xxx(` 切段(不靠括号配对:命令里常有 `$(…)`),每段到下一个 `tools.` 为止。
  const starts = [...source.matchAll(/tools\.(exec_command|apply_patch)\(/g)]
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!
    const from = m.index! + m[0].length
    const body = source.slice(from, i + 1 < starts.length ? starts[i + 1]!.index : undefined)
    if (m[1] === 'exec_command') {
      const cmd = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
      if (cmd) { try { steps.push(runStep(JSON.parse(`"${cmd[1]}"`) as string)) } catch { steps.push(runStep(cmd[1]!)) } }
    } else {
      const files = [...body.matchAll(/\*\*\* (Update|Add|Delete) File: ([^\\\n"]+)/g)]
      for (const f of files) steps.push(`${f[1] === 'Add' ? '写' : f[1] === 'Delete' ? '删' : '改'} ${baseName(f[2]!.trim())}`)
    }
  }
  return steps
}

function codexFunctionStep(name: string, args: string): string {
  let a: Record<string, unknown> = {}
  try { a = JSON.parse(args) as Record<string, unknown> } catch { /* 参数不是 JSON:只报名字 */ }
  if (name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    const c = a['command'] ?? a['cmd']
    const cmd = Array.isArray(c) ? (c[0] === 'bash' && c[1] === '-lc' ? str(c[2]) : c.map(String).join(' ')) : str(c)
    return runStep(cmd)
  }
  if (name === 'apply_patch') return codexExecSteps(`tools.apply_patch(${JSON.stringify(str(a['input']) || args)})`)[0] ?? '改文件'
  if (name === 'spawn_agent') return `派子任务:${oneLine(str(a['task_name']) || str(a['agent_type']))}`
  if (name === 'followup_task' || name === 'send_message' || name === 'wait_agent' || name === 'list_agents') return '照看子任务'
  if (name === 'update_plan') return '更新计划'
  return `用 ${name}`
}

function tsOf(d: Record<string, unknown>): number | null {
  const t = d['timestamp']
  if (typeof t !== 'string') return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/** 一行记录里的动作(没有动作 ⇒ 空)。 */
function stepsOf(d: Record<string, unknown>, source: CliSource): string[] {
  if (source === 'claude') {
    if (d['type'] !== 'assistant') return []
    const content = (d['message'] as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((x): x is { type: string; name?: string; input?: Record<string, unknown> } => !!x && typeof x === 'object' && (x as { type?: string }).type === 'tool_use')
      .map(x => claudeStep(x.name ?? '?', x.input && typeof x.input === 'object' ? x.input : {}))
  }
  if (source === 'codex') {
    if (d['type'] !== 'response_item') return []
    const p = d['payload'] as Record<string, unknown> | undefined
    if (!p) return []
    if (p['type'] === 'function_call') return [codexFunctionStep(str(p['name']), str(p['arguments']))]
    if (p['type'] === 'local_shell_call') {
      const cmd = (p['action'] as { command?: unknown } | undefined)?.command
      return [runStep(Array.isArray(cmd) ? cmd.map(String).join(' ') : str(cmd))]
    }
    if (p['type'] === 'custom_tool_call') {
      const input = str(p['input'])
      if (p['name'] === 'apply_patch') return codexExecSteps(`tools.apply_patch(${JSON.stringify(input)})`)
      const steps = codexExecSteps(input)
      return steps.length ? steps : [`用 ${str(p['name']) || '工具'}`]
    }
  }
  return []
}

/**
 * 最近的几步,旧 → 新。文字走 parseTranscript(同一套过滤 harness / 打码),动作按行插在原位置。
 * 连续同一句动作(比如一串「读 x」)只留一条。
 */
export function parseActivity(jsonl: string, source: CliSource, max = ACTIVITY_MAX_ITEMS): CliActivityItem[] {
  const items: CliActivityItem[] = []
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
      const text = clip(redactSecrets(s), STEP_MAX)
      const prev = items[items.length - 1]
      if (prev && prev.kind === 'step' && prev.text === text) { prev.at = at ?? prev.at; continue }
      items.push({ kind: 'step', text, at })
    }
  }
  return items.slice(-max)
}
