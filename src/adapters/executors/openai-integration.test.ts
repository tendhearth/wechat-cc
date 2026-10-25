import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAiAgentProvider } from './openai/openai-agent-provider'
import { collectTurn } from '../../ports/agent-provider'
import type { McpToolBridge } from './openai/openai-mcp-bridge'
import { scriptedOpenAiModel } from '../../test-support/executors/openai-scripted'

/**
 * End-to-end integration test: the REAL `createOpenAiAgentProvider` wired to
 * the REAL `builtinTools` (no mocking of the gate or the tool executors),
 * driven by the scripted `APIModel` (test-support) and a no-op MCP bridge. Proves the
 * owned tool loop (openai-agent-provider) + tier gate (openai-gate) +
 * built-in `Write` tool (openai-tools) genuinely cooperate: a trusted tier
 * actually writes bytes to disk, and a guest/deny tier actually blocks it.
 */

// Model: turn 1 → call Write; turn 2 → text 'saved'.
const writeThenDone = () => scriptedOpenAiModel([{ calls: [{ id: 'w1', name: 'Write', input: { path: 'note.txt', content: 'hi there' } }] }, { text: 'saved' }]).model

const noMcp: McpToolBridge = { tools: [], async call() { return '' }, async close() {}, serverOf() { return undefined } }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oa-int-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('openai provider integration', () => {
  it('trusted tier executes Write via the owned loop', async () => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => writeThenDone(), makeMcpBridge: async () => noMcp, cwd: dir })
    const session = await provider.spawn({ alias: 'a', path: dir }, {
      tierProfile: { allow: new Set(['fs_write']), relay: new Set(), deny: new Set() } as any,
      permissionMode: 'strict', chatId: 'c',
    } as any)
    const summary = await collectTurn(session.dispatch('write a note'))
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('hi there')
    expect(summary.assistantText.join('')).toContain('saved')
    await session.close()
  })

  it('guest tier denies Write (fs_write ∈ deny) — file is NOT written', async () => {
    const provider = createOpenAiAgentProvider({ makeChatModel: () => writeThenDone(), makeMcpBridge: async () => noMcp, cwd: dir })
    const session = await provider.spawn({ alias: 'a', path: dir }, {
      tierProfile: { allow: new Set(), relay: new Set(), deny: new Set(['fs_write']) } as any,
      permissionMode: 'strict', chatId: 'c',
    } as any)
    await collectTurn(session.dispatch('write a note'))
    expect(() => readFileSync(join(dir, 'note.txt'), 'utf8')).toThrow()
    await session.close()
  })
})
