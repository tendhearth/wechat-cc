import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfigSurface, writeConfigKey, CONFIG_SURFACE } from './config-surface'
import { loadAgentConfig } from '../lib/agent-config'
import { loadCompanionConfig } from '../daemon/companion/config'

describe('config surface', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cfg-surface-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('the surface never exposes dangerous keys', () => {
    const keys = CONFIG_SURFACE.map(s => s.key)
    for (const banned of ['dangerouslySkipPermissions', 'agyBin', 'knowledge_embed_script',
                          'knowledge_source_dir', 'mailbox_relays', 'dialogue_lock_hash']) {
      expect(keys).not.toContain(banned)
    }
  })

  it('readConfigSurface returns every whitelisted key with value + metadata', () => {
    const rows = readConfigSurface(stateDir)
    expect(rows.length).toBe(CONFIG_SURFACE.length)
    const model = rows.find(r => r.key === 'model')!
    expect(model.writable).toBe(true)
    expect(model.effect).toBe('immediate')
    const provider = rows.find(r => r.key === 'provider')!
    expect(provider.writable).toBe(false)
    expect(typeof provider.value).toBe('string')   // defaults resolve, never undefined-crash
  })

  it('writes a string key (model) and persists it', async () => {
    const r = await writeConfigKey(stateDir, 'model', 'claude-sonnet-5')
    expect(r).toMatchObject({ ok: true, effect: 'immediate' })
    expect(loadAgentConfig(stateDir).model).toBe('claude-sonnet-5')
  })

  it('coerces booleans from on/off/true/false/开/关', async () => {
    expect((await writeConfigKey(stateDir, 'knowledge_enabled', 'on')).ok).toBe(true)
    expect(loadAgentConfig(stateDir).knowledge_enabled).toBe(true)
    expect((await writeConfigKey(stateDir, 'knowledge_enabled', '关')).ok).toBe(true)
    expect(loadAgentConfig(stateDir).knowledge_enabled).toBe(false)
    const bad = await writeConfigKey(stateDir, 'knowledge_enabled', 'maybe')
    expect(bad).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('enum key rejects out-of-set values', async () => {
    expect((await writeConfigKey(stateDir, 'knowledge_embed_runtime', 'js')).ok).toBe(true)
    expect(loadAgentConfig(stateDir).knowledge_embed_runtime).toBe('js')
    expect(await writeConfigKey(stateDir, 'knowledge_embed_runtime', 'rust')).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('number key (day_tz_offset_minutes): sets int, clears to null on empty, rejects non-int/out-of-range', async () => {
    // 设一个有效偏移(UTC+8 = 480)
    expect((await writeConfigKey(stateDir, 'day_tz_offset_minutes', '480')).ok).toBe(true)
    expect(loadAgentConfig(stateDir).day_tz_offset_minutes).toBe(480)
    // 清空 → null(回到跟随系统)
    expect((await writeConfigKey(stateDir, 'day_tz_offset_minutes', '')).ok).toBe(true)
    expect(loadAgentConfig(stateDir).day_tz_offset_minutes ?? null).toBe(null)
    // 非整数 / 超范围 → 拒绝
    expect(await writeConfigKey(stateDir, 'day_tz_offset_minutes', '8.5')).toMatchObject({ ok: false, error: 'invalid_value' })
    expect(await writeConfigKey(stateDir, 'day_tz_offset_minutes', '9999')).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('companion.* keys route to the companion config store', async () => {
    const r = await writeConfigKey(stateDir, 'companion.import_local_history', 'true')
    expect(r).toMatchObject({ ok: true })
    expect(loadCompanionConfig(stateDir).import_local_history).toBe(true)
  })

  it('bot_name enforces the nickname rule', async () => {
    expect((await writeConfigKey(stateDir, 'bot_name', '小助手')).ok).toBe(true)
    expect(await writeConfigKey(stateDir, 'bot_name', 'x'.repeat(30))).toMatchObject({ ok: false, error: 'invalid_value' })
    expect(await writeConfigKey(stateDir, 'bot_name', 'bad!name')).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('openaiBaseUrl must be an http(s) URL', async () => {
    expect((await writeConfigKey(stateDir, 'openaiBaseUrl', 'https://api.deepseek.com/v1')).ok).toBe(true)
    expect(await writeConfigKey(stateDir, 'openaiBaseUrl', 'file:///etc/passwd')).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('unknown and read-only keys are refused', async () => {
    expect(await writeConfigKey(stateDir, 'dangerouslySkipPermissions', 'true')).toMatchObject({ ok: false, error: 'unknown_key' })
    expect(await writeConfigKey(stateDir, 'provider', 'codex')).toMatchObject({ ok: false, error: 'read_only_key' })
  })

  it('successful write reports the previous value', async () => {
    await writeConfigKey(stateDir, 'model', 'a-model')
    const r = await writeConfigKey(stateDir, 'model', 'b-model')
    expect(r).toMatchObject({ ok: true, previous: 'a-model' })
  })
})
