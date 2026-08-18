/**
 * auth-fail 判别的唯一来源(spec §1b)。双 profile 而非单一常量 —— 分歧有
 * 真实原因:窄集跑在【合法模型输出】上(裸 OPENAI_API_KEY 会误伤引用它的
 * 正常回答);宽集跑在【SDK 错误通道】上(错误消息里出现裸 OPENAI_API_KEY
 * 就是认证问题)。新增候选词必须注明归属通道及原因。
 */

/** 窄集:原 agent-provider.ts 的超集正则原样迁移(error-shape phrases only)。 */
export const AUTH_FAIL_ASSISTANT_TEXT =
  /(Please run \/login|Not logged in|not authenticated|401 unauthorized|please run `?codex login|OPENAI_API_KEY (?:not|is not|missing|required)|auth(?:entication)?\s+(?:expired|failed))/i

/** 宽集:原 codex 私有正则,吸收 claude 的两个 sentinel 词。 */
export const AUTH_FAIL_SDK_ERROR =
  /(Please run \/login|Not logged in|OPENAI_API_KEY|not authenticated|401 unauthorized|codex login|auth.*expired)/i

/**
 * claude 专属窄集(仅两个 sentinel 词)。claude 二进制凭证失败只输出这两句
 * (源自其 string table 的既有验证);流内混有模型正文,曾经把它加宽到
 * assistant-text 全集(spec §1b 的"刻意的行为变化"),但真机探测证明这是
 * 误判:'你这个 curl 返回 401 unauthorized,说明 token 过期了…' 这类合法地
 * 引用/复述认证错误的正文,会被 assistant-text 集里的 '401 unauthorized'、
 * 'auth...expired' 等短语命中,导致会话被误释放、向用户发出虚假的"登录过期"
 * 通知——而且零真阳性收益(claude 二进制从不会真的输出这些短语)。因此收窄
 * 回专属的两句 sentinel,不复用 assistant-text 宽集。
 */
export const AUTH_FAIL_CLAUDE_SENTINEL = /(Please run \/login|Not logged in)/i

export type AuthFailChannel = 'assistant-text' | 'sdk-error' | 'claude-sentinel'

export function isAuthFail(channel: AuthFailChannel, text: string): boolean {
  const pattern =
    channel === 'assistant-text' ? AUTH_FAIL_ASSISTANT_TEXT :
    channel === 'claude-sentinel' ? AUTH_FAIL_CLAUDE_SENTINEL :
    AUTH_FAIL_SDK_ERROR
  return pattern.test(text)
}

/**
 * 结构化判别:HTTP 401 是认证失败的权威信号,比正则可靠(真实网关的
 * 错误文案五花八门 —— Kimi 网关实测 401 文本不含任何宽集短语)。
 * 消息正则(sdk-error 宽集)保留为兜底。
 */
export function isAuthFailError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { statusCode?: unknown }).statusCode ?? (err as { status?: unknown }).status
    if (status === 401) return true
  }
  return err instanceof Error && isAuthFail('sdk-error', err.message)
}
