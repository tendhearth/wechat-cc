/**
 * Config surface — the WHITELIST of daemon configuration an agent may read
 * and (for writable keys) change on the owner's behalf, backing the
 * admin-only config_get/config_set MCP tools (2026-08-23 decision:
 * conversational config instead of a WeChat settings page).
 *
 * The whitelist IS the security boundary: anything not listed here is
 * invisible to the tools — notably dangerouslySkipPermissions, every
 * path-shaped key (agyBin / knowledge_embed_script / knowledge_source_dir —
 * paths are a code-execution / data-exfil surface), access control, and
 * transport config (a2a_* / yi_* / mailbox_relays / dialogue_lock_hash).
 * Add a key ONLY with an explicit validate rule and effect annotation.
 *
 * Values are accepted as strings from the tool layer and coerced per type
 * (booleans accept on/off/true/false/开/关). `effect` tells the agent — and
 * through it the owner — when the change actually lands: models hot-reload
 * per spawn (mtime-cached readers), knowledge/social wiring happens at boot.
 */
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from './agent-config'
import { loadCompanionConfig, saveCompanionConfig, type CompanionConfig } from '../daemon/companion/config'
import { NICKNAME_RE } from '../daemon/nickname'

export type ConfigEffect = 'immediate' | 'daemon-restart' | 'next-tick' | 'reinstall'

const MODEL_RE = /^[\w.\-:\/]{1,100}$/
const URL_RE = /^https?:\/\/\S{1,200}$/

interface ConfigKeySpec {
  key: string
  store: 'agent' | 'companion'
  field: keyof AgentConfig | keyof CompanionConfig
  type: 'string' | 'boolean' | 'enum'
  values?: readonly string[]
  writable: boolean
  effect: ConfigEffect
  description: string
  /** Extra guard for string keys — runs after the type coercion. */
  validate?: (v: string) => boolean
}

export const CONFIG_SURFACE: readonly ConfigKeySpec[] = [
  { key: 'provider', store: 'agent', field: 'provider', type: 'string', writable: false,
    effect: 'daemon-restart', description: '默认 provider（切换用 /cc /codex 等命令，不在这里改）' },
  { key: 'bot_name', store: 'agent', field: 'bot_name', type: 'string', writable: true,
    effect: 'immediate', description: '我的名字（1-24 字符，中英文/数字/空格/_-）',
    validate: (v) => v.length <= 24 && NICKNAME_RE.test(v) },
  { key: 'model', store: 'agent', field: 'model', type: 'string', writable: true,
    effect: 'immediate', description: 'Claude 模型 id', validate: (v) => MODEL_RE.test(v) },
  { key: 'openaiModel', store: 'agent', field: 'openaiModel', type: 'string', writable: true,
    effect: 'immediate', description: 'OpenAI 兼容后端的模型 id', validate: (v) => MODEL_RE.test(v) },
  { key: 'geminiModel', store: 'agent', field: 'geminiModel', type: 'string', writable: true,
    effect: 'immediate', description: 'Gemini 模型 id', validate: (v) => MODEL_RE.test(v) },
  { key: 'cursorModel', store: 'agent', field: 'cursorModel', type: 'string', writable: true,
    effect: 'immediate', description: 'Cursor 模型 id', validate: (v) => MODEL_RE.test(v) },
  { key: 'agyModel', store: 'agent', field: 'agyModel', type: 'string', writable: true,
    effect: 'immediate', description: 'agy (Antigravity) 模型 id', validate: (v) => MODEL_RE.test(v) },
  { key: 'openaiBaseUrl', store: 'agent', field: 'openaiBaseUrl', type: 'string', writable: true,
    effect: 'immediate', description: 'OpenAI 兼容后端地址 (http(s) URL)', validate: (v) => URL_RE.test(v) },
  { key: 'knowledge_enabled', store: 'agent', field: 'knowledge_enabled', type: 'boolean', writable: true,
    effect: 'daemon-restart', description: '知识内核（微信档案向量检索/图谱/事实库）总开关' },
  { key: 'knowledge_embed_runtime', store: 'agent', field: 'knowledge_embed_runtime', type: 'enum',
    values: ['python', 'js'], writable: true, effect: 'daemon-restart',
    description: '嵌入模型运行时 (python 子进程 / js 进程内)' },
  { key: 'social_enabled', store: 'agent', field: 'social_enabled', type: 'boolean', writable: true,
    effect: 'daemon-restart', description: 'agent 社交（觅食/牵线）开关，需同时配置 disclosure policy' },
  { key: 'social_disclosure_policy', store: 'agent', field: 'social_disclosure_policy', type: 'string',
    writable: true, effect: 'daemon-restart', description: '社交披露政策（自由文本，如"兴趣可说;住址不可"）',
    validate: (v) => v.length >= 1 && v.length <= 500 },
  { key: 'autoStart', store: 'agent', field: 'autoStart', type: 'boolean', writable: true,
    effect: 'reinstall', description: '开机自启（下次 service install 时生效）' },
  { key: 'closeStopsDaemon', store: 'agent', field: 'closeStopsDaemon', type: 'boolean', writable: true,
    effect: 'immediate', description: '关闭桌面窗口是否同时停掉 daemon' },
  { key: 'companion.default_chat_id', store: 'companion', field: 'default_chat_id', type: 'string',
    writable: false, effect: 'immediate', description: '主人聊天 id（陪伴/introspect 的锚点，不在这里改）' },
  { key: 'companion.import_local_history', store: 'companion', field: 'import_local_history',
    type: 'boolean', writable: true, effect: 'next-tick',
    description: '导入本地历史 + 24h 自动整理 _overview.md 的开关' },
]

