import { describe, expect, it } from 'vitest'
import { authorizeChatCall, chatAsk, noticeTarget, ruleAllowLine, type ChatOwnerRules } from './chat'
import { decide } from './decide'
import { matchRule, parseRulesFile } from './rules-file'
import { TIER_PROFILES } from '../../domain/user-tier'
import type { Decision, Rule, RulesFile } from '../../domain/permission-rules/types'

const call = (input: Record<string, unknown>, tool = 'mcp__wechat__memory_delete') => ({ chatId: 'owner', provider: 'claude' as const, tool, input })

describe('chatAsk:对话没有项目根,路径只认绝对的', () => {
  it('project / cwd 恒为 null;命令照抄;绝对路径进 paths', () => {
    expect(chatAsk(call({ command: 'rm -rf dist', file_path: '/w/a.ts' }), 'darwin')).toMatchObject({ surface: 'chat', project: null, cwd: null, tier: 'admin', command: 'rm -rf dist', paths: ['/w/a.ts'], scope: 'chat:owner' })
  })
  it('有一条相对路径 ⇒ 整个 paths 不给(不知道目标在哪);空路径不算', () => {
    expect(chatAsk(call({ file_path: '/w/a.ts', path: 'b.ts' }), 'darwin').paths).toBeUndefined()
    expect(chatAsk(call({ path: '' }), 'darwin').paths).toBeUndefined()
    expect(chatAsk(call({ path: 'C:\\w\\a.ts' }), 'win32').paths).toEqual(['C:\\w\\a.ts'])
    expect(chatAsk(call({ path: 'w\\a.ts' }), 'win32').paths).toBeUndefined()
  })
})

describe('matchRule 在对话面上:按项目 / 路径限定只看目标路径,绝不因为路径空着 / 不明命中', () => {
  const rules: Rule[] = [{ id: 'p', when: { project: '/w/proj' }, then: 'allow' }]
  const at = (paths?: string[]) => ({ ...chatAsk(call({}), 'darwin'), ...(paths ? { paths } : {}) })
  it('目标都在里面 ⇒ 命中', () => expect(matchRule(rules, at(['/w/proj/a', '/w/proj/b/c']), 'darwin')?.id).toBe('p'))
  it('有一条在外面 / 兄弟目录 / 没路径 / 相对路径 ⇒ 不命中', () => {
    for (const paths of [['/w/proj/a', '/w/other'], ['/w/proj-x/a'], undefined, [], ['proj/a']]) expect(matchRule(rules, at(paths), 'darwin'), JSON.stringify(paths)).toBeNull()
  })
  it('deny 规则同样按目标路径(不命中 ⇒ 落回问,不是放)', () => {
    expect(matchRule([{ id: 'd', when: { project: '/w/proj' }, then: 'deny' }], at(), 'darwin')).toBeNull()
  })
  it('终端 / 一起做照旧按 ask.project', () => {
    expect(matchRule(rules, { ...at(), surface: 'terminal', project: '/w/proj' }, 'darwin')?.id).toBe('p')
  })
  it('when.surface 收 chat', () => {
    const { file, errors } = parseRulesFile(JSON.stringify({ version: 1, enabled: true, rules: [{ id: 'c', when: { surface: 'chat' }, then: 'deny' }, { id: 'x', when: { surface: 'phone' }, then: 'deny' }] }))
    expect(file.rules.map(r => r.id)).toEqual(['c'])
    expect(errors).toEqual([expect.stringContaining('terminal / workbench / chat')])
  })
})

