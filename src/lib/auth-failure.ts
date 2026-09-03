/**
 * auth-failure — 「这是不是登录失效」的**共享词汇表**。
 *
 * 注意:这里刻意**不是**「唯一判定处」。四个使用点的工作不同,精度理应不同:
 *
 *   · core/auth-fail.ts        从 **provider 的输出文本**里认(窄哨兵)——
 *                              它决定要不要抛出 auth_failed,宽了会误报
 *   · core/provider-registry   决定冷却时长 —— 只认结构化码,最窄
 *   · daemon/llm-health        健康探针的报告 —— 码 + 厂商散文
 *   · daemon/health/classify   **决定要不要通知主人** —— 码 + 厂商散文
 *
 * 病不在「有四处」,在于它们是**四条互不知情的散文正则**:没有共享词汇、
 * 没有写明彼此关系,于是必然有几条是旧的。2026-09-02 采集第一遍就照出:
 * classify 的 LLM_AUTH_RE **不含 `auth_failed`** —— 本仓库自己的规范错误码。
 * 于是 claude 登录真死时,唯一决定是否通知主人的那处判成 unknown /
 * actionable:false,主人收到的是「暂时无法正常工作,恢复后会再通知你」——
 * 一句「你等着」,而真相是「只有你能修,它永远不会自己好」。
 *
 * 所以这里给的是**词汇 + 两档精度**,各处按自己的职责选,并写明为什么。
 */

/** 本仓库的规范结构化错误码。assertNotAuthFailed 抛的就是它。 */
export const AUTH_CODE = 'auth_failed'

/** 最窄:只认结构化码。产生它之前,窄哨兵已经确认过一次。 */
const CODE_RE = /\bauth_failed\b/i

/**
 * 厂商散文。**只在已经知道「这是一次失败」之后**才用来加判 —— 单独拿它
 * 去扫正常输出会误报,那正是 claude 那次「登录过期」误报的由来。
 */
const PROSE_RE = /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication|not logged in|login required|credential|unauthenticated|请.*登录/i

/** 只认结构化码(冷却时长这类内部决策用)。 */
export function hasAuthCode(text: unknown): boolean {
  return typeof text === 'string' && CODE_RE.test(text)
}

/** 码 + 厂商散文(要不要通知主人、健康报告这类用)。 */
export function looksLikeAuthFailure(text: unknown): boolean {
  return typeof text === 'string' && (CODE_RE.test(text) || PROSE_RE.test(text))
}

/** provider 失败的闭集。**刻意只有三档** —— 分得越细误分类的机会越多,
 *  而下游真正需要区分的只有「要你动手」和「等一等」。 */
export type ProviderFailureKind = 'auth_failed' | 'transient' | 'unknown'

/**
 * 把一次 provider 失败归档。
 *
 * **歧义一律归 transient,永远不归 auth_failed** —— owner 2026-09-02 定为
 * 通则。它此前是两次个案决定(claude 因宽集误报被收窄回双哨兵;agy 的
 * 「authentication failed or timed out」定为按瞬时处理),现在升成结构:
 *
 *   误报「去重新登录」浪费主人时间、还蚀信任;漏报只是多等一轮重试。
 *   两种错的代价不对称,所以默认必须偏向不打扰。
 *
 * 具体地:一段文本同时像 auth **又**像瞬时(连不上/超时)时,判 transient。
 * agy 那句正是这个形状。
 */
export function classifyProviderFailure(
  errorCode: string | null | undefined,
  message: string,
  isTransient: (text: string) => boolean,
): ProviderFailureKind {
  const text = errorCode ? `${errorCode}: ${message}` : message
  const transient = isTransient(text)
  // 结构化码优先,但**仍然让位给瞬时信号** —— 见上面的不对称代价。
  if (hasAuthCode(text)) return transient ? 'transient' : 'auth_failed'
  if (looksLikeAuthFailure(text)) return transient ? 'transient' : 'auth_failed'
  if (transient) return 'transient'
  return 'unknown'
}
