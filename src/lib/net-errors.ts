/**
 * net-errors — 「这是一次连不上」的**唯一判定处**。
 *
 * WHY(2026-09-02 真机):owner 在微信里派活,收到
 *
 *   派活失败:Was there a typo in the url or port?
 *
 * 那台手当时瞬时掉线,真实原因是「对方现在连不上」。而 admin-commands 里
 * **本来就有**一条「连不上」分支 —— 它照着 **Node 的错误词汇**写的
 * (fetch failed / ECONNREFUSED / ENOTFOUND),而这个 daemon 跑在 **Bun** 上,
 * Bun 说的是另一套话。分支形同虚设,原始串直通用户,读起来像在说他 URL
 * 打错了。
 *
 * 同一个缺口当时还在另外三处:health/classify(把连接失败误判成非网络问题)、
 * http-tts、http-stt。**一处判定散成四份正则,就一定会有几份是旧的** ——
 * 所以收敛到这里,新的措辞只加一次。
 *
 * 下面每一条 Bun 措辞都是这一轮真机日志里**实际出现过**的,不是想象的。
 */

/** 连接层失败的措辞(Node + Bun 两套)。故意只覆盖「连不上」,不含 TLS/超时。 */
export const CONNECT_FAILURE_SOURCE = [
  // Node / libuv
  'fetch failed', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH',
  // Bun —— 真机日志里出现过的原文
  'typo in the url or port',
  'unable to connect',
  'connection ?refused',
  'failed to connect',
  'socket hang up',
].join('|')

const CONNECT_RE = new RegExp(CONNECT_FAILURE_SOURCE, 'i')

/** 这段错误文本是不是「连不上对方」。 */
export function isConnectFailure(text: unknown): boolean {
  return typeof text === 'string' && CONNECT_RE.test(text)
}
