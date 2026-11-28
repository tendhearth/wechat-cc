import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoshipStore, parseInstalledVersion } from './self-autoship-runtime'

const sha = 'b'.repeat(40)

describe('autoship persistence', () => {
  it('persists single-line rounds and independent safety state at 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-autoship-'))
    try {
      const store = autoshipStore(dir)
      expect(store.lastRound()).toBeNull()
      expect(store.loadState()).toEqual({ failedShas: [], redShas: [], fail_streak: 0, halted_at: null, halt_reason: null })
      const halt = { failedShas: [sha], redShas: [sha], fail_streak: 2, halted_at: 3, halt_reason: '失败两次' }
      const round = { sha, at: '2026-11-27T00:00:00.000Z', exitCode: 1, message: '阶段失败\n已回滚' }
      store.saveState(halt)
      store.saveRound(round)
      store.saveRound({ ...round, exitCode: 2, message: '持锁\n跳过' })
      const reopened = autoshipStore(dir)
      expect(reopened.loadState()).toEqual(halt)
      expect(reopened.lastRound()).toEqual({ ...round, exitCode: 2, message: '持锁\n跳过' })
      for (const name of ['autoship.json', 'autoship-state.json']) {
        const path = join(dir, 'self-change', name)
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(2)
      }

      writeFileSync(join(dir, 'self-change', 'autoship-state.json'), '{bad')
      expect(() => reopened.loadState()).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('accepts a sidecar commit suffix and leaves unstamped versions unknown', () => {
    expect(parseInstalledVersion('1.8.12 (832d27d03)\n')).toEqual({ version: '1.8.12 (832d27d03)', sha: '832d27d03' })
    expect(parseInstalledVersion('1.8.12')).toEqual({ version: '1.8.12', sha: null })
  })
})
