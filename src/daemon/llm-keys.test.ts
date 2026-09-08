import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasLlmKey, saveLlmKey } from './llm-keys'

function dir() { return mkdtempSync(join(tmpdir(), 'llm-keys-')) }

describe('saveLlmKey', () => {
  it('writes the env line (0600, atomic) and the companion config fields; openai needs base_url + model', async () => {
    const d = dir()
    try {
      expect(await saveLlmKey(d, { provider: 'openai', key: 'sk-abc' })).toEqual({ ok: false, error: 'openai_needs_base_url_and_model' })
      expect(await saveLlmKey(d, { provider: 'openai', key: 'sk-abc', base_url: 'https://llm.example/v1', model: 'DeepSeek' })).toEqual({ ok: true, restart_required: true })
      expect(readFileSync(join(d, 'daemon.env'), 'utf8')).toContain('WECHAT_OPENAI_API_KEY=sk-abc')
      const cfg = JSON.parse(readFileSync(join(d, 'agent-config.json'), 'utf8'))
      expect(cfg.openaiBaseUrl).toBe('https://llm.example/v1')
      expect(cfg.openaiModel).toBe('DeepSeek')
      // key-only update is fine once base/model already exist
      expect((await saveLlmKey(d, { provider: 'openai', key: 'sk-new' })).ok).toBe(true)
      expect(readFileSync(join(d, 'daemon.env'), 'utf8')).toContain('sk-new')
      expect(readFileSync(join(d, 'daemon.env'), 'utf8')).not.toContain('sk-abc')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('rejects unknown providers and malformed keys', async () => {
    const d = dir()
    try {
      expect((await saveLlmKey(d, { provider: 'claude', key: 'x' })).ok).toBe(false)
      expect((await saveLlmKey(d, { provider: 'gemini', key: '' })).ok).toBe(false)
      expect((await saveLlmKey(d, { provider: 'gemini', key: 'has space' })).ok).toBe(false)
      expect((await saveLlmKey(d, { provider: 'gemini', key: 'AIza-ok' })).ok).toBe(true)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('hasLlmKey', () => {
  it('reads daemon.env presence without ever returning the value', () => {
    const d = dir()
    try {
      expect(hasLlmKey(d, 'openai')).toBe(false)
      writeFileSync(join(d, 'daemon.env'), 'GEMINI_API_KEY=\nWECHAT_OPENAI_API_KEY="sk-1"\n')
      expect(hasLlmKey(d, 'openai')).toBe(true)
      expect(hasLlmKey(d, 'gemini')).toBe(false)   // present but empty
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
