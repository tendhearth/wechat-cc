import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSTTConfig, saveSTTConfig, validateSTTConfig } from './stt-config'

describe('stt-config', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stt-cfg-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })

  it('returns null when absent', () => {
    expect(loadSTTConfig(dir)).toBeNull()
  })

  it('save + load round-trips (api_key optional)', () => {
    saveSTTConfig(dir, { provider: 'http_stt', base_url: 'http://vps:8001/v1/audio/transcriptions', model: 'whisper-small', saved_at: '2026-07-11T00:00:00Z' })
    const c = loadSTTConfig(dir)
    expect(c).toMatchObject({ provider: 'http_stt', base_url: 'http://vps:8001/v1/audio/transcriptions', model: 'whisper-small' })
    expect(c!.api_key).toBeUndefined()
  })

  it('validate rejects missing base_url / model / wrong provider', () => {
    expect(validateSTTConfig({ provider: 'http_stt', model: 'm', saved_at: 'x' })).toBeNull()
    expect(validateSTTConfig({ provider: 'http_stt', base_url: 'http://vps', saved_at: 'x' })).toBeNull()
    expect(validateSTTConfig({ provider: 'qwen', base_url: 'http://vps', model: 'm', saved_at: 'x' })).toBeNull()
    expect(validateSTTConfig('not an object')).toBeNull()
  })

  it('validate keeps api_key when present', () => {
    const c = validateSTTConfig({ provider: 'http_stt', base_url: 'http://vps', model: 'm', api_key: 'sk', saved_at: 'x' })
    expect(c!.api_key).toBe('sk')
  })
})
