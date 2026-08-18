import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupAgyGlobalMcp, removeAgyGlobalMcp, AGY_WECHAT_MCP_NAMESPACE_ID } from './agy-mcp-config'
import type { McpStdioSpec } from '../../core/mcp-stdio-spec'

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'agy-mcp-config-'))
}

const wechatSpec: McpStdioSpec = {
  command: '/usr/bin/bun',
  args: ['/abs/path/src/mcp-servers/wechat/main.ts'],
  env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1234', WECHAT_INTERNAL_TOKEN_FILE: '/state/internal-token' },
}

function fakeLog(): { log: (tag: string, line: string) => void; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return { log: (tag, line) => calls.push([tag, line]), calls }
}

describe('setupAgyGlobalMcp — tier C (global-only)', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpConfigDir()
  })

  it('fresh dir ⇒ creates mcp_config.json with exactly our namespaced entry (token + trusted tier)', () => {
    const { log } = fakeLog()
    const changed = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-fresh',
      geminiConfigDir: dir,
      log,
    })
    expect(changed).toBe(true)

    const raw = readFileSync(join(dir, 'mcp_config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(Object.keys(parsed.mcpServers)).toEqual([AGY_WECHAT_MCP_NAMESPACE_ID])
    const entry = parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID]
    expect(entry.command).toBe(wechatSpec.command)
    expect(entry.args).toEqual(wechatSpec.args)
    expect(entry.env.WECHAT_INTERNAL_API).toBe(wechatSpec.env!.WECHAT_INTERNAL_API)
    expect(entry.env.WECHAT_SESSION_TOKEN).toBe('tok-fresh')
    expect(entry.env.WECHAT_SESSION_TIER).toBe('trusted')
  })

  it('creates the directory tree when absent', () => {
    const nested = join(dir, 'nested', 'config')
    const changed = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-nested',
      geminiConfigDir: nested,
      log: fakeLog().log,
    })
    expect(changed).toBe(true)
    expect(() => readFileSync(join(nested, 'mcp_config.json'), 'utf8')).not.toThrow()
  })

  it('existing file with user entries ⇒ theirs preserved byte-for-byte, ours upserted alongside', () => {
    mkdirSync(dir, { recursive: true })
    const userEntry = { command: 'node', args: ['user-server.js'], env: { FOO: 'bar' } }
    const initial = { mcpServers: { 'some-other:server': userEntry } }
    writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify(initial, null, 2) + '\n')

    const changed = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-1',
      geminiConfigDir: dir,
      log: fakeLog().log,
    })
    expect(changed).toBe(true)

    const parsed = JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8'))
    expect(parsed.mcpServers['some-other:server']).toEqual(userEntry)
    expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_SESSION_TOKEN).toBe('tok-1')
  })

  it('idempotent second call with the same mint result ⇒ returns false, mtime/content unchanged', () => {
    const opts = {
      wechatSpec,
      mintToken: () => 'tok-stable',
      geminiConfigDir: dir,
      log: fakeLog().log,
    }
    const first = setupAgyGlobalMcp(opts)
    expect(first).toBe(true)

    const path = join(dir, 'mcp_config.json')
    const contentAfterFirst = readFileSync(path, 'utf8')
    const mtimeAfterFirst = statSync(path).mtimeMs

    const second = setupAgyGlobalMcp(opts)
    expect(second).toBe(false)

    expect(readFileSync(path, 'utf8')).toBe(contentAfterFirst)
    expect(statSync(path).mtimeMs).toBe(mtimeAfterFirst)
  })

  it('token changes between calls ⇒ rewrites (returns true)', () => {
    mkdirSync(dir, { recursive: true })
    const first = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-a',
      geminiConfigDir: dir,
      log: fakeLog().log,
    })
    expect(first).toBe(true)

    const second = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-b',
      geminiConfigDir: dir,
      log: fakeLog().log,
    })
    expect(second).toBe(true)

    const parsed = JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8'))
    expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_SESSION_TOKEN).toBe('tok-b')
  })

  it('pre-existing EMPTY (0-byte) file ⇒ treated as absent, entry written (agy ships an empty placeholder — real-deploy finding 2026-08-18)', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp_config.json'), '')
    const { log } = fakeLog()
    const changed = setupAgyGlobalMcp({ wechatSpec, mintToken: () => 'tok-empty', geminiConfigDir: dir, log })
    expect(changed).toBe(true)
    const parsed = JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8'))
    expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_SESSION_TOKEN).toBe('tok-empty')
  })

  it('whitespace-only file ⇒ same as empty (treated as absent)', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp_config.json'), '  \n')
    const { log } = fakeLog()
    expect(setupAgyGlobalMcp({ wechatSpec, mintToken: () => 't', geminiConfigDir: dir, log })).toBe(true)
  })

  it('corrupted existing JSON ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const corrupted = '{ this is not valid json ,,, '
    writeFileSync(path, corrupted)

    const { log, calls } = fakeLog()
    const mintToken = vi.fn(() => 'tok-should-not-be-minted')
    const changed = setupAgyGlobalMcp({ wechatSpec, mintToken, geminiConfigDir: dir, log })

    expect(changed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(corrupted)
    expect(calls.length).toBeGreaterThan(0)
    // Protection must not itself become a side-effecting failure source: no
    // token minted when we're about to bail out without writing anything.
    expect(mintToken).not.toHaveBeenCalled()
  })

  it('unexpected root shape (not an object) ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const weird = JSON.stringify(['not', 'an', 'object'])
    writeFileSync(path, weird)

    const { log, calls } = fakeLog()
    const changed = setupAgyGlobalMcp({ wechatSpec, mintToken: () => 'tok-x', geminiConfigDir: dir, log })

    expect(changed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(weird)
    expect(calls.length).toBeGreaterThan(0)
  })

  // TEST-RUNNER GUARD (2026-08-17, fix round 1) — the real bug this guards
  // against: every e2e/bootstrap test that boots a real daemon (real
  // internalApi + a real `agy` on PATH) with NO explicit geminiConfigDir
  // would otherwise default to the operator's REAL ~/.gemini/config, and
  // this test file itself runs under vitest, so `UNDER_TEST_RUNNER` is
  // genuinely true here — no env-var stubbing needed to exercise it.
  it('omitting geminiConfigDir under a test runner skips entirely — never reads/writes/mints, never touches the real ~/.gemini/config', () => {
    const { log, calls } = fakeLog()
    const mintToken = vi.fn(() => 'tok-should-never-be-minted')
    const changed = setupAgyGlobalMcp({ wechatSpec, mintToken, log })
    expect(changed).toBe(false)
    expect(mintToken).not.toHaveBeenCalled()
    expect(calls.some(([, line]) => line.includes('skipped under test runner'))).toBe(true)
  })
})

