import { describe, expect, it } from 'vitest'

describe('peekCleanShutdown:只读不删(开机还要 consume 它)', () => {
  it('读得到 pid / ts,读完纸条还在;没有 / 坏的 ⇒ null', async () => {
    const { mkdtempSync, existsSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { peekCleanShutdown, markCleanShutdown, CLEAN_SHUTDOWN_FILE } = await import('./restart-markers')
    const dir = mkdtempSync(join(tmpdir(), 'peek-clean-'))
    expect(peekCleanShutdown(dir)).toBeNull()
    markCleanShutdown(dir, 'SIGTERM', 4242, 1000)
    expect(peekCleanShutdown(dir)).toEqual({ cause: 'SIGTERM', pid: 4242, ts: 1000 })
    expect(existsSync(join(dir, CLEAN_SHUTDOWN_FILE))).toBe(true)
    writeFileSync(join(dir, CLEAN_SHUTDOWN_FILE), '{"cause":"x"}')
    expect(peekCleanShutdown(dir)).toBeNull()
  })
})
