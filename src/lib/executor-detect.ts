/**
 * 执行者「这台机器上有没有」只判一处(3c 第 2 步,设计稿 docs/superpowers/specs/2026-10-22-executor-detect-once-design.md)。
 *
 * 以前对话侧(bootstrap/providers.ts)、工作台(acp/agents.ts、workbench-api.ts)、doctor、guard/targets、
 * cli-upgrade/locate 各判一遍,判法还不一样:配置里的路径是空串,对话侧 `??` 当成配了(于是不注册),
 * 工作台 `||` 回落 PATH(于是注册)。面板清空一格就是空串,所以这不是假设。
 *
 * 定一条:**配置里的值 trim 后是空 = 没配**。规则数据在 executor-facts 的 `detect` 里,这里只读表。
 * 纯函数:找可执行文件、读环境变量都由调用方注入,不碰真机(测试、CLI、daemon 各自给)。
 */
import { EXECUTOR_FACTS, type ExecutorConfigField } from './executor-facts'
import type { KnownProviderId } from './provider-ids'

type BinaryId = 'cursor' | 'agy'
type Env = Readonly<Record<string, string | undefined>>
type ConfigLike = Partial<Record<ExecutorConfigField | 'cursorAgentBin' | 'agyBin', string | undefined>>

const filled = (v: string | undefined): string | null => (v && v.trim() ? v : null)

/** 配置里覆盖的路径(非空)优先,否则在 PATH 上找。找不到 ⇒ null。 */
export function executorBinary(id: BinaryId, config: ConfigLike, findOnPath: (cmd: string) => string | null): string | null {
  const b = EXECUTOR_FACTS[id].detect!.binary!
  return filled(config[b.configKey]) ?? findOnPath(b.name)
}

/** 要的密钥:按 facts 里的顺序取第一个非空的(gemini:GEMINI_API_KEY,其次 GOOGLE_API_KEY)。 */
export function executorCredential(id: KnownProviderId, env: Env): string | null {
  for (const name of EXECUTOR_FACTS[id].credentialEnv ?? []) { const v = filled(env[name]); if (v) return v }
  return null
}

/** agent-config 里还缺哪几格(trim 后为空算缺)。空数组 = 配齐了。 */
export function executorMissingConfig(id: KnownProviderId, config: ConfigLike): ExecutorConfigField[] {
  return (EXECUTOR_FACTS[id].detect?.requiresConfig ?? []).filter(f => !filled(config[f]))
}

/** Cursor 的 API-key 兜底(没装 cursor-agent 时走 @cursor/sdk):要 CURSOR_API_KEY + cursorModel。 */
export const CURSOR_SDK_KEY_ENV = 'CURSOR_API_KEY'
export function cursorSdkFallback(config: ConfigLike, env: Env): { key: string | null; missingModel: boolean } {
  return { key: filled(env[CURSOR_SDK_KEY_ENV]), missingModel: !filled(config.cursorModel) }
}