const TRUE_WORDS = new Set(['on', 'true', '1', 'yes', '开', '是'])
const FALSE_WORDS = new Set(['off', 'false', '0', 'no', '关', '否'])

export interface ConfigSurfaceRow {
  key: string
  value: string | boolean | null
  type: 'string' | 'boolean' | 'enum'
  values?: readonly string[]
  writable: boolean
  effect: ConfigEffect
  description: string
}

export function readConfigSurface(stateDir: string): ConfigSurfaceRow[] {
  const agent = loadAgentConfig(stateDir)
  const companion = loadCompanionConfig(stateDir)
  return CONFIG_SURFACE.map((s) => {
    const raw = s.store === 'agent'
      ? (agent as unknown as Record<string, unknown>)[s.field as string]
      : (companion as unknown as Record<string, unknown>)[s.field as string]
    const value = raw === undefined || raw === null
      ? null
      : (typeof raw === 'boolean' ? raw : String(raw))
    return {
      key: s.key, value, type: s.type,
      ...(s.values ? { values: s.values } : {}),
      writable: s.writable, effect: s.effect, description: s.description,
    }
  })
}

export type WriteConfigResult =
  | { ok: true; key: string; effect: ConfigEffect; previous: string | boolean | null }
  | { ok: false; error: 'unknown_key' | 'read_only_key' | 'invalid_value'; detail?: string }

export async function writeConfigKey(
  stateDir: string,
  key: string,
  value: unknown,
): Promise<WriteConfigResult> {
  const spec = CONFIG_SURFACE.find((s) => s.key === key)
  if (!spec) return { ok: false, error: 'unknown_key' }
  if (!spec.writable) return { ok: false, error: 'read_only_key' }

  const rawStr = typeof value === 'boolean' ? String(value) : String(value ?? '').trim()
  let coerced: string | boolean
  if (spec.type === 'boolean') {
    const lower = rawStr.toLowerCase()
    if (TRUE_WORDS.has(lower)) coerced = true
    else if (FALSE_WORDS.has(lower)) coerced = false
    else return { ok: false, error: 'invalid_value', detail: '布尔值请用 on/off/true/false/开/关' }
  } else if (spec.type === 'enum') {
    if (!spec.values!.includes(rawStr)) {
      return { ok: false, error: 'invalid_value', detail: `可选值: ${spec.values!.join(' | ')}` }
    }
    coerced = rawStr
  } else {
    if (rawStr.length === 0) return { ok: false, error: 'invalid_value', detail: '不能为空' }
    if (spec.validate && !spec.validate(rawStr)) {
      return { ok: false, error: 'invalid_value', detail: spec.description }
    }
    coerced = rawStr
  }

  if (spec.store === 'agent') {
    const cfg = loadAgentConfig(stateDir)
    const previous = (cfg as unknown as Record<string, unknown>)[spec.field as string]
    saveAgentConfig(stateDir, { ...cfg, [spec.field]: coerced } as AgentConfig)
    return { ok: true, key, effect: spec.effect, previous: normalizePrev(previous) }
  }
  const cfg = loadCompanionConfig(stateDir)
  const previous = (cfg as unknown as Record<string, unknown>)[spec.field as string]
  await saveCompanionConfig(stateDir, { ...cfg, [spec.field]: coerced } as CompanionConfig)
  return { ok: true, key, effect: spec.effect, previous: normalizePrev(previous) }
}

function normalizePrev(v: unknown): string | boolean | null {
  if (v === undefined || v === null) return null
  return typeof v === 'boolean' ? v : String(v)
}
