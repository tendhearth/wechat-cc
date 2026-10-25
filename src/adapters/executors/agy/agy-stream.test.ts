import { describe, it, expect } from 'vitest'
import { makeAgyStreamParser } from './agy-stream'

const INIT = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm', tools: [], permission_mode: 'request-review' } })
const step = (i: number, state: string, type: string, delta?: string) => JSON.stringify({
  event: 'step_update',
  step_update: { conversation_id: 'c1', step_index: i, state, step_type: type, ...(delta !== undefined ? { text_delta: delta } : {}) },
})
const RESULT = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '2', num_turns: 1 } })

// Real samples from the Task 1 spike (agy 1.1.13, scratchpad/agy-spike-findings.md §(a)):
// a normal run_command tool call, ACTIVE then DONE, same step_index.
const TOOL_ACTIVE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'd1d2f951-0000-0000-0000-000000000000',
    step_index: 3,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } },
  },
})
const TOOL_DONE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'd1d2f951-0000-0000-0000-000000000000',
    step_index: 3,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    duration_seconds: 0.099948,
    tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' }, output: 'total 136\n...(ls output)...' },
  },
})

// Real sample from findings §(a): MCP tool call via call_mcp_tool, ServerName present.
const MCP_ACTIVE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: '9c773e58-0000-0000-0000-000000000000',
    step_index: 6,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'call_mcp_tool',
    tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { tag: 'spikeglobal' }, ServerName: 'spike-probe', ToolName: 'spike_ping' } },
  },
})
const MCP_DONE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: '9c773e58-0000-0000-0000-000000000000',
    step_index: 6,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'call_mcp_tool',
    duration_seconds: 0.005727,
    tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { tag: 'spikeglobal' }, ServerName: 'spike-probe', ToolName: 'spike_ping' }, output: 'pong:spikeglobal' },
  },
})

// Real sample from findings §(b): strict-mode permission denial, tool step goes
// straight to ERROR (not DONE), with tool_info.error instead of tool_info.output.
const TOOL_ERROR_ONLY = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: '13d25df9-0000-0000-0000-000000000000',
    step_index: 3,
    state: 'ERROR',
    step_type: 'tool',
    tool_name: 'write_to_file',
    duration_seconds: 0.051814,
    tool_info: {
      name: 'write_to_file',
      parameters: { TargetFile: '/tmp/agy-spike/test.txt' },
      error: { type: 'TOOL_ERROR', message: 'User denied permission for write_file(/tmp/agy-spike/test.txt).' },
    },
  },
})

// Real sample from findings §(e): invalid --model produces result.status:"ERROR"
// with a full error string (conversation_id is "" in this failure mode).
const RESULT_ERROR = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: '',
    status: 'ERROR',
    response: '',
    error: 'invalid model selection (--model "totally-bogus-model-xyz" --effort ""): model totally-bogus-model-xyz is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.7 Flash (High)\n  ...',
    duration_seconds: 0,
    num_turns: 0,
  },
})

describe('makeAgyStreamParser', () => {
  it('init → init event with conversationId', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(INIT)).toEqual([{ kind: 'init', conversationId: 'c1' }])
  })

  it('agent_response deltas aggregate; one text on DONE', () => {
    const p = makeAgyStreamParser()
    p.feed(INIT)
    expect(p.feed(step(2, 'ACTIVE', 'agent_response', 'he'))).toEqual([])
    expect(p.feed(step(2, 'ACTIVE', 'agent_response', 'llo'))).toEqual([])
    expect(p.feed(step(2, 'DONE', 'agent_response', '!'))).toEqual([{ kind: 'text', text: 'hello!' }])
  })

  it('non-response steps and unknown events are silently skipped', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(step(0, 'DONE', 'user_input'))).toEqual([])
    expect(p.feed(step(3, 'DONE', 'checkpoint'))).toEqual([])
    expect(p.feed(JSON.stringify({ event: 'future_thing', x: 1 }))).toEqual([])
    expect(p.feed('not json at all')).toEqual([])
  })

  it('result SUCCESS → result; non-SUCCESS → error', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(RESULT)).toEqual([{ kind: 'result', conversationId: 'c1', numTurns: 1 }])
    const failed = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'FAILED', response: '', num_turns: 1 } })
    expect(p.feed(failed)).toEqual([{ kind: 'error', message: 'agy result status=FAILED' }])
  })

  it('result ERROR with an error field includes both status and the error content', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(RESULT_ERROR)).toEqual([{
      kind: 'error',
      message: 'agy result status=ERROR: invalid model selection (--model "totally-bogus-model-xyz" --effort ""): model totally-bogus-model-xyz is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.7 Flash (High)\n  ...',
    }])
  })

  it('flush emits a pending unaggregated text once', () => {
    const p = makeAgyStreamParser()
    p.feed(step(2, 'ACTIVE', 'agent_response', 'partial'))
    expect(p.flush()).toEqual([{ kind: 'text', text: 'partial' }])
    expect(p.flush()).toEqual([])
  })

  it('tool step maps to tool_call on the first line carrying tool_name; DONE line is deduped (real run_command sample)', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(TOOL_ACTIVE)).toEqual([{ kind: 'tool_call', tool: 'run_command' }])
    expect(p.feed(TOOL_DONE)).toEqual([])
  })

  it('call_mcp_tool extracts ToolName as tool and ServerName as server (real MCP sample)', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(MCP_ACTIVE)).toEqual([{ kind: 'tool_call', tool: 'spike_ping', server: 'spike-probe' }])
    expect(p.feed(MCP_DONE)).toEqual([])
  })

  it('a tool step that goes straight to ERROR still emits tool_call once (real strict-mode denial sample)', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(TOOL_ERROR_ONLY)).toEqual([{ kind: 'tool_call', tool: 'write_to_file' }])
  })

  it('switching step_index while the old agent_response step is not DONE flushes it first', () => {
    const p = makeAgyStreamParser()
    p.feed(step(2, 'ACTIVE', 'agent_response', 'orphaned'))
    expect(p.feed(step(4, 'DONE', 'agent_response', 'next'))).toEqual([
      { kind: 'text', text: 'orphaned' },
      { kind: 'text', text: 'next' },
    ])
  })
})

// 2026-09-03:真机日志里看到 `chunks=3 preview=""` —— 第一个 chunk 是空串。
// 根因:一个没有 text_delta 的 agent_response step(纯状态变化)也会建出
// pending,flush 时照样吐一个 `{kind:'text', text:''}`。
//
// 后果不只是 preview 难看:solo 路径 `for (const t of assistantTexts)` 会为
// 每个空 chunk 发一次消息(最底层的 `if (!text)` 兜住了,但那是一次注定失败
// 的发送),`chunks=` 的计数也是虚的。
describe('空文本不该被当成一条消息', () => {
  it('agent_response step 没有 text_delta → 不产 text 事件', () => {
    const p = makeAgyStreamParser()
    const out = [
      ...p.feed(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response' } })),
      ...p.feed(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response' } })),
      ...p.flush(),
    ]
    expect(out.filter(e => e.kind === 'text')).toEqual([])
  })

  it('有内容的照常聚合成一条', () => {
    const p = makeAgyStreamParser()
    const out = [
      ...p.feed(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你' } })),
      ...p.feed(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '好' } })),
      ...p.flush(),
    ]
    expect(out.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: '你好' }])
  })

  it('纯空白也算空(发出去只会是一条空消息)', () => {
    const p = makeAgyStreamParser()
    const out = [
      ...p.feed(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '   \n' } })),
      ...p.flush(),
    ]
    expect(out.filter(e => e.kind === 'text')).toEqual([])
  })
})
