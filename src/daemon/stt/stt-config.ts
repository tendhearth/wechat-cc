/**
 * STT config — where the daemon reaches the gateway whisper server. Separate
 * file from voice-config.json (TTS) because it's an independent concern with an
 * independent save route. Mirror of tts/voice-config.ts.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface STTConfig {
  provider: 'http_stt'
  base_url: string
  model: string
  api_key?: string
  saved_at: string
}

function configPath(stateDir: string): string {
  return join(stateDir, 'stt-config.json')
}

export function validateSTTConfig(raw: unknown): STTConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (c.provider !== 'http_stt') return null
  if (typeof c.base_url !== 'string' || c.base_url.length < 5) return null
  if (typeof c.model !== 'string' || c.model.length === 0) return null
  if (typeof c.saved_at !== 'string') return null
  return {
    provider: 'http_stt',
    base_url: c.base_url,
    model: c.model,
    api_key: typeof c.api_key === 'string' ? c.api_key : undefined,
    saved_at: c.saved_at,
  }
}

export function loadSTTConfig(stateDir: string): STTConfig | null {
  const p = configPath(stateDir)
  if (!existsSync(p)) return null
  try {
    return validateSTTConfig(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return null
  }
}

export function saveSTTConfig(stateDir: string, cfg: STTConfig): void {
  const p = configPath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, p)
}
