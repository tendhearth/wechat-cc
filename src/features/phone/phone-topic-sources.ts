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
 *
 * 四路都是变化驱动的(P2,2026-11-04):不再 2 秒比一次快照,有信号才算 —— 一件事的轮 / 步 / touch 走 MatterLog 的变化信号
 * (`changes.onChange`),消息、matters 行、觅食台、看到哪了、伙伴的念头走写口提示(lib/write-hints.ts)。
 * 兜底轮询照留:matter / approvals / agents 每 30 秒,home 每 10 秒 —— home 的「在场」有几样没有写口可提示:
 * 「在跟你聊」三分钟后自己退、忙碌登记处、串门、外发健康、子系统降级,都是内存里的状态或者随时间变的。
 */
import { TERMINAL_TASK_STATUSES } from '../../adapters/store/workbench/store'
import type { WorkbenchService } from '../workbench'
import type { Matter, MatterStore } from '../../ports/matters'
import { legacyStatus } from '../../domain/matters/legacy-status'
import type { HomePayload } from './settings-panel'
import { makePhoneEvents, type PhoneEvents, type TopicSource } from './phone-events'

/** 非任务那件事主题帧的 phase = 线上旧 status(wire-compat.ts 最后一行;非任务只有 archived / open,不看轮与步)。 */
const nonTaskPhase = (m: Matter) => legacyStatus({ kind: m.kind, state: m.state ?? 'open', archivedAt: m.archivedAt ?? null, latestTurn: null, latestReady: false })
import type { WriteHint } from '../../lib/write-hints'

/** 来源用得到的工作台面(结构化类型,测试可给假的)。 */
export type PhoneWorkbench = Pick<WorkbenchService, 'list' | 'attention' | 'detail'>

export interface PhoneTopicSourceDeps {
  topics?: () => Promise<unknown>
  /** 缺省 ⇒ approvals / agents 回空摘要,matter/<任务> 回 {found:false}。 */
  workbench?: PhoneWorkbench
  /** 「一件事」登记处;缺省 ⇒ matter/<id> 一律 {found:false}。 */
  matters?: Pick<MatterStore, 'get'>
  /** 面板的 home 构建函数(SettingsPanel.home)。 */
  home: (limit: number, opts?: { work?: boolean }) => Promise<HomePayload>
  /** 聊天类 matter 的真实活动:最新一条消息时间 + 手机那句是否在等回复(spec 2026-10-01 §3)。缺省 ⇒ 只看 updatedAt。 */
  chat?: { latestAt(chatId: string): Promise<number | null>; pendingMatter(): string | null }
}

const MATTER_TOPIC = /^matter\/([a-f0-9]{8})$/
/** home 兜底几拍一次(2 秒一拍 ⇒ 10 秒):在场里没有写口的那几样(见文件头)最多晚这么久。 */
export const HOME_SAFETY_TICKS = 5
const SUMMARY_MAX = 80
const clip = (s: string, n = SUMMARY_MAX): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export interface ApprovalSummary { taskId: string; kind: 'permission' | 'question'; id: string; summary: string }

export function makePhoneTopicSources(deps: PhoneTopicSourceDeps): TopicSource[] {
  const home: TopicSource = {
    match: t => t === 'home',
    driven: () => true,
    safetyTicks: HOME_SAFETY_TICKS,
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
    // 轮 / 步 / 工作台的 bump 经 MatterLog 进变化信号(P1a);matters 行本身(状态、updated_at、新建)和聊天的新消息经写口提示;
    // 手机那句在等回复(pendingMatter)由 phone-chat 起止时 poke。所以每一种都不用 2 秒比一次(P2)。
    driven: () => true,
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
      if (m.kind === 'chat' && deps.chat) {
        let latest: number | null = null
        if (m.ownerChatId) { try { latest = await deps.chat.latestAt(m.ownerChatId) } catch { latest = null } }
        const version = Math.max(m.updatedAt, latest !== null && Number.isFinite(latest) ? latest : 0)
        return { found: true, kind: m.kind, version, phase: deps.chat.pendingMatter() === id ? 'working' : nonTaskPhase(m) }
      }
      return { found: true, kind: m.kind, version: m.updatedAt, phase: nonTaskPhase(m) }
    },
  }

  const approvals: TopicSource = {
    match: t => t === 'approvals',
    // 权限卡 / 提问的起落都 bump 那件任务(工作台 ctx.hub.bumped)⇒ 变化信号
    driven: () => true,
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
    // 只读工作台任务的状态 / 阶段 / 标题,都经 store.bump ⇒ 变化信号
    driven: () => true,
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

  const topics: TopicSource = {
    match: t => t === 'topics', driven: () => true,
    async snapshot() { if (!deps.topics) throw new Error('topics_unavailable'); return deps.topics() },
  }
  return [home, matter, approvals, agents, topics]
}

// 推送判定在 phone-notifier.ts。

/**
 * daemon 用的完整接线:四路来源 + 集线器 + 工作台变更 ⇒ poke。
 *
 * 重入(第 8 步的规矩):`changes.onChange` 回调里只许 `events.poke()` —— poke 自己排到
 * 微任务再重算,绝不在工作台 publish 的调用栈里回头读工作台 / 往它的 hub 里发东西。
 */
export function makePhoneEventsWiring(deps: PhoneTopicSourceDeps & {
  changes?: Pick<WorkbenchService['changes'], 'onChange'>
  /** 写口提示(lib/write-hints.ts 的 onWriteHint,接线方把库和 stateDir 两个作用域合在一起给)。返回退订。 */
  hints?: (cb: (hint: WriteHint) => void) => () => void
  pollMs?: number
  log?: (tag: string, line: string) => void
}): { events: PhoneEvents; dispose(): void } {
  const events = makePhoneEvents({
    sources: makePhoneTopicSources(deps),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
  // 某一件事变了:只算那件事的主题 + 不分事的主题(home / approvals / agents),别把每个订着的 matter/<id> 都重算一遍(P2)
  const off = deps.changes?.onChange((matterId) => events.poke(topic => topic === `matter/${matterId}` || !topic.startsWith('matter/')))
  // 写口提示(P2 第二步):只算读得到这样东西的主题
  const ownerOf = (topic: string) => { const id = MATTER_TOPIC.exec(topic)?.[1]; try { return id ? deps.matters?.get(id)?.ownerChatId ?? null : null } catch { return null } }
  const offHints = deps.hints?.((hint) => {
    if (hint.kind === 'topics') events.poke(topic => topic === 'topics')
    else if (hint.kind === 'matter') events.poke(topic => topic === `matter/${hint.matterId}` || topic === 'topics')
    // 新的一条消息:这个 chat 的聊天主题(版本 = 最新一条的时间)+ home(「在跟你聊」看入站时间)
    else if (hint.kind === 'messages') events.poke(topic => topic === 'topics' || topic === 'home' || (topic.startsWith('matter/') && ownerOf(topic) === hint.chatId))
    else events.poke(topic => topic === 'home')   // journal / journal-seen / plan-log:home 的未读与动态
  })
  return {
    events,
    dispose() { off?.(); offHints?.(); events.dispose() },
  }
}
