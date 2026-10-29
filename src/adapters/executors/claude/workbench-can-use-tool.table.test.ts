/**
 * 一起做里 Claude 的 canUseTool(claude-agent-provider.ts 的 makeWorkbenchClaudeCanUseTool)的表:登记表 / 放进来的 MCP /
 * 取消 / 提问通道 / 问的通道 每一条路给出的**确切**结果和交给问的通道的那一份请求。2026-10-28 第四轮:原来这些
 * 只靠 authorize.parity.test.ts 那一面「与旧实现逐格相同」兜着,那一面删了,这里直接写出来
 * (docs/maintainer/mutation-baseline-2026-10.md「第四轮」)。问的通道 / 提问通道是注进来的回调(系统边界),不替换内部模块。
 */
import { describe, expect, it } from 'vitest'
import type { SpawnContext } from '../../../ports/agent-provider'
import { makeWorkbenchClaudeCanUseTool } from './claude-agent-provider'

const NOT_REGISTERED = { behavior: 'deny', message: 'This tool is not registered for the task.' }
const CANCELLED = { behavior: 'deny', message: 'This task tool call was cancelled.' }
const QUESTION_DENIED = { behavior: 'deny', message: 'The task question was declined, invalid, or is no longer active.' }
const MCP_DENIED = { behavior: 'deny', message: 'The task tool was not admitted, or approval was denied or expired.' }
const NO_CHANNEL = { behavior: 'deny', message: 'This task permission request is no longer active.' }
const TOO_LARGE = { behavior: 'deny', message: 'The complete permission detail is too large to review safely.' }
const REFUSED = { behavior: 'deny', message: 'The task permission request was denied or expired.' }
const ALLOW = { behavior: 'allow' }

type Permit = 'missing' | 'yes' | 'no' | 'throws'
function setup(o: { permit?: Permit; admitted?: string[]; registered?: string[] | null; questions?: boolean | 'null' | 'throws' } = {}) {
  const requests: unknown[] = []
  const questions: unknown[] = []
  const permit = o.permit ?? 'yes'
  const rp: SpawnContext['requestPermission'] = permit === 'missing' ? undefined : async (req) => {
    requests.push(req)
    if (permit === 'throws') throw Error('gone')
    return permit === 'yes'
  }
  const ru: SpawnContext['requestUserInput'] = !o.questions ? undefined : async (req) => {
    questions.push(req)
    if (o.questions === 'throws') throw Error('ui gone')
    if (o.questions === 'null') return null
    return Object.fromEntries(req.questions.map(q => [q.id, [q.options[0]!.label]]))
  }
  const gate = makeWorkbenchClaudeCanUseTool(rp, ru, o.admitted ?? [], o.registered === undefined ? null : o.registered)
  const call = (tool: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}, aborted = false) => {
    const c = new AbortController(); if (aborted) c.abort()
    return gate(tool, input, { signal: c.signal, toolUseID: 'tool-1', ...opts } as never)
  }
  return { call, requests, questions }
}

describe('登记表:没登记的 MCP 在最前面就拒(连取消都不看);内置工具不受登记表影响', () => {
  const ROWS: [string[] | null, string, unknown][] = [
    [['catalog'], 'mcp__other__x', NOT_REGISTERED],
    [['catalog'], 'mcp__catalogue__x', NOT_REGISTERED],          // 前缀要带 __ 分隔
    [['catalog'], 'mcp__x__catalog__y', NOT_REGISTERED],         // 只认开头
    [[], 'mcp__catalog__lookup', NOT_REGISTERED],
    [['catalog'], 'mcp__catalog__lookup', ALLOW],                 // 登记 + 放进来 ⇒ 问,问的通道说行
    [null, 'mcp__other__x', MCP_DENIED],                          // null = 不做登记那一层,落到「没放进来」
    [['catalog'], 'Read', ALLOW],
    [['catalog'], 'Bash', ALLOW],
  ]
  it.each(ROWS)('登记 %j · %s', async (registered, tool, want) => {
    const g = setup({ registered, admitted: ['catalog'] })
    expect(await g.call(tool, { query: 'x' })).toEqual(want)
  })
  it('没登记的 MCP:调用已取消也照样回「没登记」', async () => {
    expect(await setup({ registered: ['catalog'] }).call('mcp__other__x', {}, {}, true)).toEqual(NOT_REGISTERED)
  })
})

