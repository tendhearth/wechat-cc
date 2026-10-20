// 放行规则(spec 2026-10-19-permission-rules-design):直接改状态目录的 permission-rules.json,不经 daemon。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { addRule, formatRules, readRulesForEdit, removeRule, setEnabled, setReview } from '../rules'
import type { Verdict } from '../../core/permission-rules/types'

const fail = (error: string): never => { console.error(error); process.exit(1) }

const listCmd = defineCommand({
  meta: { name: 'list', description: 'Show the permission rules, their state and any errors in the file' },
  args: { json: { type: 'boolean', description: 'JSON (the parsed file)' } },
  run({ args }) {
    if (!args.json) { console.log(formatRules(STATE_DIR)); return }
    const r = readRulesForEdit(STATE_DIR)
    console.log(JSON.stringify(r.ok ? { ok: true, rules: r.file } : r, null, 2))
  },
})

const addCmd = defineCommand({
  meta: { name: 'add', description: 'Add a rule at the top (newest first)' },
  args: {
    then: { type: 'string', required: true, description: 'allow | ask | deny' },
    tool: { type: 'string', description: 'Exact tool name, or mcp:<server>:*' },
    command: { type: 'string', description: 'Regex on the raw command (≤200 chars)' },
    project: { type: 'string', description: 'Project path prefix (~ ok)' },
    paths: { type: 'string', description: 'Glob every touched path must match' },
    surface: { type: 'string', description: 'terminal | workbench' },
    provider: { type: 'string', description: 'claude | codex | cursor | …' },
    note: { type: 'string', description: 'Why (the cheap-model review reads these)' },
  },
  run({ args }) {
    const then = args.then as Verdict
    if (!['allow', 'ask', 'deny'].includes(then)) fail('--then 只能是 allow / ask / deny')
    const r = addRule(STATE_DIR, {
      then,
      ...(args.tool ? { tool: args.tool } : {}), ...(args.command ? { command: args.command } : {}),
      ...(args.project ? { project: args.project } : {}), ...(args.paths ? { paths: args.paths } : {}),
      ...(args.surface ? { surface: args.surface as 'terminal' | 'workbench' } : {}), ...(args.provider ? { provider: args.provider } : {}),
      ...(args.note ? { note: args.note } : {}),
    })
    if (!r.ok) return fail(r.error)
    const now = readRulesForEdit(STATE_DIR)
    console.log(`已加规则 ${r.id}。${now.ok && !now.file.enabled ? '放行规则还关着:wechat-cc rules enable' : ''}`)
  },
})

const rmCmd = defineCommand({
  meta: { name: 'rm', description: 'Remove a rule by id' },
  args: { id: { type: 'positional', required: true, description: 'Rule id (see rules list)' } },
  run({ args }) {
    const r = removeRule(STATE_DIR, String(args.id))
    if (!r.ok) fail(r.error)
    else console.log(`已删规则 ${args.id}`)
  },
})

const toggle = (name: 'enable' | 'disable') => defineCommand({
  meta: { name, description: name === 'enable' ? 'Turn the permission rules on' : 'Turn the permission rules off (every request asks you, as before)' },
  run() {
    const r = setEnabled(STATE_DIR, name === 'enable')
    if (!r.ok) fail(r.error)
    else console.log(name === 'enable' ? '放行规则已打开。' : '放行规则已关闭:每条请求照旧问你。')
  },
})

const reviewCmd = defineCommand({
  meta: { name: 'review', description: 'Cheap-model first-pass review: off | low_risk' },
  args: { mode: { type: 'positional', required: true, description: 'off | low_risk' } },
  run({ args }) {
    const mode = String(args.mode)
    if (mode !== 'off' && mode !== 'low_risk') fail('只能是 off 或 low_risk')
    const r = setReview(STATE_DIR, mode as 'off' | 'low_risk')
    if (!r.ok) fail(r.error)
    else console.log(mode === 'low_risk' ? '初审已打开:规则没覆盖的低风险请求,先让便宜模型看一眼。' : '初审已关闭。')
  },
})

export const rulesCmd = defineCommand({
  meta: { name: 'rules', description: 'Permission rules: what CC may approve for you (terminal sessions + 一起做)' },
  subCommands: { list: listCmd, add: addCmd, rm: rmCmd, enable: toggle('enable'), disable: toggle('disable'), review: reviewCmd },
})
