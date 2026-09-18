import { describe, expect, it } from 'vitest'
import { acpActivityId, acpPermissionDescription, acpPermissionOption, createAcpTranslator } from './events'

const chunk = (text: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) })
const call = (extra: Record<string, unknown> = {}) => ({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Edit File', kind: 'edit', status: 'pending', rawInput: { path: 'secret.txt', content: 'SECRET' }, locations: [{ path: '/p/a.ts' }], ...extra })

describe('ACP session/update → AgentEvent', () => {
  it('synthesizes an itemId per assistant message when messageId is absent and rolls it over across tool calls', () => {
    const t = createAcpTranslator(); t.beginTurn()
    expect(t.update(chunk('这'))).toEqual([{ kind: 'text', text: '这', itemId: 'acp:turn:1:0', textMode: 'append' }])
    expect(t.update(chunk('边'))).toEqual([{ kind: 'text', text: '边', itemId: 'acp:turn:1:0', textMode: 'append' }])
    t.update(call())
    expect(t.update(chunk('好'))[0]).toMatchObject({ itemId: 'acp:turn:1:1' })
    t.beginTurn()
    expect(t.update(chunk('新'))[0]).toMatchObject({ itemId: 'acp:turn:2:0' })
  })
  it('uses messageId when present and ignores non-text and thought chunks', () => {
    const t = createAcpTranslator(); t.beginTurn()
    expect(t.update(chunk('a', 'm-9'))[0]).toMatchObject({ itemId: 'acp:msg:m-9' })
    expect(t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } })).toEqual([])
    expect(t.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } })).toEqual([])
    for (const kind of ['user_message_chunk', 'plan', 'available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update']) expect(t.update({ sessionUpdate: kind })).toEqual([])
  })
  it('maps tool_call kinds to public activities without copying raw input or output', () => {
    const t = createAcpTranslator(); t.beginTurn()
    const [ev] = t.update(call())
    expect(ev).toEqual({ kind: 'tool_call', tool: 'edit', activity: { id: 'call-1', type: 'edit', status: 'running', label: '修改文件', detail: '/p/a.ts' } })
    expect(JSON.stringify(ev)).not.toContain('SECRET')
    const cases: Array<[string, string, string]> = [['read', 'read', '读取文件'], ['delete', 'edit', '删除文件'], ['move', 'edit', '移动文件'], ['search', 'search', '检索文件'], ['execute', 'command', '运行命令'], ['fetch', 'search', '获取网页'], ['switch_mode', 'tool', '调用工具'], ['other', 'tool', '调用工具']]
    for (const [kind, type, label] of cases) expect(t.update(call({ toolCallId: `c-${kind}`, kind, locations: [] }))[0]).toMatchObject({ activity: { type, label } })
    expect(t.update(call({ toolCallId: 'think-1', kind: 'think' }))).toEqual([])
  })
  it('merges tool_call_update into the remembered call and keeps title only as tool identity for other kinds', () => {
    const t = createAcpTranslator(); t.beginTurn()
    t.update(call({ kind: 'other', title: 'MCP: tool', locations: undefined }))
    const [ev] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'spike-wechat: ping', rawInput: { providerIdentifier: 'spike-wechat', args: { secret: 'S' } } })
    expect(ev).toMatchObject({ activity: { id: 'call-1', type: 'tool', status: 'running', label: '调用工具', detail: 'spike-wechat: ping' } })
    const [done] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { success: true, secret: 'S2' } })
    expect(done).toMatchObject({ activity: { status: 'completed', detail: 'spike-wechat: ping' } })
    expect(JSON.stringify(done)).not.toContain('S2')
    expect(t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'failed' })[0]).toMatchObject({ activity: { id: 'unknown', type: 'tool', status: 'failed' } })
    expect(t.update(call({ toolCallId: 'exec', kind: 'execute', title: '`rm -rf /`', status: 'failed' }))[0]).toMatchObject({ activity: { status: 'failed' } })
    expect(JSON.stringify(t.update(call({ toolCallId: 'exec2', kind: 'execute', title: '`uname -a`' })))).not.toContain('uname')
  })
  it('sanitizes tool call ids with control characters and bounds length', () => {
    expect(acpActivityId('call-bf73-0\nfc_2190_0')).toBe('call-bf73-0_fc_2190_0')
    expect(acpActivityId('x'.repeat(500))).toHaveLength(200)
  })
  it('describes permission requests for review and picks only the once options', () => {
    const params = { sessionId: 's', toolCall: { toolCallId: 'c', title: '`uname -a`', kind: 'execute', status: 'pending', rawInput: { command: 'uname -a' }, content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: uname' } }], locations: [{ path: '/p' }] }, options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] }
    expect(acpPermissionDescription(params)).toBe('uname -a\nNot in allowlist: uname\n/p')
    expect(acpPermissionDescription({ ...params, toolCall: { ...params.toolCall, kind: 'edit', rawInput: {} } })).toBe('`uname -a`\nNot in allowlist: uname\n/p')
    expect(acpPermissionDescription({ ...params, toolCall: undefined })).toBeNull()
    expect(acpPermissionDescription({ ...params, options: 'no' })).toBeNull()
    expect(acpPermissionDescription({ ...params, toolCall: { ...params.toolCall, rawInput: { command: 'x'.repeat(20_001) } } })).toBeNull()
    expect(acpPermissionOption(params.options, true)).toBe('allow-once')
    expect(acpPermissionOption(params.options, false)).toBe('reject-once')
    expect(acpPermissionOption([{ optionId: 'a', kind: 'allow_always' }], true)).toBeNull()
    expect(acpPermissionOption('nope', false)).toBeNull()
  })
})
