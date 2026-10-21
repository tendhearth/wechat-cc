import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordBootFailure, clearBootFailures, BOOT_FAILURE_FILE, BOOT_BACKOFF_MAX_MS } from './boot-backoff'

const dir = () => mkdtempSync(join(tmpdir(), 'boot-backoff-'))
describe('boot failure backoff(重构第二批步 6a)', () => {
  it('consecutive failures wait 10s, 20s, 40s … capped at 30 min (launchd / systemd only throttle linearly)', () => {
    const d = dir(); let now = 1_000_000
    const delays = Array.from({ length: 12 }, () => { const r = recordBootFailure(d, now); now += r.delayMs + 10_000; return r.delayMs })
    expect(delays.slice(0, 4)).toEqual([10_000, 20_000, 40_000, 80_000])
    expect(Math.max(...delays)).toBe(BOOT_BACKOFF_MAX_MS)
    expect(BOOT_BACKOFF_MAX_MS).toBe(30 * 60_000)
  })
  it('a successful boot clears the counter; a long quiet gap (> 1h since last failure) starts over', () => {
    const d = dir()
    recordBootFailure(d, 0); recordBootFailure(d, 1)
    clearBootFailures(d)
    expect(existsSync(join(d, BOOT_FAILURE_FILE))).toBe(false)
    expect(recordBootFailure(d, 2).delayMs).toBe(10_000)
    expect(recordBootFailure(d, 3).delayMs).toBe(20_000)
    expect(recordBootFailure(d, 3 + 2 * 3600_000).delayMs).toBe(10_000)
  })
  it('a corrupt counter file is treated as no history, never throws', () => {
    const d = dir()
    writeFileSync(join(d, BOOT_FAILURE_FILE), '{not json')
    expect(recordBootFailure(d, 0)).toEqual({ count: 1, delayMs: 10_000 })
  })
})
