/**
 * reply-tail.ts —「说完了还在发」的尾巴识别(openai provider 自有循环用)。
 *
 * 背景(2026-10-02,docs/reference/reply-once-experiment.md):这个循环里一轮结束的唯一方式是
 * 「某一步不调工具」。Qwen3.8 在同一会话里一轮比一轮多发 reply,发到后来全是
 * 「（停，不再发了 😅）」「（真的停了）」—— 它在模仿上文里自己的连发。三条路都试过不管用:
 * 回执里加收手提示(#186,反而去调别的工具,#189 撤回)、系统提示写清怎么结束、
 * reply 之后只给 reply 工具。唯一稳定有效的是循环侧:本轮已经成功发出过话之后,
 * 如果下一步**只是** reply、而且每条都是这类尾巴,就不发、不进历史、直接结束这一轮。
 *
 * 这里只判「这一条是不是尾巴」,纯函数。判得保守:
 *  - 整条包在括号里的短旁白(「（真的停了）」「(🤫)」)—— 正经气泡几乎不会整条是一句括号;
 *  - 很短、且带「停了 / 不再发 / 多发了 / 刷屏…」字样的收尾话;
 *  - 与本轮已发出的某条(去掉标点空白后)一模一样的重复。
 * 「停车场在 B2」这类正经短句、带「停」字的长句都不算;本轮第一条永远不判。
 */

/** 收尾话的字样 —— 只在短句里才算(见 SHORT_META_MAX)。 */
// 不用单字「停」:「停车场在 B2」是正经回答。
const META_RE = /^停$|停了|停止发|不再发|不发了|别发了|多发了|又多了|刷屏|不追加|不补了|就到这|打住|最后一条|只回这/

/** 去掉标点、符号(含 emoji)、空白后不超过这么多字,才按字样判收尾。 */
const SHORT_META_MAX = 16
/** 整条括号旁白也只认短的:长的括号补充(「(补充:链接在…)」)是正经内容。 */
const SHORT_PAREN_MAX = 24

const PAREN_WRAPPED = /^[(（[【].*[)）\]】]$/su

function normalize(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * `text` 是不是本轮已经发过话之后的多余尾巴。`prior` = 本轮已经**成功发出**的回复文本;
 * 空 ⇒ 永远 false(本轮第一条照发)。
 */
export function isReplyTail(text: string, prior: readonly string[]): boolean {
  if (prior.length === 0) return false
  const trimmed = text.trim()
  const core = normalize(trimmed)
  if (core.length === 0) return true // 只剩标点 / emoji,如「……」「（🤫）」
  if (core.length <= SHORT_PAREN_MAX && PAREN_WRAPPED.test(trimmed)) return true
  if (core.length <= SHORT_META_MAX && META_RE.test(core)) return true
  return prior.some(p => normalize(p) === core)
}
