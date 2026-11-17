/**
 * permission-relay(对话 · Claude 的 canUseTool)的表:每一条路给出的**确切**结果、问主人的那一下(给谁、什么话、哪个码、多久)、
 * 日志行、读了哪些依赖。2026-10-28 第四轮:原来这些只靠 authorize.parity.test.ts 那一面「与旧实现逐格相同」兜着,
 * 那一面删了,这里直接写出来(docs/maintainer/mutation-baseline-2026-10.md「第四轮」)。
 */
import { describe, expect, it } from 'vitest'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { makeCanUseTool, type PermissionRelayDeps } from './permission-relay'
import type { ChatOwnerRules } from '../../permission-rules/chat'
import type { Decision } from '../../../domain/permission-rules/types'
import type { UserTier } from '../../../domain/user-tier'
import type { Mode } from '../../../domain/conversation'

type Answer = 'allow' | 'deny' | 'timeout' | 'undelivered'
interface Setup { tier?: UserTier; mode?: Mode['kind']; admin?: string | null; answer?: Answer; permissionMode?: 'strict' | 'dangerously'; rules?: ChatOwnerRules | null; initiating?: string | null }

function gate(s: Setup = {}) {
  const asks: unknown[][] = []
  const logs: string[] = []
  const reads: string[] = []
  const deps: PermissionRelayDeps = {
    askUser: async (...a) => { asks.push(a); return s.answer ?? 'allow' },
    initiatingChatId: () => { reads.push('initiating'); return s.initiating === undefined ? 'chat-1' : s.initiating },
    adminChatId: () => { reads.push('admin'); return s.admin === undefined ? 'owner-chat' : s.admin },
    resolveTier: () => { reads.push('tier'); return s.tier ?? 'admin' },
    log: (tag, line) => logs.push(`${tag} ${line}`),
    mode: () => s.mode ?? 'solo',
    provider: 'claude',
    permissionMode: s.permissionMode ?? 'strict',
    ...(s.rules !== undefined ? { ownerRules: () => s.rules ?? null } : {}),
  }
  const fn: CanUseTool = makeCanUseTool(deps)
  const call = (tool: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    fn(tool, input, { signal: new AbortController().signal, ...opts } as never)
  return { call, asks, logs, reads }
}

const DESTRUCTIVE = { command: 'rm -rf /tmp/x' }
const UNDELIVERED = 'Could not deliver the approval request to the admin (their message window is likely closed). Tell the user this action needs the owner’s approval but the owner couldn’t be reached right now — ask them to try again shortly, or have the owner send you a message first.'
const FANOUT = 'reply tool is disabled in chatroom/parallel mode — respond with plain text, the host will relay it'

describe('扇出(/chat、/both)里的 reply 族与 message:档位之前就拒,不读档位、不问主人', () => {
  const rows: [Mode['kind'], string, 'deny' | 'allow'][] = [
    ['chatroom', 'mcp__wechat__reply', 'deny'], ['parallel', 'mcp__wechat__reply', 'deny'],
    ['chatroom', 'mcp__wechat__send_file', 'deny'], ['parallel', 'mcp__wechat__broadcast', 'deny'],
    ['chatroom', 'mcp__wechat__message', 'deny'], ['parallel', 'mcp__wechat__message', 'deny'],
    ['solo', 'mcp__wechat__reply', 'allow'], ['primary_tool', 'mcp__wechat__reply', 'allow'],
    ['parallel', 'mcp__wechat__voice', 'allow'], ['chatroom', 'mcp__other__reply', 'allow'],
  ]
  it.each(rows)('%s · %s ⇒ %s', async (mode, tool, want) => {
    const g = gate({ mode })
    const res = await g.call(tool, { text: 'hi' })
    if (want === 'deny') {
      expect(res).toEqual({ behavior: 'deny', message: FANOUT })
      expect(g.logs).toEqual([`PERMISSION deny-fanout-reply: mode=${mode} tool=${tool}`])
      expect(g.reads).toEqual([])
    } else {
      expect(res).toEqual({ behavior: 'allow' })
      expect(g.logs).toEqual([])
      expect(g.reads).toContain('tier')
    }
    expect(g.asks).toEqual([])
  })
})

describe('档位拒:确切的话与日志', () => {
  const rows: [UserTier, string, Record<string, unknown>, string][] = [
    ['guest', 'Bash', { command: 'ls' }, 'shell'],
    ['guest', 'Write', { file_path: '/tmp/a' }, 'fs_write'],
    ['guest', 'mcp__wechat__memory_delete', {}, 'memory_delete'],
  ]
  it.each(rows)('%s · %s ⇒ 拒(%s)', async (tier, tool, input, kind) => {
    const g = gate({ tier })
    expect(await g.call(tool, input)).toEqual({ behavior: 'deny', message: `Tool '${tool}' (${kind}) not available to tier '${tier}'` })
    expect(g.logs).toEqual([`PERMISSION deny: tool=${tool} kind=${kind} tier=${tier}`])
    expect(g.asks).toEqual([])
    expect(g.reads).not.toContain('admin')
  })
})

describe('档位放:直接放,不问、不写日志、不找 admin', () => {
  it.each([['admin', 'Bash', { command: 'ls' }], ['trusted', 'Read', { file_path: '/tmp/a' }], ['admin', 'mcp__wechat__memory_read', {}]] as const)('%s · %s', async (tier, tool, input) => {
    const g = gate({ tier })
    expect(await g.call(tool, input)).toEqual({ behavior: 'allow' })
    expect(g.logs).toEqual([])
    expect(g.asks).toEqual([])
    expect(g.reads).not.toContain('admin')
  })
})

describe('要问主人:给谁、什么话、哪个码、等多久', () => {
  it('没有 admin ⇒ 拒,不问', async () => {
    const g = gate({ admin: null })
    expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })).toEqual({ behavior: 'deny', message: 'no admin configured to approve permission requests' })
    expect(g.logs).toEqual(['PERMISSION relay-but-no-admin: tool=Bash kind=shell_destructive — denying'])
    expect(g.asks).toEqual([])
  })

  it('问的是 admin 那个对话(不是发起的对话),等 10 分钟', async () => {
    const g = gate({ tier: 'trusted', initiating: 'trusted-chat', admin: 'owner-chat' })
    await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })
    expect(g.asks[0]?.[2]).toMatch(/^[a-z0-9]{5}$/)
    expect(g.asks).toEqual([['owner-chat', `Claude wants to run Bash [approval:${g.asks[0]?.[2]}]\n{\n  \"command\": \"rm -rf /tmp/x\"\n}`, g.asks[0]?.[2], 600_000]])
  })

  // 保留全部 SDK ID 形状；每次请求的新码都可回复，缺 ID / 相同 ID 不得复用旧卡身份。
  const IDS = [undefined, '', 'a', 't1', 'zz', 'tool-use-1', 'toolu_01ABCDEFGHIJKLMNOP']
  it.each(IDS)('toolUseID %j ⇒ 两次请求都是不同的 5 位码', async id => {
    const g = gate()
    await g.call('Bash', DESTRUCTIVE, id === undefined ? {} : { toolUseID: id })
    await g.call('Bash', DESTRUCTIVE, id === undefined ? {} : { toolUseID: id })
    expect(g.asks).toHaveLength(2)
    for (const ask of g.asks) {
      expect(ask[2]).toMatch(/^[a-z0-9]{5}$/)
      expect(ask[1]).toContain(`[approval:${ask[2]}]`)
    }
    expect(g.asks[0]?.[2]).not.toBe(g.asks[1]?.[2])
  })

  // title 和各参数形状都保留，展示文字使用与另外两家相同的安全有界预览。
  const PROMPTS: [string, Record<string, unknown>, string | undefined, string][] = [
    ['Bash', DESTRUCTIVE, 'Run it', '{"title":"Run it"}\n{\n  "command": "rm -rf /tmp/x"\n}'],
    ['Bash', DESTRUCTIVE, undefined, '{\n  "command": "rm -rf /tmp/x"\n}'],
    ['Bash', { command: `rm -rf ${'y'.repeat(60)}`, description: 'z' }, undefined, `{\n  "command": "rm -rf ${'y'.repeat(60)}",\n  "description": "z"\n}`],
    ['mcp__wechat__memory_delete', {}, undefined, '{}'],
    ['mcp__wechat__memory_delete', { id: 7, path: 'a' }, undefined, '{\n  "id": 7,\n  "path": "a"\n}'],
    ['mcp__wechat__memory_delete', { path: { a: 1 } }, undefined, '{\n  "path": {\n    "a": 1\n  }\n}'],
  ]
  it.each(PROMPTS)('%s %j title=%j ⇒ %j', async (tool, input, title, body) => {
    const g = gate()
    await g.call(tool, input, { toolUseID: 't1', ...(title ? { title } : {}) })
    const hash = g.asks[0]?.[2]
    expect(hash).toMatch(/^[a-z0-9]{5}$/)
    expect(g.asks).toEqual([['owner-chat', `Claude wants to run ${tool} [approval:${hash}]\n${body}`, hash, 600_000]])
    expect((g.asks[0]?.[1] as string).length).toBeLessThanOrEqual(2000)
  })

  const ANSWERS: [Answer, { behavior: string; message?: string }, string[]][] = [
    ['allow', { behavior: 'allow' }, []],
    ['deny', { behavior: 'deny', message: 'User denied the request' }, ['PERMISSION deny: tool=Bash hash=002t9']],
    ['timeout', { behavior: 'deny', message: 'User did not reply in time; request denied' }, ['PERMISSION timeout: tool=Bash hash=002t9']],
    ['undelivered', { behavior: 'deny', message: UNDELIVERED }, ['PERMISSION undelivered: tool=Bash hash=002t9']],
  ]
  it.each(ANSWERS)('主人答 %s', async (answer, result, logs) => {
    const g = gate({ answer })
    expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })).toEqual(result)
    expect(g.logs).toEqual(logs.map(line => line.replace('002t9', String(g.asks[0]?.[2]))))
  })

  // 三档档案把每类工具都写满了,能力表那一行(按模式 / 权限模式取)在 Claude 这条路上看不出差别 ——
  // 这里钉的是「不管哪种模式、--dangerously 与否,毁坏性命令都照样问主人」,不是「按模式取到了哪一行」。
  it('四种对话模式 × strict/dangerously:毁坏性命令都照样问主人', async () => {
    for (const mode of ['solo', 'primary_tool', 'parallel', 'chatroom'] as const) {
      for (const permissionMode of ['strict', 'dangerously'] as const) {
        const g = gate({ mode, permissionMode })
        expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' }), `${mode}/${permissionMode}`).toEqual({ behavior: 'allow' })
        expect(g.asks, `${mode}/${permissionMode}`).toHaveLength(1)
      }
    }
  })
})

