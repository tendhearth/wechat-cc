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
})
