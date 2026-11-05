/**
 * matter-proposals.ts —— 一件事状态变了 ⇒ 一个提议,按「主人此刻在哪」选第一级通道(S3b,设计稿
 * docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md;主人已点头的两处:骨架稿 §5「任务做完时人在电脑前 ⇒ 先只在桌面
 * 提示,10 分钟没看再推手机」、§8 第 6 条)。
 *
 *  - blocking(等你批准 / 有问题问你):照旧各处都推 —— 原样交给 push-gate。
 *  - report(做完了 / 没做成):
 *      人不在电脑前 ⇒ 推 App(和以前一样);
 *      人在电脑前 ⇒ 先问门(带事件键,通道记 desktop);放行 ⇒ 桌面那一级:桌面 app 开着、而且看见了这件在做 ⇒ 它自己会弹
 *        「有一件事回复了」;否则(没开 / 两拍之间就做完了)⇒ daemon 弹一条系统通知;App 那一条交给 push-gate 等 10 分钟,到点这件事在桌面 / 手机上看过 ⇒ 不推,没看过 ⇒ 推
 *        (账还是那一行,通道追加成 desktop+app)。门说推后(免打扰)⇒ 交回 push-gate 照 S2 压着,时段结束推 App。
 * 判不出在不在(探针失败)⇒ 当作不在:宁可推手机,不漏。
 */
import type { PushPayload } from '../../features/phone'
import type { PushGate } from './push-gate'
import { pushSpeechKind } from './push-gate'
import type { SpeechPolicy } from './policy'

/** 先只在桌面提示以后,多久没看到就推 App(主人点头的 10 分钟)。 */
export const ESCALATE_AFTER_MS = 10 * 60_000

export interface MatterProposals {
  propose(p: PushPayload, ref?: string): Promise<void>
}

export function makeMatterProposals(d: {
  gate: Pick<PushGate, 'push' | 'later'>
  speech: Pick<SpeechPolicy, 'ask'>
  ownerChatId(): string | null
  atDesk(): Promise<boolean>
  /** 桌面 app 开着、而且会为这件事自己弹(desktop-surface.ts willAnnounce)⇒ daemon 不另弹。 */
  desktop: { appConnected(): boolean; willAnnounce(matterId: string): boolean; notify(title: string, body: string): Promise<boolean> }
  escalateAfterMs?: number
  now?: () => number
  log: (tag: string, line: string) => void
}): MatterProposals {
  const now = d.now ?? Date.now
  const after = d.escalateAfterMs ?? ESCALATE_AFTER_MS
  return {
    async propose(p, ref) {
      const kind = pushSpeechKind(p.kind)
      const chat = d.ownerChatId()
      if (kind !== 'matter_report' || !chat || !p.taskId) { d.gate.push(p, ref); return }
      let desk = false
      try { desk = await d.atDesk() } catch { desk = false }
      if (!desk) { d.gate.push(p, ref); return }
      const o = d.speech.ask({ kind, chatId: chat, ...(ref ? { ref } : {}) }, { channel: 'desktop', deliverable: true })
      if (!('allow' in o)) { d.gate.push(p, ref); return }
      const t = now()
      if (d.desktop.appConnected() && d.desktop.willAnnounce(p.taskId)) {
        d.log('PUSH', `${p.kind} ${p.taskId}: owner at the desk — the desktop app shows it; App push waits ${Math.round(after / 1000)}s`)
      } else {
        // 系统通知里不放任务标题(可能带私事 / 项目名),和桌面 app 自己那条同一套措辞(workbench-attention.js)
        const n = p.kind === 'task_failed' ? { title: '有一件事停下了', body: '打开 CC 看看发生了什么。' } : { title: '有一件事回复了', body: '打开 CC 查看。' }
        const ok = await d.desktop.notify(n.title, n.body).catch(() => false)
        d.log('PUSH', `${p.kind} ${p.taskId}: owner at the desk — ${ok ? 'desktop notification shown' : 'desktop notification failed'}; App push waits ${Math.round(after / 1000)}s`)
      }
      d.gate.later(p, { at: t + after, since: t, matterId: p.taskId, ...(ref ? { ref } : {}) })
    },
  }
}
