/**
 * approve.ts —— 终端这一面的拍板(`self change --approve <id>` / `--deny <id>`)。
 *
 * 为什么它不待在 cli.ts 里:这是**判断**,不是开关解析 —— 哪些状态能拍、拍不动时
 * 该怎么跟人说,都得有测试钉住。cli.ts 只负责把 `--approve` 的值传进来,再把
 * `ok` 翻成退出码 0 / 1。
 *
 * 为什么会有这一面(2026-09-18 真机):微信外发整个不通
 * (`ilink/sendmessage errcode=-2: prepare failed`)时,拍板卡进不了手机。daemon
 * 那边现在发不出去也**不撤**待批条目,所以同一条 hash 还有桌面权限卡和这里两条路
 * 能拍 —— 三个面最终都落到同一个 `PendingPermissions.consume`,从哪边拍都算数。
 */
import type { DaemonClient } from './daemon-client'
import type { StateStore } from './state'

export type ApproveCode =
  | 'resolved'
  | 'self_change_not_found'
  /** 已经收场了(done / declined / approval_timeout / 某种失败)—— 没什么可拍的。 */
  | 'self_change_settled'
  /** 还活着,但不停在 approval(或者压根没开过卡)。 */
  | 'self_change_not_awaiting'
  /** 条目在 daemon 那边已经没了:超时扫走,或者微信 / 桌面先一步拍了。 */
  | 'self_change_resolve_failed'

export interface ApproveOutcome {
  ok: boolean
  code: ApproveCode
  message: string
}

/**
 * 三道门,按「话要说得准」的顺序排:先分清「这条不存在」「这条完了」「这条不在等」,
 * 最后才去够 daemon。顺序反了的话,一条早就 done 的自改会得到一句
 * 「hash 过期或已被拍过」—— 对,但没用。
 */
export async function runApprove(
  store: StateStore,
  daemon: Pick<DaemonClient, 'resolve'>,
  id: string,
  decision: 'allow' | 'deny',
): Promise<ApproveOutcome> {
  const word = decision === 'allow' ? '放行' : '拒绝'
  const s = store.load(id)
  if (!s) {
    return { ok: false, code: 'self_change_not_found', message: `没有这条自改:${id}(wechat-cc self change --list 看有哪些)` }
  }
  if (s.result !== null) {
    return { ok: false, code: 'self_change_settled', message: `这条已经收场了(${s.result}),没什么可拍的` }
  }
  if (s.step !== 'approval' || !s.approval.hash) {
    return { ok: false, code: 'self_change_not_awaiting', message: `这条停在 ${s.step},不是在等拍板` }
  }
  const hash = s.approval.hash
  const ok = await daemon.resolve(hash, decision)
  if (!ok) {
    return { ok: false, code: 'self_change_resolve_failed', message: '拍板没成功:hash 过期或已被拍过' }
  }
  return { ok: true, code: 'resolved', message: `已拍板:${word}(hash ${hash.slice(0, 8)})` }
}
