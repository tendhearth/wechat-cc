import { describe, expect, it } from 'vitest'
import { claudeEquivalentUses, makeCodexChatGate, type CodexChatGateDeps } from './codex-chat-gate'
import { makeCanUseTool } from '../claude/permission-relay'
import { decide } from '../../permission-rules/decide'
import type { ChatOwnerRules, RuleAllowNotice } from '../../permission-rules/chat'
import { TIER_PROFILES, type UserTier } from '../../../domain/user-tier'
import { enforcementFor } from '../../../domain/enforcement-matrix'
import type { Decision, PermissionAsk, Rule } from '../../../domain/permission-rules/types'
import type { SpawnContext } from '../../../ports/agent-provider'

// 「Codex 对话逐条问」(主人 2026-10-26):codex app-server 报上来要批的那一条 → authorize → 规则 / 拍板卡。
// 规则层用真的 decide(规则匹配 + 红线),只把留痕 / 读文件那一圈换成内存里的一份。

const rulesWith = (rules: Rule[], owner = true): ChatOwnerRules & { notes: RuleAllowNotice[]; asked: PermissionAsk[] } => {
  const r = {
    notes: [] as RuleAllowNotice[], asked: [] as PermissionAsk[],
    isOwnerChat: () => owner,
    decide: async (ask: () => PermissionAsk, beforeAllow?: (d: Decision) => (() => void) | null): Promise<Decision> => {
      const a = ask(); r.asked.push(a)
      const d = await decide(a, { version: 1, enabled: true, review: 'off', rules }, {})
      if (d.verdict === 'allow' && beforeAllow && !beforeAllow(d)) return { verdict: 'ask', by: 'default', reason: 'x' }
      return d
    },
    noteAllowed: (_chatId: string, n: RuleAllowNotice) => { r.notes.push(n); return () => {} },
  }
  return r
}

function rig(o: { answer?: 'allow' | 'deny' | 'timeout' | 'undelivered'; rules?: ChatOwnerRules | null; admin?: string | null; tier?: UserTier } = {}) {
  const cards: Array<{ to: string; prompt: string; hash: string; timeoutMs: number }> = []
  const lines: string[] = []
  const deps: CodexChatGateDeps = {
    askUser: async (to, prompt, hash, timeoutMs) => { cards.push({ to, prompt, hash, timeoutMs }); return o.answer ?? 'deny' },
    adminFor: () => (o.admin === undefined ? 'owner' : o.admin),
    ...(o.rules ? { ownerRules: () => o.rules! } : {}),
    log: (t, l) => lines.push(`${t} ${l}`),
  }
  const ctx = { chatId: 'owner', tierProfile: TIER_PROFILES[o.tier ?? 'admin'], permissionMode: 'strict' } as SpawnContext
  return { approve: makeCodexChatGate(deps)(ctx), cards, lines }
}
const signal = () => new AbortController().signal
const cmd = (command: string) => ({ tool: 'commandExecution', description: command, command })
const mcp = (tool: string, input: Record<string, unknown> = {}) => ({ tool: `mcp__wechat__${tool}`, description: tool, input })

