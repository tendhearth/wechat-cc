/**
 * 「这一轮失败是不是因为 CLI 太旧」—— 只读**错误通道**(AgentEvent.error / TurnRecord.error /
 * 工作台 error 事件),从不扫助理正文。
 *
 * 命中的后果很轻:立刻对那个 CLI 做一次版本检查(有更新的再在空闲时升)。所以宁可多命中几次
 * 也别漏;但只认下面这些固定句式,不认含糊的词。来源(docs/reference/provider-error-shapes.md):
 *
 *  - codex(真机采集):`The '<m>' model requires a newer version of Codex. Please upgrade …`
 *    与 `The '<m>' model is not supported when using Codex with a ChatGPT account.`(后者可能是账号
 *    问题,也可能是旧 CLI 拿不到新模型 —— 查一下版本不花什么);工作台码 `execution_model_unsupported`。
 *  - cursor(ACP 带内,§8):整块 `Check your settings to continue` —— cursor-agent 把 BAD_API_KEY /
 *    OUTDATED_CLIENT 并在这一句里,分不开 ⇒ 当「可能是旧客户端」去查版本。
 *  - claude / agy:真机还没采到过「客户端太旧」的原文。下面几句是按 CLI 惯用措辞写的**猜测**,
 *    只会多触发一次版本检查,不会触发任何别的动作;采到真句子后替换掉。
 */
import type { CliId } from './specs'

const CODEX = [
  /requires a newer version of Codex/i,
  /model is not supported when using Codex with a ChatGPT account/i,
]
const CURSOR = [
  /^\s*Check your settings to continue\s*$/,
  /\bOUTDATED_CLIENT\b/,
  /(?:client|cursor[- ]agent)(?: version)? is (?:too old|outdated|out of date)/i,
]
const CLAUDE = [
  /requires a newer version of Claude Code/i,
  /Claude Code (?:is )?(?:out of date|outdated|too old)/i,
  /please (?:update|upgrade) Claude Code/i,
]
const AGY = [
  /requires a newer version of (?:the )?(?:agy|Antigravity)/i,
  /please (?:update|upgrade) (?:the )?(?:agy|Antigravity)/i,
  /(?:agy|Antigravity)(?: CLI)? (?:version )?is (?:no longer supported|out of date|outdated)/i,
]

const PATTERNS: Record<CliId, RegExp[]> = { codex: CODEX, cursor: CURSOR, claude: CLAUDE, agy: AGY }

/** `code` 是边界给的结构化码(工作台的 `execution_model_unsupported` 直接算)。 */
export function outdatedClientSignal(cli: CliId, message: string | null | undefined, code?: string | null): boolean {
  if (cli === 'codex' && code === 'execution_model_unsupported') return true
  if (!message) return false
  const text = message.length > 20_000 ? message.slice(0, 20_000) : message
  return PATTERNS[cli].some(re => re.test(text))
}
