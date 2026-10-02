/**
 * quota-handoff 域:执行者额度用完时,把一件事交给另一位执行者继续(手机确认卡;spec 2026-10-01-tendhearth-continue-sessions §7-3)。
 *
 * 与微信管家的「交给 X 继续?」同一个信号、同一个动作:信号 = quota 域的 quotaExhausted + fallbackExecutor;
 * 动作 = 在同一个文件夹给接手的执行者新开一件,第一句是 quotaTakeoverText(不带原会话,原任务原样留着)。
 * 手机要的另两件:按 requestId 幂等(落在 creation receipts 表,重启也认),以及一件事只交出去一次
 * (回执的 projectId 记成 `quota-handoff:<源任务>`,第二台设备再点回的是已交出的那件)。
 */
import { createHash } from 'node:crypto'
import type { QuotaKind } from '../../provider-quota'
import { isWorkbenchProviderId } from '../executor-capabilities'
import { normalizeInputRequestId } from '../live-inputs'
import { quotaTakeoverText, QUOTA_TAKEOVER_DEFAULT_REQUEST } from '../quota-takeover'
import type { ServiceCtx } from './ctx'
import type { ExecuteDomain } from './execute'
import type { QuotaDomain } from './quota'

/** 详情里给手机的那一块:能交(offer)/ 没人能接(none)/ 已经交出去了(handed,matterId = 新的那件事)。 */
export type QuotaHandoffView =
  | { state: 'offer'; from: string; to: string; kind: QuotaKind; resetAt: number }
  | { state: 'none'; from: string; kind: QuotaKind; resetAt: number }
  | { state: 'handed'; from: string; to: string; matterId: string }

export interface QuotaHandoffDomains { execute: ExecuteDomain; quota: QuotaDomain }

const TASK_ID = /^[a-f0-9]{8}$/
const RECEIPT_ACCOUNT = 'quota-handoff'
const keyOf = (taskId: string) => `quota-handoff:${taskId}`

export function makeQuotaHandoffDomain(ctx: ServiceCtx, domains: QuotaHandoffDomains) {
  const { store, state } = ctx
  const { createTask } = domains.execute
  const { quota, fallbackExecutor } = domains.quota
  const owned = (taskId: string) => {
    const task = store.get(taskId), owner = ctx.deps.ownerChatId()
    return task.ownerChatId && task.ownerChatId === owner ? task : null
  }
  const handed = (taskId: string) => {
    const r = store.creationReceipts.firstForProject(keyOf(taskId))
    return r ? { taskId: r.taskId, providerId: r.providerId, matterId: store.taskMatterId(r.taskId) ?? r.taskId } : null
  }

  /** 只读。null = 不用打扰(执行者还能用 / 正在跑 / 不是主人的)。 */
  function quotaHandoff(taskId: string): QuotaHandoffView | null {
    if (!TASK_ID.test(taskId)) return null
    let task
    try { task = owned(taskId) } catch { return null }
    if (!task) return null
    const done = handed(taskId)
    if (done) return { state: 'handed', from: task.providerId, to: done.providerId, matterId: done.matterId }
    if (state.runsByTask.has(taskId)) return null
    const q = quota.exhausted(task.providerId)
    if (!q) return null
    const to = fallbackExecutor(task.providerId)
    return to ? { state: 'offer', from: task.providerId, to, kind: q.kind, resetAt: q.resetAt } : { state: 'none', from: task.providerId, kind: q.kind, resetAt: q.resetAt }
  }

  /**
   * 交出去。providerId = 确认卡上写的那位:与此刻的接手人不一致就不交(quota_handoff_changed),手机重读再问。
   * 同一 requestId 重发 / 已经交出去过 ⇒ 回那一件(created:false),不建第二件。
   */
  function handOff(taskId: string, input: { requestId: string; providerId: string }): { taskId: string; created: boolean } {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw Error('invalid_request')
    const requestId = normalizeInputRequestId(input.requestId)
    if (!isWorkbenchProviderId(input.providerId)) throw Error('invalid_provider')
    const key = keyOf(taskId)
    const prior = store.creationReceipts.get(requestId)
    if (prior) {
      if (prior.accountId !== RECEIPT_ACCOUNT || prior.projectId !== key) throw Error('creation_conflict')
      return { taskId: prior.taskId, created: false }
    }
    // requestId 与其它幂等表共用一个命名空间(同 notices / wechat-control 的做法)。
    if (store.liveInputs.get(requestId) || store.controlReceipts.get(requestId)) throw Error('creation_conflict')
    let task
    try { task = owned(taskId) } catch { throw Error('matter_not_found') }
    if (!task) throw Error('invalid_entry_owner')
    const done = handed(taskId)
    if (done) return { taskId: done.taskId, created: false }
    ctx.ensureAccepting()
    if (state.runsByTask.has(taskId)) throw Error('workbench_busy')
    if (!quota.exhausted(task.providerId)) throw Error('quota_handoff_not_needed')
    const to = fallbackExecutor(task.providerId)
    if (!to) throw Error('quota_handoff_unavailable')
    if (to !== input.providerId) throw Error('quota_handoff_changed')
    const source = task
    const made = createTask(
      { path: source.path, providerId: to, text: quotaTakeoverText(source.providerId, source.title, QUOTA_TAKEOVER_DEFAULT_REQUEST), title: source.title.slice(0, 120) },
      (next, runId) => {
        store.creationReceipts.add({ id: requestId, accountId: RECEIPT_ACCOUNT, ownerChatId: source.ownerChatId!, commandHash: createHash('sha256').update(key).digest('hex'), projectId: key, path: next.path, providerId: to, taskId: next.id, runId, reply: '' })
      },
      { matterId: store.taskMatterId(source.id), messageId: null },
    )
    ctx.log?.('WORKBENCH', `quota handoff ${source.id} → ${to} ${made.id}`)
    return { taskId: made.id, created: true }
  }

  return { quotaHandoff, handOff, api: { quotaHandoff, handOff } }
}
export type QuotaHandoffDomain = ReturnType<typeof makeQuotaHandoffDomain>
