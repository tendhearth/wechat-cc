import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { findOnPath, probeBinaryVersion } from './util'

// Mock spawnSync to avoid PATH-dependent test failures
vi.mock('child_process')

describe('findOnPath', () => {
  it('returns the first line from which/where output when status is 0', () => {
    const mockSpawnSync = spawnSync as any
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from('/usr/local/bin/bun\n/usr/bin/bun\n'),
    })

    const result = findOnPath('bun')
    expect(result).toBe('/usr/local/bin/bun')
  })

  it('returns null for a nonexistent command', () => {
    const mockSpawnSync = spawnSync as any
    mockSpawnSync.mockReturnValue({
      status: 127,
      stdout: null,
    })

    expect(findOnPath('definitely-not-a-real-command-xyzzy-42')).toBeNull()
  })

  it('returns null for empty string', () => {
    const mockSpawnSync = spawnSync as any
    mockSpawnSync.mockReturnValue({
      status: 127,
      stdout: null,
    })

    expect(findOnPath('')).toBeNull()
  })

  it('returns null when stdout is empty', () => {
    const mockSpawnSync = spawnSync as any
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
    })

    expect(findOnPath('some-cmd')).toBeNull()
  })
})

describe('probeBinaryVersion', () => {
  it('passes an augmented PATH to spawned shims', () => {
    const mockSpawnSync = spawnSync as any
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from('codex-cli 0.128.0\n'),
    })

    expect(probeBinaryVersion('/tmp/codex.js')).toBe('codex-cli 0.128.0')

    const options = mockSpawnSync.mock.calls.at(-1)?.[2]
    expect(options.env.PATH).toEqual(expect.any(String))
    expect(options.env.PATH.length).toBeGreaterThan(0)
  })
})
