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

export type AuthFailChannel = 'assistant-text' | 'sdk-error'

export function isAuthFail(channel: AuthFailChannel, text: string): boolean {
  return (channel === 'assistant-text' ? AUTH_FAIL_ASSISTANT_TEXT : AUTH_FAIL_SDK_ERROR).test(text)
}
