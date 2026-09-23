import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeCursorGlobalMcp } from './cursor-mcp-config'

const LEGACY_CURSOR_WECHAT_MCP_KEY = 'wechat-cc:wechat'

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'agy-mcp-config-'))
}

function fakeLog(): { log: (tag: string, line: string) => void; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return { log: (tag, line) => calls.push([tag, line]), calls }
}

/** Writes an mcp.json fixture that already contains our namespaced entry (as the old writer would have left it). */
function writeFixtureWithOurEntry(path: string, extra?: { userEntry?: unknown; topLevelUserKey?: string }): void {
  const root: Record<string, unknown> = {
    mcpServers: {
      [LEGACY_CURSOR_WECHAT_MCP_KEY]: {
        command: '/usr/bin/bun',
        args: ['/abs/path/src/mcp-servers/wechat/main.ts'],
        env: { WECHAT_SESSION_TOKEN: 'tok-1', WECHAT_SESSION_TIER: 'trusted' },
      },
      ...(extra?.userEntry ? { 'some-other:server': extra.userEntry } : {}),
    },
    ...(extra?.topLevelUserKey ? { topLevelUserKey: extra.topLevelUserKey } : {}),
  }
  writeFileSync(path, JSON.stringify(root, null, 2) + '\n')
}

describe('removeCursorGlobalMcp — cleans up the entry the retired print-mode writer used to leave behind', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpConfigDir()
  })

  it('file with our entry + user entries ⇒ ours removed, theirs intact key/byte-level, returns true', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    const userEntry = { command: 'node', args: ['user-server.js'], env: { FOO: 'bar' } }
    writeFixtureWithOurEntry(path, { userEntry, topLevelUserKey: 'preserved' })

    const { log } = fakeLog()
    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log })
    expect(removed).toBe(true)

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.mcpServers[LEGACY_CURSOR_WECHAT_MCP_KEY]).toBeUndefined()
    expect(parsed.mcpServers['some-other:server']).toEqual(userEntry)
    expect(parsed.topLevelUserKey).toBe('preserved')
  })

  it('removing our entry leaves an empty mcpServers object rather than deleting the file', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    writeFixtureWithOurEntry(path)

    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log: fakeLog().log })
    expect(removed).toBe(true)

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.mcpServers).toEqual({})
  })

  it('entry absent ⇒ returns false, does not write', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    const initial = { mcpServers: { 'some-other:server': { command: 'node', args: [], env: {} } } }
    const initialText = JSON.stringify(initial, null, 2) + '\n'
    writeFileSync(path, initialText)
    const mtimeBefore = statSync(path).mtimeMs

    const { log, calls } = fakeLog()
    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(initialText)
    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
    void calls
  })

  it('missing file ⇒ returns false, no-op (no error, no write)', () => {
    const { log, calls } = fakeLog()
    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log })
    expect(removed).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('empty (0-byte) file ⇒ nothing to remove, returns false, no write, no corrupted-warning', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp.json'), '')
    const { log, calls } = fakeLog()
    expect(removeCursorGlobalMcp({ cursorConfigDir: dir, log })).toBe(false)
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe('')
    expect(calls.map(c => c.join(' ')).join('\n')).not.toContain('corrupted')
  })

  it('corrupted existing JSON ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    const corrupted = '{ this is not valid json ,,, '
    writeFileSync(path, corrupted)

    const { log, calls } = fakeLog()
    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(corrupted)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('unexpected root shape (not an object) ⇒ does NOT clobber, logs, and returns false', () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    const weird = JSON.stringify(['not', 'an', 'object'])
    writeFileSync(path, weird)

    const { log, calls } = fakeLog()
    const removed = removeCursorGlobalMcp({ cursorConfigDir: dir, log })

    expect(removed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(weird)
    expect(calls.length).toBeGreaterThan(0)
  })

  // TEST-RUNNER GUARD mirror (see agy-mcp-config.ts's equivalent) —
  // omitting cursorConfigDir under vitest must never default to the real
  // ~/.cursor/mcp.json, on the removal path any more than on the old write path.
  it('omitting cursorConfigDir under a test runner skips entirely — never reads/writes, never touches the real ~/.cursor', () => {
    const { log, calls } = fakeLog()
    const removed = removeCursorGlobalMcp({ log })
    expect(removed).toBe(false)
    expect(calls.some(([, line]) => line.includes('skipped under test runner'))).toBe(true)
  })
})
