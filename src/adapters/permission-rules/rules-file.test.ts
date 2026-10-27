import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { parseRulesFile, matchRule, serializeRulesFile, EMPTY_RULES, STARTER_RULES, STARTER_VERSION, withStarterRules } from './rules-file'
import type { PermissionAsk, Rule } from '../../domain/permission-rules/types'

const ask = (over: Partial<PermissionAsk> = {}): PermissionAsk => ({
  surface: 'terminal', provider: 'claude', tool: 'Bash', command: 'npm test', cwd: '/p', project: '/p',
  isolatedWorktree: false, tier: 'admin', scope: 's1', ...over,
})
const rule = (over: Partial<Rule>): Rule => ({ id: 'r', when: {}, then: 'allow', ...over })

describe('parseRulesFile', () => {
  it('broken JSON ⇒ empty, disabled, one error', () => {
    const r = parseRulesFile('not json')
    expect(r.file).toEqual(EMPTY_RULES)
    expect(r.errors.length).toBe(1)
  })
  it('missing enabled / review ⇒ false / off', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [] }))
    expect(r.file.enabled).toBe(false)
    expect(r.file.review).toBe('off')
    expect(r.errors).toEqual([])
  })
  it('drops an over-long pattern and keeps the rest', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, enabled: true, rules: [
      { id: 'ok', when: { command: '^(npm|bun) test\\b' }, then: 'allow' },
      { id: 'long', when: { command: 'a'.repeat(201) }, then: 'allow' },
    ] }))
    expect(r.file.rules.map(x => x.id)).toEqual(['ok'])
    expect(r.errors.join('\n')).toContain('long')
  })
  it('drops nested quantifiers (catastrophic backtracking) and the pathological input stays fast', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [
      { id: 'n1', when: { command: '(a+)+$' }, then: 'allow' },
      { id: 'n2', when: { command: '(x*y?)*z' }, then: 'allow' },
      { id: 'n3', when: { command: '(?:a|b+){2,}' }, then: 'allow' },
      { id: 'fine', when: { command: '^(ls|cat)( -la)?$' }, then: 'allow' },
    ] }))
    expect(r.file.rules.map(x => x.id)).toEqual(['fine'])
    expect(r.errors.length).toBe(3)
  })
  it('drops a pattern that does not compile', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [
      { id: 'bad', when: { command: '[' }, then: 'allow' },
      { id: 'good', when: { tool: 'Read' }, then: 'allow' },
    ] }))
    expect(r.file.rules.map(x => x.id)).toEqual(['good'])
    expect(r.errors.join('\n')).toContain('bad')
  })
  it('drops a rule whose then is not allow/ask/deny', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [{ id: 'x', when: {}, then: 'maybe' }] }))
    expect(r.file.rules).toEqual([])
    expect(r.errors.length).toBe(1)
  })
  it('gives missing ids r<n>', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [{ when: {}, then: 'ask' }, { when: {}, then: 'ask' }] }))
    expect(r.file.rules.map(x => x.id)).toEqual(['r1', 'r2'])
  })
  it('round-trips through serialize', () => {
    const f = { ...EMPTY_RULES, enabled: true, rules: [rule({ id: 'a', when: { tool: 'Read' } })] }
    const s = serializeRulesFile(f)
    expect(s.endsWith('\n')).toBe(true)
    expect(parseRulesFile(s).file).toEqual(f)
  })
})

