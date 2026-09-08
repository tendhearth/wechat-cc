/**
 * LLM API key 落盘 —— daemon 自己写 daemon.env(0600,原子替换),用户永远
 * 不用知道那个文件存在。桌面「大脑卡」的 POST /v1/llm/keys 和设置面板的
 * 「模型与后端」表单共用这一处;值绝不进日志。
 *
 * openai 兼容接口要 base_url + model 都在才会注册(bootstrap/providers.ts),
 * 只写 key 会「保存成功」却重启后没接上 —— 假成功。按「本次带的 或 之前
 * 已存的」算有效值,缺任一就拒、不写 key。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { upsertEnvFile } from '../lib/env-file'
import { loadAgentConfig } from '../lib/agent-config'
import { writeConfigKey } from './config-surface'

export type LlmKeyProvider = 'openai' | 'gemini'

export const LLM_KEY_ENV: Record<LlmKeyProvider, string> = {
  openai: 'WECHAT_OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

export type SaveLlmKeyResult =
  | { ok: true; restart_required: true }
  | { ok: false; error: 'unsupported_provider' | 'invalid_key' | 'openai_needs_base_url_and_model' }

export async function saveLlmKey(
  stateDir: string,
  input: { provider?: unknown; key?: unknown; base_url?: unknown; model?: unknown },
  log?: (tag: string, line: string) => void,
): Promise<SaveLlmKeyResult> {
  const provider = input.provider
  if (provider !== 'openai' && provider !== 'gemini') return { ok: false, error: 'unsupported_provider' }
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (key === '' || key.length > 500 || /\s/.test(key)) return { ok: false, error: 'invalid_key' }
  const reqBase = typeof input.base_url === 'string' ? input.base_url.trim() : ''
  const reqModel = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === 'openai') {
    const existing = loadAgentConfig(stateDir)
    if (!(reqBase || existing.openaiBaseUrl) || !(reqModel || existing.openaiModel)) {
      return { ok: false, error: 'openai_needs_base_url_and_model' }
    }
  }
  const envName = LLM_KEY_ENV[provider]
  const envPath = join(stateDir, 'daemon.env')
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const tmp = `${envPath}.tmp`
  writeFileSync(tmp, upsertEnvFile(current, { [envName]: key }), { mode: 0o600 })
  renameSync(tmp, envPath)
  // 伴随字段走带校验的 config surface。
  if (provider === 'openai') {
    if (reqBase) await writeConfigKey(stateDir, 'openaiBaseUrl', reqBase)
    if (reqModel) await writeConfigKey(stateDir, 'openaiModel', reqModel)
  } else if (reqModel) {
    await writeConfigKey(stateDir, 'geminiModel', reqModel)
  }
  log?.('LLM_HEALTH', `${envName} saved (value not logged) — restart to register`)
  return { ok: true, restart_required: true }
}

/** 这家的 key 配了吗(daemon.env 或当前进程 env)。只回 boolean,永不回值。 */
export function hasLlmKey(stateDir: string, provider: LlmKeyProvider): boolean {
  const envName = LLM_KEY_ENV[provider]
  if (process.env[envName]) return true
  const envPath = join(stateDir, 'daemon.env')
  if (!existsSync(envPath)) return false
  try {
    return readFileSync(envPath, 'utf8').split('\n').some(l => {
      const t = l.trim()
      if (!t.startsWith(envName + '=')) return false
      const v = t.slice(envName.length + 1).trim().replace(/^["']|["']$/g, '')
      return v.length > 0
    })
  } catch { return false }
}
