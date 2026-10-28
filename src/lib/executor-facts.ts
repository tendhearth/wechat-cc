/**
 * 每家执行者的「是什么」—— 只写一处(重构第二批步 7,设计稿 docs/superpowers/specs/2026-10-21-executor-descriptor-design.md)。
 *
 * lib 层、零依赖,只有数据:斜杠词、读哪个模型字段、怎么装 / 登录、要哪些密钥环境变量。能力行 / 档位缺口这些带 core 类型的,
 * 由 core 那一层按同一个 id 拼上去(lib 是依赖树的底,不能反过来 import core)。
 * 以前这些散在 provider-policy(斜杠词)、agent-config(模型字段 if 链)、llm-health(安装提示)、llm-keys(密钥名)几处,
 * 写两处的地方已经对不上过(拒绝语叫人发 /openai;agy 换模型写错字段)。
 */
import type { KnownProviderId } from './provider-ids'

export type ModelField = 'model' | 'cursorModel' | 'openaiModel' | 'geminiModel' | 'agyModel'

export interface ExecutorNames {
  /** 正式名字:桌面 / 手机 / App 头像旁、「CC 的连接」里。 */
  name: string
  /** 微信回复前缀、通知里用的短名。 */
  short: string
  /** 设置里要分清「怎么连的」时的写法(`·` 后面那段)。 */
  settings: string
}

export interface ExecutorFacts {
  id: KnownProviderId
  /** 叫什么(收敛清单 ⑥,主人 10-21 定;两种 Gemini 都开时的「Gemini(账号)」在 core/provider-display-names)。 */
  names: ExecutorNames
  /** 微信里切到它的词(/cc、/api …)。 */
  slash: string
  /** agent-config 里它读的模型字段。claude / codex 共用 `model`(只在它是全局默认时才算它的)。 */
  modelField: ModelField
  /** 没接上时告诉主人怎么装 / 登录(中文)。 */
  setupHint: string
  /** 「配齐了才注册」要的密钥环境变量(第一个是写入 daemon.env 时用的名字)。 */
  credentialEnv?: readonly string[]
  /**
   * 「这台机器上有没有」怎么判(3c 第 2 步,2026-10-22)。读它的只有 lib/executor-detect.ts,
   * 别处一律调 detect 那几个函数,不再手写 `cursorAgentBin ?? findOnPath('cursor-agent')`。
   * - binary:自己的可执行文件;configKey 是 agent-config 里覆盖路径的那一格(空串 = 没配,回落 PATH)。
   * - requiresConfig:agent-config 里必须非空(trim 后)的字段。
   */
  detect?: {
    binary?: { name: string; configKey: 'cursorAgentBin' | 'agyBin' }
    requiresConfig?: readonly ExecutorConfigField[]
  }
  /**
   * 没给 base URL 时它真正连的 API host(3c 第 4 步,2026-10-23)。网络探测(daemon/net-probe)、调用分类
   * (lib/call-classifier → 网络守护)都从这里取,不再各写一份 —— 以前三份里 agy / cursor 的 host 就对不上。
   * `source`:这个 host 是怎么知道的。「抓包」= 真机跑一次、看它实际连了哪;没抓过的照实写「未抓包」。
   */
  endpoint: { host: string; source: string }
}

export type ExecutorConfigField = 'openaiBaseUrl' | 'openaiModel' | 'geminiModel' | 'cursorModel'

export const EXECUTOR_FACTS: Readonly<Record<KnownProviderId, ExecutorFacts>> = {
  claude: { id: 'claude', names: { name: 'Claude', short: 'Claude', settings: 'Claude' }, slash: 'cc', modelField: 'model', setupHint: '安装 Claude Code 并在终端登录一次(claude)', endpoint: { host: 'api.anthropic.com', source: '官方 API 文档;未抓包' } },
  codex: { id: 'codex', names: { name: 'Codex', short: 'Codex', settings: 'Codex' }, slash: 'codex', modelField: 'model', setupHint: '安装 codex CLI 并登录一次', endpoint: { host: 'api.openai.com', source: '官方 API 文档;未抓包(ChatGPT 账号登录时可能走 chatgpt.com,待核)' } },
  cursor: { id: 'cursor', names: { name: 'Cursor', short: 'Cursor', settings: 'Cursor' }, slash: 'cursor', modelField: 'cursorModel', setupHint: '终端跑:curl https://cursor.com/install -fsS | bash,然后 cursor-agent login(用 Cursor 订阅账号)', detect: { binary: { name: 'cursor-agent', configKey: 'cursorAgentBin' } }, endpoint: { host: 'api2.cursor.sh', source: '抓包 2026-10-23:cursor-agent 2026.10.22 -p 一轮,连 api2.cursor.sh 与 api3.cursor.sh(另有几个遥测地址)' } },
  // 「/api」不是 /openai:这是主人自己的 API 端点(DeepSeek / Kimi / Qwen …),不绑哪家厂商。
  openai: { id: 'openai', names: { name: '自定义 AI 服务', short: 'API', settings: '自定义 AI 服务' }, slash: 'api', modelField: 'openaiModel', setupHint: '把 WECHAT_OPENAI_API_KEY 写进 ~/.claude/channels/wechat/daemon.env,并配置 openaiBaseUrl/openaiModel', credentialEnv: ['WECHAT_OPENAI_API_KEY'], detect: { requiresConfig: ['openaiBaseUrl', 'openaiModel'] }, endpoint: { host: 'api.openai.com', source: '没配 openaiBaseUrl 时的缺省;实际几乎总是主人自配的网关' } },
  gemini: { id: 'gemini', names: { name: 'Gemini', short: 'Gemini', settings: 'Gemini · 密钥连接' }, slash: 'gemini', modelField: 'geminiModel', setupHint: '把 GEMINI_API_KEY 写进 ~/.claude/channels/wechat/daemon.env', credentialEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], detect: { requiresConfig: ['geminiModel'] }, endpoint: { host: 'generativelanguage.googleapis.com', source: 'Gemini API(密钥)官方端点;未抓包' } },
  agy: { id: 'agy', names: { name: 'Gemini', short: 'Gemini', settings: 'Gemini · 账号连接' }, slash: 'agy', modelField: 'agyModel', setupHint: '安装 Antigravity CLI(agy)并登录一次(Google AI Pro 订阅)', detect: { binary: { name: 'agy', configKey: 'agyBin' } }, endpoint: { host: 'daily-cloudcode-pa.googleapis.com', source: '抓包 2026-10-23:agy -p 一轮,连 daily-cloudcode-pa.googleapis.com(另有 www.googleapis.com、antigravity-unleash.goog、play.googleapis.com);不是以前写的 cloudcode-pa / generativelanguage' } },
}
