// 状态词按手机端用词表(docs/reference/phone-wording.md):在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。
// interrupted(daemon 重启打断)是「停下了」不是「没做成」:没人说它做错了。
import { STATUS_WORDS, TASK_DETAIL_WORDS, statusOf, type StatusKey, type TaskObservation } from '@wechat-cc/protocol'
export type { StatusKey }
// 状态判定在协议包(packages/protocol/src/status-of.ts),daemon 的「在做」名单与 App 共用同一份。
export { isMatterArchived, statusOf, statusOfMatter, terminalStatusKey } from '@wechat-cc/protocol'


/** Detail observations share wording with desktop; connectivity has its own UI. */
export function taskDetailLabel(task: TaskObservation | null | undefined, pending: number, lang: 'en' | 'zh-Hans', fallback: StatusKey = 'working'): string {
  const status = task ? statusOf(task, pending) : fallback
  const words = TASK_DETAIL_WORDS[lang]
  if (task && pending === 0) {
    if (task.networkSuspended && (task.status === 'running' || task.status === 'cancelling')) return words.networkPaused
    if (task.phase !== 'replied') {
      if (task.status === 'queued' || task.phase === 'queued') return words.queued
      if (task.status === 'cancelling') return words.cancelling
    }
  }
  return STATUS_WORDS[lang][status]
}