describe('取消了:任何别的路之前就拒,确切的话', () => {
  it.each([
    ['AskUserQuestion', { questions: [] }], ['mcp__catalog__lookup', { query: 'x' }], ['Read', { file_path: '/p/a' }], ['Bash', { command: 'rm -rf build' }],
  ] as const)('%s', async (tool, input) => {
    const g = setup({ admitted: ['catalog'], registered: ['catalog'], questions: true })
    expect(await g.call(tool, input, {}, true)).toEqual(CANCELLED)
    expect(g.requests).toEqual([])
    expect(g.questions).toEqual([])
  })
})

describe('AskUserQuestion:结构化提问,答案按问题原文交回;任何不对 ⇒ 同一句拒', () => {
  const opt = (label: string, extra: Record<string, unknown> = {}) => ({ label, description: `${label}!`, ...extra })
  const q = (extra: Record<string, unknown> = {}) => ({ header: 'H', question: 'Which?', options: [opt('A'), opt('B')], multiSelect: false, ...extra })

  it('答了 ⇒ 放,updatedInput 带 answers;请求的 id 是 toolUseID:序号', async () => {
    const g = setup({ questions: true })
    const input = { questions: [q(), q({ question: 'Second?', multiSelect: true })], extra: 1 }
    expect(await g.call('AskUserQuestion', input)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which?': 'A', 'Second?': 'A' } } })
    expect(g.questions).toEqual([{ questions: [
      { id: 'tool-1:0', header: 'H', question: 'Which?', options: [opt('A'), opt('B')], multiSelect: false, allowOther: true },
      { id: 'tool-1:1', header: 'H', question: 'Second?', options: [opt('A'), opt('B')], multiSelect: true, allowOther: true },
    ] }])
  })

  it('选项带 preview ⇒ 描述后面换行接上 preview;preview 空串不接', async () => {
    const g = setup({ questions: true })
    await g.call('AskUserQuestion', { questions: [q({ options: [opt('A', { preview: 'code' }), opt('B', { preview: '' })] })] })
    expect((g.questions[0] as { questions: { options: unknown[] }[] }).questions[0]!.options).toEqual([{ label: 'A', description: 'A!\ncode' }, { label: 'B', description: 'B!' }])
  })

  it('四个选项可以', async () => {
    expect(await setup({ questions: true }).call('AskUserQuestion', { questions: [q({ options: [opt('A'), opt('B'), opt('C'), opt('D')] })] })).toMatchObject(ALLOW)
  })

  const BAD: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ['questions 不是数组', { questions: 'bad' }],
    ['问题不是对象', { questions: ['x'] }],
    ['问题是 null', { questions: [null] }],
    ['问题是数组', { questions: [[q()]] }],
    ['question 不是字符串', { questions: [q({ question: 1 })] }],
    ['问题原文重复', { questions: [q(), q()] }],
    ['multiSelect 不是布尔', { questions: [q({ multiSelect: 'no' })] }],
    ['options 不是数组', { questions: [q({ options: 'A' })] }],
    ['只有一个选项', { questions: [q({ options: [opt('A')] })] }],
    ['五个选项', { questions: [q({ options: [opt('A'), opt('B'), opt('C'), opt('D'), opt('E')] })] }],
    ['选项不是对象', { questions: [q({ options: ['A', 'B'] })] }],
    ['选项是 null', { questions: [q({ options: [null, opt('B')] })] }],
    ['选项是数组', { questions: [q({ options: [[opt('A')], opt('B')] })] }],
    ['preview 不是字符串', { questions: [q({ options: [opt('A', { preview: 1 }), opt('B')] })] }],
    ['没有 toolUseID', { questions: [q()] }, { toolUseID: undefined }],
    ['toolUseID 空串', { questions: [q()] }, { toolUseID: '' }],
    ['toolUseID 不是字符串', { questions: [q()] }, { toolUseID: 7 }],
  ]
  it.each(BAD)('%s ⇒ 拒,不问', async (_why, input, opts) => {
    const g = setup({ questions: true })
    expect(await g.call('AskUserQuestion', input, opts)).toEqual(QUESTION_DENIED)
    expect(g.questions).toEqual([])
  })

  it.each([['没有提问通道', false], ['主人没答', 'null'], ['通道出错', 'throws']] as const)('%s ⇒ 拒', async (_why, questions) => {
    expect(await setup({ questions }).call('AskUserQuestion', { questions: [q()] })).toEqual(QUESTION_DENIED)
  })

  it('答完之前取消了 ⇒ 拒', async () => {
    const c = new AbortController()
    const gate = makeWorkbenchClaudeCanUseTool(undefined, async (req) => { c.abort(); return { [req.questions[0]!.id]: ['A'] } }, [], null)
    expect(await gate('AskUserQuestion', { questions: [q()] }, { signal: c.signal, toolUseID: 't' } as never)).toEqual(QUESTION_DENIED)
  })

  it('答案对不上 ⇒ 拒', async () => {
    const gate = makeWorkbenchClaudeCanUseTool(undefined, async () => ({ nope: ['A'] }), [], null)
    expect(await gate('AskUserQuestion', { questions: [q()] }, { signal: new AbortController().signal, toolUseID: 't' } as never)).toEqual(QUESTION_DENIED)
  })
})