describe('decide 在对话面上', () => {
  const file = (rules: Rule[]): RulesFile => ({ version: 1, enabled: true, review: 'low_risk', rules })
  const allowAll = file([{ id: 'all', when: { tool: 'mcp__wechat__memory_delete' }, then: 'allow', note: '随便删' }])
  it('allow 规则只对逐工具过闸门的三家生效(codex / cursor / agy 在对话里走不到这里,按 id 再守一道)', async () => {
    for (const provider of ['claude', 'gemini', 'openai']) expect((await decide({ ...chatAsk(call({}), 'darwin'), provider }, allowAll, {})).verdict, provider).toBe('allow')
    for (const provider of ['codex', 'cursor', 'agy']) expect((await decide({ ...chatAsk(call({}), 'darwin'), provider }, allowAll, {})).verdict, provider).toBe('ask')
  })
  it('命中的规则带上备注(提醒那一行用)', async () => {
    expect(await decide(chatAsk(call({}), 'darwin'), allowAll, {})).toMatchObject({ verdict: 'allow', by: 'rule', ruleId: 'all', note: '随便删' })
  })
  it('对话里不初审', async () => {
    let asked = 0
    const d = await decide(chatAsk(call({ command: 'git status' }, 'Bash'), 'darwin'), file([]), { review: async () => { asked++; return 'allow' } })
    expect(d).toMatchObject({ verdict: 'ask', by: 'default' })
    expect(asked).toBe(0)
  })
  it('不是 admin ⇒ 什么都不看', async () => {
    expect(await decide({ ...chatAsk(call({}), 'darwin'), tier: 'trusted' }, allowAll, {})).toMatchObject({ verdict: 'ask', by: 'default' })
  })
})

describe('提醒那一行', () => {
  it('命令原文截 40 字、单行;wechat 工具去掉前缀', () => {
    expect(noticeTarget({ tool: 'Bash', input: { command: 'rm -rf dist\n  && echo ok' } })).toBe('rm -rf dist && echo ok')
    expect(noticeTarget({ tool: 'Bash', input: { command: 'x'.repeat(60) } })).toHaveLength(40)
    expect(noticeTarget({ tool: 'mcp__wechat__daemon_restart', input: {} })).toBe('daemon_restart')
    expect(ruleAllowLine({ rule: '删记忆不用问', target: 'memory_delete' })).toBe('按规则「删记忆不用问」放行了 memory_delete')
    expect(ruleAllowLine({ rule: 'r1', target: 'x' }, 3)).toBe('按规则「r1」放行了 x(这一轮共 3 次)')
  })
})

describe('authorizeChatCall', () => {
  const subject = { tier: TIER_PROFILES.admin, permissionMode: 'strict' as const, executor: 'claude' as const }
  const destructive = { name: 'mcp__wechat__memory_delete', kind: 'memory_delete' as const }
  const rules = (d: Decision | Error, o: { owner?: boolean | Error; noted?: boolean } = {}): ChatOwnerRules & { asks: number; notes: unknown[] } => {
    const r = {
      asks: 0, notes: [] as unknown[],
      isOwnerChat: () => { if (o.owner instanceof Error) throw o.owner; return o.owner ?? true },
      decide: async () => { r.asks++; if (d instanceof Error) throw d; return d },
      noteAllowed: (_c: string, n: unknown) => { r.notes.push(n); return o.noted ?? true },
    }
    return r
  }
  const allow: Decision = { verdict: 'allow', by: 'rule', ruleId: 'r', reason: '规则放行' }
  it('isOwnerChat 抛错 ⇒ 当不是主人(不问规则)', async () => {
    const r = rules(allow, { owner: new Error('x') })
    expect(await authorizeChatCall(subject, destructive, call({}), r)).toMatchObject({ verdict: 'ask', consultOwnerRules: false })
    expect(r.asks).toBe(0)
  })
  it('规则层抛错 ⇒ 照旧问', async () => {
    expect(await authorizeChatCall(subject, destructive, call({}), rules(new Error('boom')))).toMatchObject({ verdict: 'ask', reason: 'tier' })
  })
  it('登记不上提醒 ⇒ 不放', async () => {
    expect(await authorizeChatCall(subject, destructive, call({}), rules(allow, { noted: false }))).toMatchObject({ verdict: 'ask', reason: 'tier' })
  })
  it('没备注 ⇒ 提醒里用规则 id', async () => {
    const r = rules(allow)
    expect(await authorizeChatCall(subject, destructive, call({}), r)).toMatchObject({ verdict: 'allow', reason: 'owner_rules' })
    expect(r.notes).toEqual([{ key: 'r', rule: 'r', target: 'memory_delete' }])
  })
  it('档位直接放的不问规则;没接规则 ⇒ 和以前一样', async () => {
    const r = rules(allow)
    expect(await authorizeChatCall(subject, { name: 'Bash', kind: 'shell' }, call({ command: 'ls' }, 'Bash'), r)).toMatchObject({ verdict: 'allow', reason: 'tier' })
    expect(await authorizeChatCall(subject, destructive, call({}), null)).toMatchObject({ verdict: 'ask', consultOwnerRules: false })
    expect(r.asks).toBe(0)
  })
})
