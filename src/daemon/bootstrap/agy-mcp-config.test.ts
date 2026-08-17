import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupAgyGlobalMcp, AGY_WECHAT_MCP_NAMESPACE_ID } from './agy-mcp-config'
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
})