describe('MCP:放进来的才问,问的是「工具名 + 去掉凭据的参数」;其余同一句拒', () => {
  const ROWS: [string, string[], Permit, unknown, boolean][] = [
    ['mcp__catalog__lookup', ['catalog'], 'yes', ALLOW, true],
    ['mcp__catalog__lookup', ['catalog'], 'no', MCP_DENIED, true],
    ['mcp__catalog__lookup', ['catalog'], 'throws', MCP_DENIED, true],
    ['mcp__catalog__lookup', ['catalog'], 'missing', MCP_DENIED, false],
    ['mcp__catalog__', ['catalog'], 'yes', MCP_DENIED, false],               // 只有前缀没有工具名
    ['mcp__catalog__x', ['catalog'], 'yes', ALLOW, true],                    // 一个字的工具名可以
    ['mcp__my_catalog__lookup', ['catalog', 'my_catalog'], 'yes', ALLOW, true],
    ['mcp__catalog_other__lookup', ['catalog'], 'yes', MCP_DENIED, false],
    ['mcp__wechat__reply', ['wechat'], 'yes', MCP_DENIED, false],            // 陪伴那几个 MCP 永远不放进一起做
    ['mcp__delegate__run', ['delegate'], 'yes', MCP_DENIED, false],
    ['mcp__other__x', ['catalog'], 'yes', MCP_DENIED, false],
  ]
  it.each(ROWS)('%s 放进来 %j 问的通道 %s', async (tool, admitted, permit, want, asked) => {
    const g = setup({ admitted, permit })
    expect(await g.call(tool, { query: 'x', api_key: 'secret' })).toEqual(want)
    expect(g.requests).toEqual(asked ? [{ tool, description: `${tool}\n{"query":"x","api_key":"[credential omitted]"}` }] : [])
  })

  it('名字 160 字可以问,161 字装不下 ⇒ 拒,不问', async () => {
    const ok = `mcp__catalog__${'x'.repeat(160 - 14)}`, long = `${ok}x`
    const g = setup({ admitted: ['catalog'] })
    expect(await g.call(ok, {})).toEqual(ALLOW)
    expect(await g.call(long, {})).toEqual(MCP_DENIED)
    expect(g.requests).toHaveLength(1)
  })

  it('参数预览太长(留 256 给工具名)⇒ 拒,不问;刚好装得下 ⇒ 问', async () => {
    const g = setup({ admitted: ['catalog'] })
    // 预览 {"q":"…"} = 8 + n 个字,上限 20000 - 256
    expect(await g.call('mcp__catalog__lookup', { q: 'x'.repeat(20_000 - 256 - 8) })).toEqual(ALLOW)
    expect(await g.call('mcp__catalog__lookup', { q: 'x'.repeat(20_000 - 256 - 8 + 1) })).toEqual(MCP_DENIED)
    expect(g.requests).toHaveLength(1)
  })

  it('批准回来之前取消了 ⇒ 拒', async () => {
    const c = new AbortController()
    const gate = makeWorkbenchClaudeCanUseTool(async () => { c.abort(); return true }, undefined, ['catalog'], null)
    expect(await gate('mcp__catalog__lookup', { q: 1 }, { signal: c.signal } as never)).toEqual(MCP_DENIED)
  })
})