describe('Codex 对话审批 → authorize', () => {
  it('命令:codex 报上来要批的 ⇒ 问主人(拍板卡,10 分钟),主人点了才放', async () => {
    const yes = rig({ answer: 'allow' })
    expect(await yes.approve(cmd('rm -rf build'), signal())).toBe(true)
    expect(yes.cards).toHaveLength(1)
    expect(yes.cards[0]).toMatchObject({ to: 'owner', timeoutMs: 10 * 60_000 })
    expect(yes.cards[0]!.prompt).toContain('Codex 想执行命令')
    expect(yes.cards[0]!.prompt).toContain('rm -rf build')
    expect(yes.cards[0]!.hash).toMatch(/^[a-z0-9]{5}$/)
    for (const answer of ['deny', 'timeout', 'undelivered'] as const) expect(await rig({ answer }).approve(cmd('ls'), signal()), answer).toBe(false)
  })

  it('放行规则替主人放(登记那一行提醒),不弹卡;规则拒 ⇒ 拒,不弹卡', async () => {
    const rules = rulesWith([{ id: 'r1', when: { command: '^ls$' }, then: 'allow', note: '列目录不用问' }, { id: 'r2', when: { command: '^curl ' }, then: 'deny' }])
    const r = rig({ rules })
    expect(await r.approve(cmd('ls'), signal())).toBe(true)
    expect(rules.notes).toEqual([{ key: 'r1', rule: '列目录不用问', target: 'ls' }])
    expect(rules.asked[0]).toMatchObject({ surface: 'chat', provider: 'codex', tool: 'commandExecution', command: 'ls', tier: 'admin' })
    expect(await r.approve(cmd('curl http://localhost'), signal())).toBe(false)
    expect(r.cards).toHaveLength(0)
  })

  it('红线照旧问:规则说放也不放,问主人', async () => {
    const rules = rulesWith([{ id: 'all', when: { command: '.*' }, then: 'allow' }])
    const r = rig({ rules, answer: 'deny' })
    expect(await r.approve(cmd('git push origin main'), signal())).toBe(false)
    expect(rules.notes).toEqual([])
    expect(r.cards).toHaveLength(1)
  })

  it('不是主人自己的对话 ⇒ 不看规则', async () => {
    const rules = rulesWith([{ id: 'all', when: { command: '.*' }, then: 'allow' }], false)
    const r = rig({ rules, answer: 'deny' })
    expect(await r.approve(cmd('ls'), signal())).toBe(false)
    expect(rules.asked).toHaveLength(0)
    expect(r.cards).toHaveLength(1)
  })

  it('改文件:和 Claude 对话里同一次写得到同一个结论(admin 档写文件直接放,不弹卡、不问规则);一次改几个文件逐个判', async () => {
    const rules = rulesWith([])
    const r = rig({ rules, answer: 'deny' })
    expect(await r.approve({ tool: 'fileChange', description: 'diff', paths: ['/w/proj/a.ts', '/tmp/outside.txt'] }, signal())).toBe(true)
    expect(await r.approve({ tool: 'fileChange', description: 'diff' }, signal())).toBe(true)
    expect(r.cards).toHaveLength(0)
    expect(rules.asked).toHaveLength(0)
    expect(claudeEquivalentUses({ tool: 'fileChange', description: '', paths: ['/a', '/b'] })).toEqual([{ tool: 'Edit', input: { file_path: '/a' } }, { tool: 'Edit', input: { file_path: '/b' } }])
    // Claude 的 canUseTool 对同一次写:同样直接放。
    const claude = makeCanUseTool({ askUser: async () => 'deny', initiatingChatId: () => 'owner', adminChatId: () => 'owner', resolveTier: () => 'admin', log: () => {}, mode: () => 'solo', provider: 'claude', permissionMode: 'strict', ownerRules: () => rules })
    expect((await claude('Edit', { file_path: '/tmp/outside.txt' }, { signal: signal() } as never)).behavior).toBe('allow')
    // 档位不许写(访客)⇒ 拒。
    expect(await rig({ tier: 'guest', answer: 'allow' }).approve({ tool: 'fileChange', description: 'd', paths: ['/w/a'] }, signal())).toBe(false)
  })

  it('MCP 调用按档位:admin 放的直接放、要问的(删记忆)问;trusted 碰 admin 专用工具 ⇒ 拒', async () => {
    const r = rig({ answer: 'deny' })
    expect(await r.approve(mcp('model_get'), signal())).toBe(true)
    expect(r.cards).toHaveLength(0)
    expect(await r.approve(mcp('memory_delete', { path: 'x.md' }), signal())).toBe(false)
    expect(r.cards).toHaveLength(1)
    expect(await rig({ tier: 'trusted', answer: 'allow' }).approve(mcp('model_get'), signal())).toBe(false)
    // 和推出来的快照格子对得上(enforcement-matrix 走的也是 authorize)。
    expect(enforcementFor('codex', 'admin', 'daemon_introspect')).toBe('allow')
    expect(enforcementFor('codex', 'admin', 'memory_delete')).toBe('ask')
    expect(enforcementFor('codex', 'admin', 'shell_destructive')).toBe('ask')
  })

  it('没有可问的人 ⇒ 拒;这一轮停了 ⇒ 不问、迟到的「同意」也不算', async () => {
    expect(await rig({ admin: null, answer: 'allow' }).approve(cmd('ls'), signal())).toBe(false)
    const stopped = new AbortController(); stopped.abort()
    const r = rig({ answer: 'allow' })
    expect(await r.approve(cmd('ls'), stopped.signal)).toBe(false)
    expect(r.cards).toHaveLength(0)
    const late = new AbortController()
    const slow = makeCodexChatGate({ askUser: async () => { late.abort(); return 'allow' }, adminFor: () => 'owner', log: () => {} })({ chatId: 'owner', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' } as SpawnContext)
    expect(await slow(cmd('ls'), late.signal)).toBe(false)
  })
})
