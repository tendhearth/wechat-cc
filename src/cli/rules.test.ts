import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRule, removeRule, setEnabled, setReview, formatRules, readRulesForEdit } from './rules'
import { RULES_FILE } from '../core/permission-rules/rules-file'

const dir = () => mkdtempSync(join(tmpdir(), 'rules-cli-'))

describe('wechat-cc rules', () => {
  it('add puts the newest rule first with the next id; the file is valid', () => {
    const d = dir()
    expect(addRule(d, { then: 'allow', tool: 'Bash', command: '^npm test$', note: '跑测试不用问' })).toEqual({ ok: true, id: 'r1' })
    expect(addRule(d, { then: 'ask', command: '\\bgit push\\b' })).toEqual({ ok: true, id: 'r2' })
    const f = readRulesForEdit(d)
    expect(f.ok && f.file.rules.map(r => r.id)).toEqual(['r2', 'r1'])
    expect(f.ok && f.file.enabled).toBe(false)
  })
  it('add refuses a pattern the parser would drop', () => {
    const d = dir()
    expect(addRule(d, { then: 'allow', command: '(a+)+$' })).toMatchObject({ ok: false })
    expect(existsSync(join(d, RULES_FILE))).toBe(false)
  })
  it('add refuses a rule with no condition at all', () => {
    expect(addRule(dir(), { then: 'allow' })).toMatchObject({ ok: false })
  })
  it('rm of a missing id fails; rm of an existing one removes it', () => {
    const d = dir()
    addRule(d, { then: 'allow', tool: 'Read' })
    expect(removeRule(d, 'r9')).toMatchObject({ ok: false })
    expect(removeRule(d, 'r1')).toEqual({ ok: true })
    const f = readRulesForEdit(d)
    expect(f.ok && f.file.rules).toEqual([])
  })
  it('a broken file is never overwritten', () => {
    const d = dir()
    writeFileSync(join(d, RULES_FILE), '{oops')
    expect(addRule(d, { then: 'allow', tool: 'Read' })).toMatchObject({ ok: false })
    expect(setEnabled(d, true)).toMatchObject({ ok: false })
    expect(readFileSync(join(d, RULES_FILE), 'utf8')).toBe('{oops')
  })
  it('enable / review toggle', () => {
    const d = dir()
    expect(setEnabled(d, true)).toEqual({ ok: true })
    expect(setReview(d, 'low_risk')).toEqual({ ok: true })
    const f = readRulesForEdit(d)
    expect(f.ok && [f.file.enabled, f.file.review]).toEqual([true, 'low_risk'])
  })
  it('list shows state, rules and errors', () => {
    const d = dir()
    writeFileSync(join(d, RULES_FILE), JSON.stringify({ version: 1, enabled: true, rules: [{ id: 'a', when: { tool: 'Read' }, then: 'allow', note: '读' }, { id: 'b', when: { command: '[' }, then: 'allow' }] }))
    const text = formatRules(d)
    expect(text).toContain('开着')
    expect(text).toContain('a · allow · tool=Read · 读')
    expect(text).toContain('b')
    expect(text).toContain('正则编不过')
  })
})
