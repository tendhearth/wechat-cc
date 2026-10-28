/**
 * rules.ts — `wechat-cc rules`:直接改状态目录里的 permission-rules.json(原子写),不经 daemon;
 * daemon 按 mtime 在下一条请求时读到。坏文件一律不覆盖(主人手改了一半的东西不能被 CLI 冲掉)。
 * 新规则先过一遍同一个解析器 —— 解析器会丢的规则,这里直接拒,不写进文件。
 */
import { writeFileAtomic } from '../lib/json-file'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_RULES, parseRulesFile, RULES_FILE, serializeRulesFile } from '../adapters/permission-rules/rules-file'
import type { Rule, RuleWhen, RulesFile, Verdict } from '../domain/permission-rules/types'

type Result = { ok: true } | { ok: false; error: string }

export function readRulesForEdit(stateDir: string): { ok: true; file: RulesFile } | { ok: false; error: string } {
  const path = join(stateDir, RULES_FILE)
  if (!existsSync(path)) return { ok: true, file: { ...EMPTY_RULES, rules: [] } }
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (e) { return { ok: false, error: `读不了 ${path}:${e instanceof Error ? e.message : String(e)}` } }
  const { file, errors } = parseRulesFile(raw)
  if (errors.length) return { ok: false, error: `规则文件有错,先手动修好再用 CLI 改(${path}):\n${errors.join('\n')}` }
  return { ok: true, file }
}

function write(stateDir: string, f: RulesFile): void {
  const path = join(stateDir, RULES_FILE)
  writeFileAtomic(path, serializeRulesFile(f), { mode: 0o600 })
}

function edit(stateDir: string, fn: (f: RulesFile) => RulesFile | string): Result {
  const r = readRulesForEdit(stateDir)
  if (!r.ok) return r
  const next = fn(r.file)
  if (typeof next === 'string') return { ok: false, error: next }
  write(stateDir, next)
  return { ok: true }
}

export function addRule(stateDir: string, input: RuleWhen & { then: Verdict; note?: string }): { ok: true; id: string } | { ok: false; error: string } {
  const { then, note, ...when } = input
  const clean = Object.fromEntries(Object.entries(when).filter(([, v]) => typeof v === 'string' && v)) as RuleWhen
  if (!Object.keys(clean).length) return { ok: false, error: '规则至少要有一个条件(--tool / --command / --project / --paths / --surface / --provider)' }
  let id = ''
  const r = edit(stateDir, f => {
    const max = Math.max(0, ...f.rules.map(x => /^r(\d+)$/.exec(x.id)).map(m => (m ? Number(m[1]) : 0)))
    id = `r${max + 1}`
    const rule: Rule = { id, when: clean, then, ...(note?.trim() ? { note: note.trim() } : {}) }
    const check = parseRulesFile(JSON.stringify({ version: 1, rules: [rule] }))
    if (check.errors.length) return check.errors.join('\n')
    return { ...f, rules: [rule, ...f.rules] }
  })
  return r.ok ? { ok: true, id } : r
}

export function removeRule(stateDir: string, id: string): Result {
  return edit(stateDir, f => f.rules.some(r => r.id === id) ? { ...f, rules: f.rules.filter(r => r.id !== id) } : `没有规则 ${id}`)
}

export function setEnabled(stateDir: string, enabled: boolean): Result {
  return edit(stateDir, f => ({ ...f, enabled }))
}

export function setReview(stateDir: string, review: 'off' | 'low_risk'): Result {
  return edit(stateDir, f => ({ ...f, review }))
}

/** 人读的一览:开关、初审、每条规则、文件里的错。 */
export function formatRules(stateDir: string): string {
  const path = join(stateDir, RULES_FILE)
  if (!existsSync(path)) return `放行规则:关着(还没有 ${RULES_FILE})。\n加一条:wechat-cc rules add --then allow --tool Bash --command '^npm test$'`
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch (e) { return `读不了 ${path}:${e instanceof Error ? e.message : String(e)}` }
  const { file, errors } = parseRulesFile(raw)
  const lines = [
    `放行规则:${file.enabled ? '开着' : '关着'} · 初审:${file.review === 'low_risk' ? '开(只管低风险)' : '关'} · ${file.rules.length} 条`,
    ...file.rules.map(r => `${r.id} · ${r.then} · ${Object.entries(r.when).map(([k, v]) => `${k}=${v}`).join(' ') || '(任何请求)'}${r.note ? ` · ${r.note}` : ''}`),
  ]
  if (errors.length) lines.push('文件里的错(这些规则没生效):', ...errors.map(e => `  ${e}`))
  return lines.join('\n')
}
