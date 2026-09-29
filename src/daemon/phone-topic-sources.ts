/**
 * phone-topic-sources.ts — 手机事件集线器(phone-events.ts)的四路真实来源 + 接线(手机协议 v2
 * 第 11 步,2026-09-29)。
 *
 * 规矩(spec §3.4):**事件只带小摘要与版本号,大内容照旧用 `req` 去拉。** 所以这里的每个
 * snapshot 都是几十字节到几 KB 的摘要 —— 没有任务详情、没有动态正文、没有聊天历史。
 *
 *   home          {unread, presenceState, nextCursor}         —— 面板 `/m/api/home?limit=1` 同一构建函数
 *   matter/<id>   {found:true, kind, version, phase} | {found:false}
 *                 任务:detail(id).version + 阶段;聊天事项:matters 的 updatedAt + 状态
 *   approvals     [{taskId, kind:'permission'|'question', id, summary}]
 *   agents        {running, waiting, tasks:[{id, title, phase}]}   —— 未归档、未终态
 *
 * 集线器只按「稳定序列化后变没变」判新事件,所以摘要里别放每次都变的东西(synced_at 之类)。
 */
import { TERMINAL_TASK_STATUSES } from '../core/workbench/store'
import type { WorkbenchService } from '../core/workbench/service'
import type { MatterStore } from '../core/matters/store'
import type { HomePayload } from './settings-panel'
import { makePhoneEvents, type PhoneEvents, type TopicSource } from './phone-events'

/** 来源用得到的工作台面(结构化类型,测试可给假的)。 */
export type PhoneWorkbench = Pick<WorkbenchService, 'list' | 'attention' | 'detail'>

export interface PhoneTopicSourceDeps {
  /** 缺省 ⇒ approvals / agents 回空摘要,matter/<任务> 回 {found:false}。 */
  workbench?: PhoneWorkbench
  /** 「一件事」登记处;缺省 ⇒ matter/<id> 一律 {found:false}。 */
  matters?: Pick<MatterStore, 'get'>
  /** 面板的 home 构建函数(SettingsPanel.home)。 */
  home: (limit: number, opts?: { work?: boolean }) => Promise<HomePayload>
}

const MATTER_TOPIC = /^matter\/([a-f0-9]{8})$/
const SUMMARY_MAX = 80
const clip = (s: string, n = SUMMARY_MAX): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export interface ApprovalSummary { taskId: string; kind: 'permission' | 'question'; id: string; summary: string }

export function makePhoneTopicSources(deps: PhoneTopicSourceDeps): TopicSource[] {
  const home: TopicSource = {
    match: t => t === 'home',
    async snapshot() {
      const h = await deps.home(1, { work: false })
      return {
        unread: h.unread,
        presenceState: h.presence ? { level: h.presence.presence, activity: h.presence.activity.kind } : null,
        nextCursor: h.next_cursor,
      }
    },
  }

  const matter: TopicSource = {
    match: t => t.startsWith('matter/'),
    async snapshot(topic) {
      // 与 /m/api/matter 同一道门:id 形状不对 / 登记处没有 ⇒ 不存在。phoneTopicAllowed 已先挡过一轮。
      const id = MATTER_TOPIC.exec(topic)?.[1]
      const m = id ? deps.matters?.get(id) ?? null : null
      if (!id || !m) return { found: false }
      if (m.kind === 'task') {
        if (!deps.workbench) return { found: false }
        // 事项还在、任务已被清掉:detail 抛。与 /m/api/matter 同一待遇 —— 当不存在,别让集线器每轮记错跳过。
        let d: ReturnType<PhoneWorkbench['detail']>
        try { d = deps.workbench.detail(id) } catch { return { found: false } }
        return { found: true, kind: 'task', version: d.version, phase: d.task.phase }
      }
      return { found: true, kind: m.kind, version: m.updatedAt, phase: m.status }
    },
  }

  const approvals: TopicSource = {
    match: t => t === 'approvals',
    async snapshot() {
      const wb = deps.workbench
      if (!wb) return []
      const out: ApprovalSummary[] = []
      for (const t of wb.attention().tasks) {
        let d: ReturnType<PhoneWorkbench['detail']>
        try { d = wb.detail(t.id) } catch { continue }   // 刚好收工 / 删掉:下一轮再说
        for (const p of d.permissions) out.push({ taskId: t.id, kind: 'permission', id: p.id, summary: clip(`${p.tool}: ${p.description}`) })
        for (const q of d.questions) out.push({ taskId: t.id, kind: 'question', id: q.id, summary: clip(q.questions[0]?.question ?? '') })
      }
      return out.sort((a, b) => (a.taskId + a.id).localeCompare(b.taskId + b.id))
    },
  }

  const agents: TopicSource = {
    match: t => t === 'agents',
    async snapshot() {
      const wb = deps.workbench
      if (!wb) return { running: 0, waiting: 0, tasks: [] }
      const live = wb.list({ archived: 'exclude', limit: 100 }).tasks
        .filter(t => !TERMINAL_TASK_STATUSES.includes(t.status))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      // 「在干」= 执行者正在写、没卡在主人身上;其余(排队、等拍板、本轮答完等下一句)都算「在等」。
      const busy = (t: (typeof live)[number]) => t.phase === 'working' && !(t.pendingPermissionCount ?? 0) && !(t.pendingQuestionCount ?? 0)
      const running = live.filter(busy).length
      return { running, waiting: live.length - running, tasks: live.map(t => ({ id: t.id, title: clip(t.title), phase: t.phase })) }
    },
  }

  return [home, matter, approvals, agents]
}

/**
 * 推送出口(spec §3.5):app 不在线、又有值得通知的事时,后台把用设备推送密钥封好的载荷交给
 * 这里。**真正发推送是子项目 2(中继转 APNs / FCM)**;这一版出口什么也不做。
 */
export type PhoneNotify = (deviceId: string, sealed: unknown) => void
export const noopPhoneNotify: PhoneNotify = () => { /* 子项目 2:推送发送 */ }

/**
 * daemon 用的完整接线:四路来源 + 集线器 + 工作台变更 ⇒ poke。
 *
 * 重入(第 8 步的规矩):`changes.onChange` 回调里只许 `events.poke()` —— poke 自己排到
 * 微任务再重算,绝不在工作台 publish 的调用栈里回头读工作台 / 往它的 hub 里发东西。
 */
export function makePhoneEventsWiring(deps: PhoneTopicSourceDeps & {
  changes?: Pick<WorkbenchService['changes'], 'onChange'>
  pollMs?: number
  log?: (tag: string, line: string) => void
  onNotify?: PhoneNotify
}): { events: PhoneEvents; onNotify: PhoneNotify; dispose(): void } {
  const events = makePhoneEvents({
    sources: makePhoneTopicSources(deps),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
  const off = deps.changes?.onChange(() => events.poke())
  return {
    events,
    onNotify: deps.onNotify ?? noopPhoneNotify,
    dispose() { off?.(); events.dispose() },
  }
}
