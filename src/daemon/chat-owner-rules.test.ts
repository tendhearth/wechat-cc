/**
 * 主人自己的对话走放行规则(2026-10-25 主人点头)—— 真的 permission-gate(规则文件 / 红线 / 留痕)+ 真的回复交付 +
 * 三家的真闸门(Claude permission-relay、Gemini gate、openai gate),只把「主人与否」和微信发送换成假的。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../lib/db'
import { makePermissionDecisionsStore } from './permission-decisions-store'
import { makeChatOwnerRules, makePermissionGate } from './permission-gate'
import { makeReplyDeliveryRuntime } from './reply-delivery'
import { RULES_FILE } from '../core/permission-rules/rules-file'
import { makeCanUseTool } from '../core/permission-relay'
import { makeGeminiToolGate } from '../adapters/executors/gemini/gemini-agent-provider'
import { gateTool } from '../adapters/executors/openai/openai-gate'
import { TIER_PROFILES, type UserTier } from '../domain/user-tier'
import type { Rule } from '../domain/permission-rules/types'

const ADMIN = 'owner@im.wechat', TRUSTED = 'friend@im.wechat', GUEST = 'guest@im.wechat'
const TIER: Record<string, UserTier> = { [ADMIN]: 'admin', [TRUSTED]: 'trusted', [GUEST]: 'guest' }

function setup(rules: Rule[]) {
  const stateDir = mkdtempSync(join(tmpdir(), 'chat-rules-'))
  writeFileSync(join(stateDir, RULES_FILE), JSON.stringify({ version: 1, enabled: true, review: 'low_risk', rules }))
  const store = makePermissionDecisionsStore(openTestDb())
  const cheap = vi.fn(async () => 'allow')
  const gate = makePermissionGate({ stateDir, store, cheapEval: () => cheap, notifyOwner: () => {}, log: () => {} })
  const sent: { chatId: string; text: string }[] = []
  const reply = makeReplyDeliveryRuntime({ sendText: async (chatId, text) => { sent.push({ chatId, text }); return { msgId: `m${sent.length}` } }, sleep: async () => {}, log: () => {} })
  const rules$ = makeChatOwnerRules({ gate, replyDelivery: reply, isOwnerChat: (c) => TIER[c] === 'admin' })
  const askUser = vi.fn(async () => 'deny' as const)
  const claude = (chatId: string) => makeCanUseTool({
    askUser, initiatingChatId: () => chatId, adminChatId: () => ADMIN, resolveTier: () => TIER[chatId] ?? 'guest',
    log: () => {}, mode: () => 'solo', provider: 'claude', permissionMode: 'strict', ownerRules: () => rules$,
  })
  const call = (chatId: string, tool: string, input: Record<string, unknown> = {}) => claude(chatId)(tool, input, { signal: new AbortController().signal, toolUseID: 't1' } as never)
  return { stateDir, store, cheap, gate, reply, sent, rules: rules$, askUser, call }
}

const memoryDelete: Rule = { id: 'mem', when: { tool: 'mcp__wechat__memory_delete' }, then: 'allow', note: '删记忆不用问' }

describe('对话走放行规则:只在主人自己的对话里', () => {
  it('主人的对话 + allow 规则 ⇒ 放行,这一轮的回复最后带一行「按规则「…」放行了 …」(同一条规则一轮一行)', async () => {
    const t = setup([memoryDelete])
    const turn = t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
    expect(await t.call(ADMIN, 'mcp__wechat__memory_delete', { id: 'a' })).toEqual({ behavior: 'allow' })
    expect(await t.call(ADMIN, 'mcp__wechat__memory_delete', { id: 'b' })).toEqual({ behavior: 'allow' })
    expect(t.askUser).not.toHaveBeenCalled()
    await turn.deliver({ finalText: '删好了。', narration: [] })
    expect(t.sent.map(s => s.text)).toEqual(['删好了。', '按规则「删记忆不用问」放行了 memory_delete(这一轮共 2 次)'])
    // 留痕:surface = chat(v85 放开了 CHECK)
    expect(t.store.since(0)).toEqual(expect.arrayContaining([expect.objectContaining({ surface: 'chat', provider: 'claude', ruleId: 'mem', verdict: 'allow', by: 'rule', scope: `chat:${ADMIN}` })]))
  })

  it('同一条规则访客 / 信任的对话里不起作用:访客照旧拒,信任照旧问主人,规则文件一次都不读', async () => {
    const t = setup([memoryDelete])
    const decide = vi.spyOn(t.gate, 'decide')
    t.reply.begin(GUEST, { context: 'dm', providerId: 'claude' })
    t.reply.begin(TRUSTED, { context: 'dm', providerId: 'claude' })
    expect(await t.call(GUEST, 'mcp__wechat__memory_delete', {})).toMatchObject({ behavior: 'deny', message: expect.stringContaining("not available to tier 'guest'") })
    expect(await t.call(TRUSTED, 'mcp__wechat__memory_delete', {})).toMatchObject({ behavior: 'deny', message: 'User denied the request' })
    expect(t.askUser).toHaveBeenCalledTimes(1)
    expect(decide).not.toHaveBeenCalled()
    expect(t.store.since(0)).toEqual([])
  })

  it('红线目标照旧问主人:allow 规则盖不过红线(破坏性命令)', async () => {
    const t = setup([{ id: 'rm', when: { command: '^rm ' }, then: 'allow', note: '清构建产物' }])
    t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
    expect(await t.call(ADMIN, 'Bash', { command: 'rm -rf /tmp/proj/dist' })).toMatchObject({ behavior: 'deny', message: 'User denied the request' })
    expect(t.askUser).toHaveBeenCalledTimes(1)
  })

  it('主人的对话 + deny 规则 ⇒ 拒,理由交给执行者;不问主人、不带放行提醒', async () => {
    const t = setup([{ id: 'no-mem', when: { tool: 'mcp__wechat__memory_delete' }, then: 'deny', note: '记忆别删' }])
    const turn = t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
    const r = await t.call(ADMIN, 'mcp__wechat__memory_delete', {})
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('记忆别删') })
    expect(t.askUser).not.toHaveBeenCalled()
    await turn.deliver({ finalText: '没删。', narration: [] })
    expect(t.sent.map(s => s.text)).toEqual(['没删。'])
  })

  it('没有开着的一轮(提醒送不到)⇒ 不放,照旧问主人', async () => {
    const t = setup([memoryDelete])
    expect(await t.call(ADMIN, 'mcp__wechat__memory_delete', {})).toMatchObject({ behavior: 'deny', message: 'User denied the request' })
    expect(t.askUser).toHaveBeenCalledTimes(1)
  })

  it('对话里不初审:规则没命中、初审开着也不问便宜模型', async () => {
    const t = setup([])
    t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
    await t.call(ADMIN, 'mcp__wechat__memory_delete', {})
    expect(t.cheap).not.toHaveBeenCalled()
    expect(t.askUser).toHaveBeenCalledTimes(1)
  })

  it('这一轮出错没交付:提醒照样单独送到', async () => {
    const t = setup([memoryDelete])
    const turn = t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
    await t.call(ADMIN, 'mcp__wechat__memory_delete', {})
    turn.abandon('error')
    await vi.waitFor(() => expect(t.sent.map(s => s.text)).toEqual(['按规则「删记忆不用问」放行了 memory_delete']))
  })
})

describe('按项目 / 路径限定的规则:只看工具真正的目标路径', () => {
  // 一个不碰红线、档位要问的 MCP 工具上挂路径(主人对话里 Edit / Write 按档位直接放,走不到规则)。
  const scoped = (when: Rule['when']): Rule => ({ id: 'scoped', when: { tool: 'mcp__wechat__memory_delete', ...when }, then: 'allow', note: '项目里的随便删' })
  for (const [label, when] of [['project', { project: '/work/proj' }], ['paths', { paths: '/work/proj/**' }]] as const) {
    it(`${label}:目标在范围里 ⇒ 放;在范围外 / 相对路径 / 没路径 ⇒ 不命中,照旧问`, async () => {
      const t = setup([scoped(when)])
      t.reply.begin(ADMIN, { context: 'dm', providerId: 'claude' })
      expect(await t.call(ADMIN, 'mcp__wechat__memory_delete', { path: '/work/proj/notes/a.md' })).toEqual({ behavior: 'allow' })
      for (const input of [{ path: '/work/other/a.md' }, { path: '/work/proj-evil/a.md' }, { path: 'notes/a.md' }, { path: '../proj/a.md' }, {}, { path: '' }]) {
        t.askUser.mockClear()
        expect(await t.call(ADMIN, 'mcp__wechat__memory_delete', input), JSON.stringify(input)).toMatchObject({ behavior: 'deny', message: 'User denied the request' })
        expect(t.askUser, JSON.stringify(input)).toHaveBeenCalledTimes(1)
      }
    })
  }
})

describe('Gemini / OpenAI 兼容:同一份规则', () => {
  it('Gemini 主人对话:规则按 mcp__wechat__<名> 匹配,放了带提醒;访客照旧', async () => {
    const t = setup([memoryDelete])
    const build = makeGeminiToolGate({ askUser: t.askUser, adminFor: () => ADMIN, modeFor: () => 'solo', lookupBase: () => ({ askUser: 'per-tool' }), ownerRules: () => t.rules })
    const turn = t.reply.begin(ADMIN, { context: 'dm', providerId: 'gemini' })
    expect(await build({ chatId: ADMIN, tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' } as never)('memory_delete', {})).toEqual({ allow: true })
    expect(await build({ chatId: GUEST, tierProfile: TIER_PROFILES.guest, permissionMode: 'strict' } as never)('memory_delete', {})).toMatchObject({ allow: false })
    expect(t.askUser).not.toHaveBeenCalled()
    await turn.deliver({ finalText: '好了', narration: [] })
    expect(t.sent.map(s => s.text)).toEqual(['好了', '按规则「删记忆不用问」放行了 memory_delete'])
  })

  it('OpenAI 兼容(问不了):主人对话里规则放 ⇒ 放;deny 规则 ⇒ 拒并带理由;没规则 / 访客 ⇒ 照旧拒', async () => {
    const t = setup([memoryDelete, { id: 'no-restart', when: { tool: 'mcp__wechat__daemon_restart' }, then: 'deny', note: '别重启' }])
    t.reply.begin(ADMIN, { context: 'dm', providerId: 'openai' })
    const g = (chatId: string, toolName: string, tier: UserTier) => gateTool({ toolName, mcpServer: 'wechat', input: {}, tierProfile: TIER_PROFILES[tier], permissionMode: 'strict', chatId, ownerRules: t.rules })
    expect(await g(ADMIN, 'memory_delete', 'admin')).toEqual({ decision: 'allow' })
    expect(await g(ADMIN, 'daemon_restart', 'admin')).toMatchObject({ decision: 'deny', message: expect.stringContaining('别重启') })
    expect(await g(ADMIN, 'session_release', 'admin')).toEqual({ decision: 'deny' })
    expect(await g(TRUSTED, 'memory_delete', 'trusted')).toEqual({ decision: 'deny' })
  })
})