describe('matchRule', () => {
  it('a deny anywhere beats an earlier allow', () => {
    const rules = [rule({ id: 'r1', when: { tool: 'Bash' }, then: 'allow' }), rule({ id: 'r2', when: { command: 'npm' }, then: 'deny' })]
    expect(matchRule(rules, ask())?.id).toBe('r2')
  })
  it('otherwise first match in order', () => {
    const rules = [rule({ id: 'r1', when: { tool: 'Read' } }), rule({ id: 'r2', when: { tool: 'Bash' }, then: 'ask' }), rule({ id: 'r3', when: { tool: 'Bash' } })]
    expect(matchRule(rules, ask())?.id).toBe('r2')
  })
  it('mcp tool wildcard', () => {
    const rules = [rule({ when: { tool: 'mcp:github:*' } })]
    expect(matchRule(rules, ask({ tool: 'mcp:github:create_issue' }))).not.toBeNull()
    expect(matchRule(rules, ask({ tool: 'mcp:githubx:a' }))).toBeNull()
  })
  it('project is a path prefix on separator boundaries, ~ expands', () => {
    const rules = [rule({ when: { project: '/a/b' } })]
    expect(matchRule(rules, ask({ project: '/a/b/c' }))).not.toBeNull()
    expect(matchRule(rules, ask({ project: '/a/b' }))).not.toBeNull()
    expect(matchRule(rules, ask({ project: '/a/bc' }))).toBeNull()
    expect(matchRule(rules, ask({ project: null }))).toBeNull()
    expect(matchRule([rule({ when: { project: '~/x' } })], ask({ project: `${homedir()}/x/y` }))).not.toBeNull()
  })
  it('a command rule never matches a request without a command', () => {
    expect(matchRule([rule({ when: { command: '.*' } })], ask({ command: undefined }))).toBeNull()
  })
  it('paths glob must cover every path', () => {
    const rules = [rule({ when: { paths: '/p/src/**' } })]
    expect(matchRule(rules, ask({ tool: 'Edit', paths: ['/p/src/a.ts', '/p/README.md'] }), 'darwin')).toBeNull()
    expect(matchRule(rules, ask({ tool: 'Edit', paths: ['/p/src/a.ts', '/p/src/deep/b.ts'] }), 'darwin')).not.toBeNull()
    expect(matchRule(rules, ask({ tool: 'Edit', paths: undefined }), 'darwin')).toBeNull()
    expect(matchRule(rules, ask({ tool: 'Edit', paths: [] }), 'darwin')).toBeNull()
  })
  it('single * stays inside one segment', () => {
    const rules = [rule({ when: { paths: '/p/*.ts' } })]
    expect(matchRule(rules, ask({ paths: ['/p/a.ts'] }), 'darwin')).not.toBeNull()
    expect(matchRule(rules, ask({ paths: ['/p/d/a.ts'] }), 'darwin')).toBeNull()
  })
  it('command is matched on its first 2000 chars only', () => {
    const rules = [rule({ when: { command: 'TAIL' } })]
    expect(matchRule(rules, ask({ command: 'x'.repeat(2000) + 'TAIL' }))).toBeNull()
  })
  it('surface and provider are exact', () => {
    const rules = [rule({ when: { surface: 'workbench', provider: 'codex' } })]
    expect(matchRule(rules, ask())).toBeNull()
    expect(matchRule(rules, ask({ surface: 'workbench', provider: 'codex' }))).not.toBeNull()
  })
  // 上一条两个限定一起写、ask 两样都不对 ⇒ 任何一道判断单独失效都还有另一道兜着(2026-10 变异基线:
  // 两行各自换成 false 都不红)。这里一次只限定一样、另一样照样对上,逐个面 / 执行者核对。
  it('一条只限定 surface 的放行规则:只在那个面生效,别的面一律不命中', () => {
    const terminalOnly = [rule({ id: 't', when: { surface: 'terminal', tool: 'Bash' } })]
    const table: Array<[PermissionAsk['surface'], boolean]> = [['terminal', true], ['workbench', false], ['chat', false]]
    for (const [surface, hit] of table) {
      expect(matchRule(terminalOnly, ask({ surface }))?.id ?? null, surface).toBe(hit ? 't' : null)
    }
    const workbenchOnly = [rule({ id: 'w', when: { surface: 'workbench' } })]
    expect(matchRule(workbenchOnly, ask({ surface: 'workbench' }))?.id).toBe('w')
    expect(matchRule(workbenchOnly, ask({ surface: 'terminal' }))).toBeNull()
    expect(matchRule(workbenchOnly, ask({ surface: 'chat' }))).toBeNull()
  })
  it('一条只限定 provider 的放行规则:换个执行者就不命中', () => {
    const claudeOnly = [rule({ id: 'c', when: { provider: 'claude', tool: 'Bash' } })]
    const table: Array<[string, boolean]> = [['claude', true], ['codex', false], ['cursor', false], ['openai', false]]
    for (const [provider, hit] of table) {
      for (const surface of ['terminal', 'workbench', 'chat'] as const) {
        expect(matchRule(claudeOnly, ask({ provider, surface }))?.id ?? null, `${provider}@${surface}`).toBe(hit ? 'c' : null)
      }
    }
  })
  it('对话里按路径限定的规则:路径里有一条不是绝对路径 ⇒ 不知道碰哪 ⇒ 不命中', () => {
    // `/**` 什么绝对路径都对得上:相对路径归一时会按 cwd 解析成绝对路径,只有「对话里先看是不是绝对路径」这一道拦得住。
    const rules = [rule({ id: 'p', when: { paths: '/**' } })]
    expect(matchRule(rules, ask({ surface: 'chat', tool: 'Read', paths: ['/p/a.ts'] }), 'darwin')?.id).toBe('p')
    expect(matchRule(rules, ask({ surface: 'chat', tool: 'Read', paths: ['/p/a.ts', 'a.ts'] }), 'darwin')).toBeNull()
    expect(matchRule(rules, ask({ surface: 'terminal', tool: 'Read', paths: ['/p/a.ts', 'a.ts'] }), 'darwin')?.id).toBe('p')
  })
})

