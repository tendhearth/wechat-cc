import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// INCIDENT GUARD (2026-07-26). A `bun test` run of the whole repo wrote the
// FIXTURE access.json (alice@im.wechat) into the operator's REAL
// ~/.claude/channels/wechat/, silently removing them from `allowFrom` so the
// live bot would have dropped their own WeChat messages. Root cause: tests
// redirect STATE_DIR with vitest's `vi.mock('./config')`; under bun's native
// runner that mock does not reliably apply, so `saveAccess` fell through to
// the real home directory. Reproduced byte-for-byte with a fake $HOME.
//
// The structural fix lives in config.ts: under a test runner, the DEFAULT
// state dir must never be the real home one. These tests pin that contract
// (and that production resolution is unchanged).
const REAL_DEFAULT = join(homedir(), '.claude', 'channels', 'wechat')

/** Resolve STATE_DIR in a fresh child process with a controlled env. Uses
 *  `bun` explicitly (not process.execPath — under a plain `vitest` run that is
 *  node, which can't import this TS module). */
function stateDirIn(env: Record<string, string | undefined>): string {
  return execFileSync(
    'bun',
    ['-e', "import('./src/lib/config').then(m => console.log(m.STATE_DIR))"],
    { cwd: join(import.meta.dirname, '..', '..'), env: { ...process.env, ...env }, encoding: 'utf8' },
  ).trim()
}

describe('STATE_DIR test-runner guard', () => {
  it('never resolves to the real home state dir while a test runner is active', async () => {
    const { STATE_DIR } = await import('./config')
    expect(STATE_DIR).not.toBe(REAL_DEFAULT)
    expect(STATE_DIR.startsWith(tmpdir())).toBe(true)
  })

  it('an explicit WECHAT_STATE_DIR still wins under a test runner', () => {
    const explicit = join(tmpdir(), 'wechat-cc-explicit-state-dir')
    expect(stateDirIn({ NODE_ENV: 'test', WECHAT_STATE_DIR: explicit })).toBe(explicit)
  })

  it('production (no test-runner markers) still resolves the real home state dir', () => {
    expect(stateDirIn({ NODE_ENV: undefined, VITEST: undefined, WECHAT_STATE_DIR: undefined })).toBe(REAL_DEFAULT)
  })
})
