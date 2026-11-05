/**
 * 同一个事件的键(S3a,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 一件事状态变了,今天有几条路各自去问 CC 开口那道门(App 推送、微信通知、回原对话的回报)。它们问门时带上同一个键,
 * 账(speech_log)上就并成一行(daemon/speech/ledger-store.ts)—— 「同一事件账上一行」由写口保证。
 *  - 等你批准 / 有问题问你:`ask:<matterId>:<requestId>`(请求编号本来就唯一);
 *  - 这一轮做完 / 没做成:`turn:<matterId>:<seq>`(seq = matter_turns 里那一轮,工作台任务和它的 matter 同 id)。
 */
export function askRef(matterId: string, requestId: string): string {
  return `ask:${matterId}:${requestId}`
}

export function turnRef(matterId: string, seq: number): string {
  return `turn:${matterId}:${seq}`
}