describe('rules-file × 终审', () => {
  it('rejects every pattern shape that can blow up, keeps simple ones', () => {
    const r = parseRulesFile(JSON.stringify({ version: 1, rules: [
      { id: 'a', when: { command: '((a+))+$' }, then: 'allow' },
      { id: 'b', when: { command: '(a|a)+$' }, then: 'allow' },
      { id: 'c', when: { command: '(?:a|aa)+$' }, then: 'allow' },
      { id: 'd', when: { command: '\\w*\\w*$' }, then: 'allow' },
      { id: 'e', when: { command: '(a?){25}a{25}' }, then: 'allow' },
      { id: 'f', when: { command: 'a?a?a?a?a?a?' }, then: 'allow' },
      { id: 'ok1', when: { command: '^(npm|bun) (test|run build)$' }, then: 'allow' },
      { id: 'ok2', when: { command: '^git (status|diff)\\b.*' }, then: 'allow' },
    ] }))
    expect(r.file.rules.map(x => x.id)).toEqual(['ok1', 'ok2'])
  })
  it('paths are normalised before the glob', () => {
    const rules = [rule({ when: { paths: '/p/docs/**' } })]
    expect(matchRule(rules, ask({ paths: ['/p/docs/../src/main.ts'] }), 'darwin')).toBeNull()
    expect(matchRule(rules, ask({ paths: ['/p/docs/./a.md'] }), 'darwin')).not.toBeNull()
  })
  it('any tool pattern ending in * is a prefix (Claude mcp__server__*)', () => {
    const rules = [rule({ when: { tool: 'mcp__github__*' } })]
    expect(matchRule(rules, ask({ tool: 'mcp__github__create_issue' }))).not.toBeNull()
    expect(matchRule(rules, ask({ tool: 'mcp__gitlab__x' }))).toBeNull()
  })
})

describe('withStarterRules(放行 v2 G1)', () => {
  it('文件不在 / 从没装过的全空默认值 ⇒ 开起来、初审 low_risk、起步规则、记下版本', () => {
    for (const cur of [null, { ...EMPTY_RULES, rules: [] }]) {
      expect(withStarterRules(cur)).toEqual({ version: 1, enabled: true, review: 'low_risk', rules: [...STARTER_RULES], starter: STARTER_VERSION })
    }
  })
  it('装过一次(哪怕主人后来关了、删光了)/ 主人改过任何一处 ⇒ 不动', () => {
    expect(withStarterRules({ ...EMPTY_RULES, rules: [], starter: 1 })).toBeNull()
    expect(withStarterRules({ ...EMPTY_RULES, rules: [], enabled: true })).toBeNull()
    expect(withStarterRules({ ...EMPTY_RULES, rules: [], review: 'low_risk' })).toBeNull()
    expect(withStarterRules({ ...EMPTY_RULES, rules: [{ id: 'r1', when: { tool: 'Edit' }, then: 'ask' }] })).toBeNull()
  })
  it('starter 读得回来、写得出去;乱填的丢掉', () => {
    const f = withStarterRules(null)!
    expect(parseRulesFile(serializeRulesFile(f))).toEqual({ file: f, errors: [] })
    expect(parseRulesFile(JSON.stringify({ version: 1, enabled: false, rules: [], starter: 'x' })).file.starter).toBeUndefined()
  })
  it('起步规则自己过得了解析器(正则安全子集)', () => {
    expect(parseRulesFile(JSON.stringify({ version: 1, rules: STARTER_RULES })).errors).toEqual([])
  })
})
