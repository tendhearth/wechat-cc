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
    expect(g.asks).toEqual([['owner-chat', 'Claude wants to run Bash command=rm -rf /tmp/x', '002t9', 600_000]])
  })

  // 码必须正好 5 位(主人回「y xxxxx」的正则):短的补 0、长的取后 5 位;没有 toolUseID ⇒ 空串的码 00000。
  const HASHES: [string | undefined, string][] = [[undefined, '00000'], ['', '00000'], ['a', '0002p'], ['t1', '002t9'], ['zz', '0030g'], ['tool-use-1', '7mdiu'], ['toolu_01ABCDEFGHIJKLMNOP', '97lpn']]
  it.each(HASHES)('toolUseID %j ⇒ 码 %s', async (id, hash) => {
    const g = gate()
    await g.call('Bash', DESTRUCTIVE, id === undefined ? {} : { toolUseID: id })
    expect(g.asks[0]?.[2]).toBe(hash)
  })

  // 有 title 用 title;没有 ⇒「Claude wants to run <工具> <第一个参数>」,参数只取第一个键、字符串截 40、别的写类型名。
  const PROMPTS: [string, Record<string, unknown>, string | undefined, string][] = [
    ['Bash', DESTRUCTIVE, 'Run it', 'Run it'],
    ['Bash', DESTRUCTIVE, undefined, 'Claude wants to run Bash command=rm -rf /tmp/x'],
    ['Bash', { command: `rm -rf ${'y'.repeat(60)}`, description: 'z' }, undefined, `Claude wants to run Bash command=rm -rf ${'y'.repeat(33)}`],
    ['mcp__wechat__memory_delete', {}, undefined, 'Claude wants to run mcp__wechat__memory_delete '],
    ['mcp__wechat__memory_delete', { id: 7, path: 'a' }, undefined, 'Claude wants to run mcp__wechat__memory_delete id=number'],
    ['mcp__wechat__memory_delete', { path: { a: 1 } }, undefined, 'Claude wants to run mcp__wechat__memory_delete path=object'],
  ]
  it.each(PROMPTS)('%s %j title=%j ⇒ %j', async (tool, input, title, prompt) => {
    const g = gate()
    await g.call(tool, input, { toolUseID: 't1', ...(title ? { title } : {}) })
    expect(g.asks).toEqual([['owner-chat', prompt, '002t9', 600_000]])
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
    expect(g.logs).toEqual(logs)
  })

  it('能力表那一行按这一刻的对话模式取:扇出里的毁坏性命令照样问', async () => {
    for (const mode of ['solo', 'primary_tool', 'parallel', 'chatroom'] as const) {
      const g = gate({ mode })
      expect(await g.call('Bash', DESTRUCTIVE, { toolUseID: 't1' }), mode).toEqual({ behavior: 'allow' })
      expect(g.asks, mode).toHaveLength(1)
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