describe('内置工具:trusted × solo × strict;要问的交给问的通道,带上下文、命令原文与路径', () => {
  it.each([['Read', { file_path: '/p/a' }], ['Write', { file_path: '/p/a', content: 'x' }], ['Bash', { command: 'ls' }], ['WebFetch', { url: 'https://e.com' }], ['Task', {}], ['SomethingNew', {}]] as const)('%s ⇒ 直接放,不问', async (tool, input) => {
    const g = setup()
    expect(await g.call(tool, input)).toEqual(ALLOW)
    expect(g.requests).toEqual([])
  })

  const ASK: [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>][] = [
    ['命令 + title', { command: 'rm -rf build' }, { title: '  Remove build  ' }, { tool: 'Bash', description: 'Remove build\ncommand=rm -rf build', command: 'rm -rf build' }],
    ['没 title 用 description', { command: 'rm -rf build' }, { description: ' Clean ' }, { tool: 'Bash', description: 'Clean\ncommand=rm -rf build', command: 'rm -rf build' }],
    ['都没有用 decisionReason', { command: 'rm -rf build' }, { decisionReason: ' Why ' }, { tool: 'Bash', description: 'Why\ncommand=rm -rf build', command: 'rm -rf build' }],
    ['title 只有空白 ⇒ 往下找', { command: 'rm -rf build' }, { title: '  ', description: 'D' }, { tool: 'Bash', description: 'D\ncommand=rm -rf build', command: 'rm -rf build' }],
    ['没有上下文', { command: 'rm -rf build' }, {}, { tool: 'Bash', description: 'command=rm -rf build', command: 'rm -rf build' }],
  ]
  it.each(ASK)('%s', async (_why, input, opts, request) => {
    const g = setup()
    expect(await g.call('Bash', input, opts)).toEqual(ALLOW)
    expect(g.requests).toEqual([request])
  })

  it.each([['no', REFUSED], ['throws', REFUSED], ['missing', NO_CHANNEL]] as const)('问的通道 %s ⇒ 拒', async (permit, want) => {
    expect(await setup({ permit }).call('Bash', { command: 'rm -rf build' })).toEqual(want)
  })

  it('批准回来之前取消了 ⇒ 拒', async () => {
    const c = new AbortController()
    const gate = makeWorkbenchClaudeCanUseTool(async () => { c.abort(); return true }, undefined, [], null)
    expect(await gate('Bash', { command: 'rm -rf build' }, { signal: c.signal } as never)).toEqual(REFUSED)
  })

  it('细节太大装不下 ⇒ 拒,不问;刚好装得下 ⇒ 问', async () => {
    const g = setup()
    const fits = `rm -rf ${'x'.repeat(20_000 - 'command=rm -rf '.length)}`
    expect(await g.call('Bash', { command: fits })).toEqual(ALLOW)
    expect(await g.call('Bash', { command: `${fits}x` })).toEqual(TOO_LARGE)
    expect(await g.call('Bash', { command: fits }, { title: 'T' })).toEqual(TOO_LARGE)
    expect(g.requests).toHaveLength(1)
  })
})