describe('removeAgyGlobalMcp — mirror of setup, cleans up on graceful shutdown', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpConfigDir()
  })

  it('file with our entry + user entries ⇒ ours removed, theirs intact key/byte-level, returns true', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const userEntry = { command: 'node', args: ['user-server.js'], env: { FOO: 'bar' } }
    const setupChanged = setupAgyGlobalMcp({
      wechatSpec,
      mintToken: () => 'tok-1',
      geminiConfigDir: dir,
      log: fakeLog().log,
    })
    expect(setupChanged).toBe(true)
    const afterSetup = JSON.parse(readFileSync(path, 'utf8'))
    afterSetup.mcpServers['some-other:server'] = userEntry
    afterSetup.topLevelUserKey = 'preserved'
    writeFileSync(path, JSON.stringify(afterSetup, null, 2) + '\n')

    const { log } = fakeLog()
    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log })
    expect(removed).toBe(true)

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID]).toBeUndefined()
    expect(parsed.mcpServers['some-other:server']).toEqual(userEntry)
    expect(parsed.topLevelUserKey).toBe('preserved')
  })

  it('removing our entry leaves an empty mcpServers object rather than deleting the file', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    setupAgyGlobalMcp({ wechatSpec, mintToken: () => 'tok-only', geminiConfigDir: dir, log: fakeLog().log })

    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log: fakeLog().log })
    expect(removed).toBe(true)

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.mcpServers).toEqual({})
  })

  it('entry absent ⇒ returns false, does not write', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const initial = { mcpServers: { 'some-other:server': { command: 'node', args: [], env: {} } } }
    const initialText = JSON.stringify(initial, null, 2) + '\n'
    writeFileSync(path, initialText)
    const mtimeBefore = statSync(path).mtimeMs

    const { log, calls } = fakeLog()
    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(initialText)
    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
    void calls
  })

  it('missing file ⇒ returns false, no-op (no error, no write)', () => {
    const { log, calls } = fakeLog()
    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log })
    expect(removed).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('empty (0-byte) file ⇒ nothing to remove, returns false, no write, no corrupted-warning', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp_config.json'), '')
    const { log, calls } = fakeLog()
    expect(removeAgyGlobalMcp({ geminiConfigDir: dir, log })).toBe(false)
    expect(readFileSync(join(dir, 'mcp_config.json'), 'utf8')).toBe('')
    expect(calls.map(c => c.join(' ')).join('\n')).not.toContain('corrupted')
  })

  it('corrupted existing JSON ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const corrupted = '{ this is not valid json ,,, '
    writeFileSync(path, corrupted)

    const { log, calls } = fakeLog()
    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(corrupted)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('unexpected root shape (not an object) ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp_config.json')
    const weird = JSON.stringify(['not', 'an', 'object'])
    writeFileSync(path, weird)

    const { log, calls } = fakeLog()
    const removed = removeAgyGlobalMcp({ geminiConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(weird)
    expect(calls.length).toBeGreaterThan(0)
  })

  // TEST-RUNNER GUARD mirror (see setupAgyGlobalMcp's equivalent above) —
  // omitting geminiConfigDir under vitest must never default to the real
  // ~/.gemini/config, on the removal path any more than on the write path.
  it('omitting geminiConfigDir under a test runner skips entirely — never reads/writes, never touches the real ~/.gemini/config', () => {
    const { log, calls } = fakeLog()
    const removed = removeAgyGlobalMcp({ log })
    expect(removed).toBe(false)
    expect(calls.some(([, line]) => line.includes('skipped under test runner'))).toBe(true)
  })
})
