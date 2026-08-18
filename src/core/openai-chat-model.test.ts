import { describe, it, expect } from 'vitest'
import { MockLanguageModelV2 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { createChatModelFromLanguageModel } from './openai-chat-model'

// createChatModelFromLanguageModel is an internal seam used by the test to
// inject a mock model; createAiSdkChatModel wraps it with a real provider.
function textModel(chunks: string[]) {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          ...chunks.map(delta => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      }),
    }),
  })
}

describe('ChatModelClient adapter', () => {
  it('streams text deltas as TurnDelta text events', async () => {
    const client = createChatModelFromLanguageModel(textModel(['Hel', 'lo']))
    const turn = client.streamTurn([client.userMessage('hi')], [])
    const seen: string[] = []
    for await (const d of turn.deltas) if (d.kind === 'text') seen.push(d.text)
    expect(seen.join('')).toBe('Hello')
    const fin = await turn.finished
    expect(fin.toolCalls).toEqual([])
    expect(fin.messages.length).toBeGreaterThan(0)
  })

  it('generate() returns the concatenated text for a one-shot call', async () => {
    const client = createChatModelFromLanguageModel(textModel(['42']))
    const out = await client.generate([client.userMessage('answer?')])
    expect(out).toBe('42')
  })

  it('surfaces a tool call (schema-only tool, no execute) as a tool_call delta', async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'reply', input: '{"text":"hi"}' },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      }),
    })
    const client = createChatModelFromLanguageModel(model)
    const spec = { name: 'reply', description: 'send a reply', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
    const turn = client.streamTurn([client.userMessage('hi')], [spec])
    const calls: unknown[] = []
    for await (const d of turn.deltas) if (d.kind === 'tool_call') calls.push(d)
    const fin = await turn.finished
    expect(fin.toolCalls).toHaveLength(1)
    expect(fin.toolCalls[0]).toMatchObject({ id: 'c1', name: 'reply' })
  })

  it('finished rejects with the original error when the underlying doStream() call rejects (AI SDK v5 wraps this as a bare fullStream error part, not a re-thrown exception — matches a real gateway 401)', async () => {
    // This mirrors what a real transport failure looks like at the
    // LanguageModel boundary: doStream() itself rejects (no chunks were
    // ever streamed). AI SDK's outer streamStep().catch() then synthesizes
    // a one-chunk stream carrying `{type:'error', error}` and merges it
    // into fullStream *without* running it through the per-step pipeline
    // (no start-step/finish-step) — so `result.response` sees zero
    // recorded steps and rejects with a generic NoOutputGeneratedError
    // that has lost the real cause. Feeding the error as a stream chunk
    // instead (via simulateReadableStream) would go through that per-step
    // pipeline and synthesize an empty successful step, which does not
    // reproduce the bug this test guards against.
    const cause = Object.assign(new Error('Authentication Error, Invalid proxy server token passed'), { statusCode: 401 })
    const model = new MockLanguageModelV2({
      doStream: async () => {
        throw cause
      },
    })
    const client = createChatModelFromLanguageModel(model)
    const turn = client.streamTurn([client.userMessage('hi')], [])
    // Drain deltas first (matches the caller's real usage: consume deltas,
    // then await finished) — the error part carries no TurnDelta, it only
    // sets the closure-scoped streamError consumed by `finished`.
    for await (const _d of turn.deltas) { /* no-op: error part yields nothing */ }
    await expect(turn.finished).rejects.toBe(cause)
  })

  it('generate() rejects with the original cause when doStream() rejects (same NoOutputGeneratedError-masking bug as streamTurn, on the one-shot path)', async () => {
    // Mirrors the streamTurn test above: doStream() itself rejects (no
    // chunks ever streamed) — AI SDK synthesizes a fullStream error part
    // and `result.text` then rejects with a generic NoOutputGeneratedError
    // that has lost the real cause (statusCode, message). generate() must
    // capture and rethrow the original cause, identity-asserted via
    // `.toBe(cause)` (not just a matching message).
    const cause = Object.assign(new Error('Authentication Error, Invalid proxy server token passed'), { statusCode: 401 })
    const model = new MockLanguageModelV2({
      doStream: async () => {
        throw cause
      },
    })
    const client = createChatModelFromLanguageModel(model)
    await expect(client.generate([client.userMessage('hi')])).rejects.toBe(cause)
  })
})
