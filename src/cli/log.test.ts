import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runLogCommand } from './log.ts'

// Disable file I/O in log.ts so tests never touch the real STATE_DIR.
// The env var is honoured by src/lib/log.ts (FILE_DISABLED gate).
beforeEach(() => {
  process.env['WECHAT_DISABLE_LOG_FILE'] = '1'
})
afterEach(() => {
  delete process.env['WECHAT_DISABLE_LOG_FILE']
})

describe('runLogCommand', () => {
  it('returns { ok: true } for a bare tag + msg (no --fields)', () => {
    const result = runLogCommand({ tag: 'TEST', msg: 'hello' })
    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: true } when --fields is a valid JSON object', () => {
    const result = runLogCommand({
      tag: 'RECONNECT_DIAGNOSE',
      msg: 'code=1 provider=claude',
      fieldsJson: JSON.stringify({ code: 1, daemon_alive: false, provider: 'claude' }),
    })
    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: true } when --fields is an empty JSON object', () => {
    const result = runLogCommand({
      tag: 'TEST',
      msg: 'empty fields',
      fieldsJson: '{}',
    })
    expect(result).toEqual({ ok: true })
  })

  it('throws TypeError on malformed JSON in --fields', () => {
    expect(() =>
      runLogCommand({ tag: 'TEST', msg: 'bad', fieldsJson: '{not valid json' })
    ).toThrow(TypeError)
  })

  it('throws TypeError with a descriptive message on malformed JSON', () => {
    expect(() =>
      runLogCommand({ tag: 'TEST', msg: 'bad', fieldsJson: 'not-json' })
    ).toThrow('--fields must be valid JSON')
  })

  it('throws TypeError when --fields parses to a JSON array (not an object)', () => {
    expect(() =>
      runLogCommand({ tag: 'TEST', msg: 'array fields', fieldsJson: '[1, 2, 3]' })
    ).toThrow('--fields must be a JSON object')
  })

  it('throws TypeError when --fields parses to a primitive string', () => {
    expect(() =>
      runLogCommand({ tag: 'TEST', msg: 'string fields', fieldsJson: '"just a string"' })
    ).toThrow('--fields must be a JSON object')
  })

  it('throws TypeError when --fields parses to null', () => {
    expect(() =>
      runLogCommand({ tag: 'TEST', msg: 'null fields', fieldsJson: 'null' })
    ).toThrow('--fields must be a JSON object')
  })

  it('accepts all 6 RECONNECT_DIAGNOSE field keys without error', () => {
    const fields = {
      code: 1,
      daemon_alive: false,
      service_installed: true,
      provider: 'claude',
      lastError_present: true,
      health_ok: null,
    }
    const result = runLogCommand({
      tag: 'RECONNECT_DIAGNOSE',
      msg: `code=${fields.code} provider=${fields.provider}`,
      fieldsJson: JSON.stringify(fields),
    })
    expect(result).toEqual({ ok: true })
  })
})