describe('主人自己的对话:放行规则', () => {
  const rules = (d: Decision, owner = true, seen: string[] = []): ChatOwnerRules => ({
    isOwnerChat: (chatId) => { seen.push(chatId); return owner },
    decide: async (_ask, beforeAllow) => { if (d.verdict === 'allow') beforeAllow?.(d); return d },
    noteAllowed: () => () => {},
  })
  it('规则放 ⇒ 放,不问,记一行 allow-by-owner-rule;是不是主人的对话按发起的那个对话判', async () => {
    const seen: string[] = []
    const g = gate({ rules: rules({ verdict: 'allow', by: 'rule', ruleId: 'r1', reason: 'ok' }, true, seen), initiating: 'my-chat' })
    expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })).toEqual({ behavior: 'allow' })
    expect(g.logs).toEqual(['PERMISSION allow-by-owner-rule: tool=Bash kind=shell_destructive'])
    expect(g.asks).toEqual([])
    expect(seen).toEqual(['my-chat'])
  })
  it('没有发起的对话 ⇒ 按空串问「是不是主人的」', async () => {
    const seen: string[] = []
    const g = gate({ rules: rules({ verdict: 'ask', by: 'default', reason: '' }, true, seen), initiating: null })
    await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })
    expect(seen).toEqual([''])
  })
  it('规则拒 ⇒ 拒,话是规则那边给的,记一行 deny-by-owner-rule', async () => {
    const g = gate({ rules: rules({ verdict: 'deny', by: 'rule', ruleId: 'r2', reason: 'no rm' }) })
    expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })).toEqual({ behavior: 'deny', message: "The owner's permission rule denied this (no rm). Do not retry it; tell the user it was blocked by their rule." })
    expect(g.logs).toEqual(['PERMISSION deny-by-owner-rule: tool=Bash kind=shell_destructive'])
    expect(g.asks).toEqual([])
  })
  it('规则没拿主意 ⇒ 照旧问主人,不记规则那两行', async () => {
    const g = gate({ rules: rules({ verdict: 'ask', by: 'default', reason: '' }) })
    expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })).toEqual({ behavior: 'allow' })
    expect(g.asks).toHaveLength(1)
    expect(g.logs).toEqual([])
  })
  it('不是主人自己的对话(信任 / 访客)⇒ 规则一次都不问,照档位走', async () => {
    for (const tier of ['trusted', 'guest'] as const) {
      let decided = 0
      const r: ChatOwnerRules = { isOwnerChat: () => false, decide: async () => { decided++; return { verdict: 'allow', by: 'rule', ruleId: 'all', reason: 'x' } }, noteAllowed: () => () => {} }
      const g = gate({ tier, rules: r })
      await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })
      await g.call('Bash', { command: 'ls' }, { toolUseID: 't2' })
      expect(decided, tier).toBe(0)
      expect(g.logs.some(l => l.includes('owner-rule')), tier).toBe(false)
    }
  })
  it('ownerRules 回 null ⇒ 不看规则', async () => {
    const g = gate({ rules: null })
    await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' })
    expect(g.asks).toHaveLength(1)
  })
})
