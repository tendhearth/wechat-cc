/**
 * 测试用:给 makeSettingsPanel 的 deps 补上 `v1`(P3c-1 起并成别名的旧路径翻到 `/v1`,走内部 API 同一个分发)。
 *
 * 生产里面板的 `matters` 与内部 API 的 `matters` 是同一个 MattersService(wiring/pipeline-deps.ts 建一个,
 * wire-settings-panel.ts 与 internalApi.provide 各拿一份)。老测试只给了面板那一份(手机那几样:list / detail / say /
 * seenOnPhone / withActs)和手机对话的假实现(search / transcribe 等),这里照 pipeline-deps.ts 的接法把它们拼成
 * 内部 API 要的那一份,再起一个真的 createInternalApi(不起监听,只用 panelDispatch)。处理器、分发、别名都是真的。
 */
import { join } from 'node:path'
import type { SettingsPanelDeps } from './settings-panel'
import type { MobileChatDeps } from './mobile-chat'
import type { MessageRecord } from '../../lib/messages-store'
import type { MattersService } from '../../app/matters/service'
import { createInternalApi, type InternalApiOptions } from '../../daemon/internal-api'
import type { RouteTable } from '../../daemon/internal-api/types'
import type { ModuleName } from '@wechat-cc/protocol/routes'
import { makeOwnerChatFileReader } from '../../daemon/wiring/owner-chat-reading'
import { fileChunkResponse } from './mobile-chat'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import { memoryRoutes } from '../memory'
import { journalRoutes } from '../journal'
import { workbenchRoutes, type PhoneSessionsSource, type WorkbenchService } from '../workbench'
import type { MobileUploadActions } from './mobile-workbench'
import type { EntryInput } from '../../adapters/workbench/task-entry'
import { latestChanges, type ReviewTurnLike } from '../../domain/matters/phone-changes'

/** 老测试给手机对话的假实现里还有这两样(P3c-1 以前面板自己用;现在经 /v1 用)。 */
export type LegacyChatFakes = MobileChatDeps & {
  search?(chatId: string, query: string, limit: number): Promise<MessageRecord[]>
  transcribe?(audio: Buffer, mime: string): Promise<{ text: string }>
}
/**
 * `connections`(P3c-2 以前面板自己读;现在经 `/v1/connections` 读,生产里是 internalApi.provide({ connections }) 那一份):
 * 老测试照旧交给面板这一层,这里转交内部 API。终端会话列表 / 「今天」是终端模块自己挂的路由,由测试经 `mounts` 交进来。
 */
/**
 * P3c-3 起记忆收回 / 恢复、待办改状态、推水位也经 `/v1` 走(生产里是记忆模块 / 日志模块挂的路由、bootApi 交的 knowledge):
 * 老测试照旧把假实现交给面板这一层(`memoryRetractions` / `restoreMemory`、`todos.facts.setFactStatus`、`seen.write`),这里转交内部 API。
 */
/**
 * P3c-4 起交办选项 / 模型、扔掉分块上传的材料、电脑上的原生会话也经 `/v1/workbench/*` 走(生产里是工作台模块挂的路由):
 * 老测试照旧把假实现交给面板这一层(`entry.entryOptions` / `entryModels`、`uploads.discard`、`sessions`),这里拼成一个
 * 只有这几样的 WorkbenchService,挂上真的 workbenchRoutes。
 */
/**
 * P3e 起一件事上的动作(停下 / 批准 / 回答 / 成果 / 交给另一位 / 工作区)与交办、回执也经 `/v1/matter/*` 走(生产里是内部 API
 * 那一个处理器,底下是 MattersService):老测试照旧把手机那一份的假实现交给面板这一层(`matters.stop` …、`entry.createEntry` /
 * `entryReceipt`),这里转交内部 API 的 MattersService。
 */
type PhoneMatterActionFakes = Partial<Pick<MattersService, 'stop' | 'permission' | 'answer' | 'artifactChunk' | 'handoff' | 'worktree' | 'worktreeScript' | 'rewindPreview' | 'rewind'>>
/** 改动与逐文件审阅(P3e-2 以前面板自己的 deps:`changes` = 工作台 reviewList,`review` = 标记 / 打回 / 行评论 / 发出评论)。 */
type ReviewFakes = {
  changes?: (id: string) => readonly ReviewTurnLike[]
  review?: {
    mark(id: string, input: { artifactId: string; path: string; mark: 'accepted' | 'returned' }): unknown
    ret(id: string, input: { artifactId: string; paths: string[]; comment: string }): unknown
    comment?(id: string, input: never): unknown
    sendComments?(id: string, input: { summary?: string; inputRequestId?: string }): unknown
  }
}
type EntryFakes = {
  createEntry?(input: EntryInput): unknown
  entryReceipt?(requestId: string): unknown
  entryOptions?(): object
  entryModels?(input: { providerId: string; projectId?: string }): Promise<unknown>
}
export type PanelDepsWithFakes = Omit<SettingsPanelDeps, 'chat' | 'todos' | 'seen' | 'uploads' | 'matters'> & ReviewFakes & {
  matters?: NonNullable<SettingsPanelDeps['matters']> & PhoneMatterActionFakes
  entry?: EntryFakes
  uploads?: MobileUploadActions & { discard?(input: { id: string; draftId: string }): void }
  sessions?: PhoneSessionsSource
  chat?: LegacyChatFakes
  connections?: () => import('../../daemon/connections').ConnectionsSnapshot
  memoryRetractions?: () => Array<{ key: string; section: string | null; text: string; day: string | null; verdict: string | null; note: string }>
  restoreMemory?: (key: string) => Promise<{ restored: string[] } | null>
  todos?: { facts: NonNullable<SettingsPanelDeps['todos']>['facts'] & { setFactStatus?(id: number, status: string, now: number): object }; names: NonNullable<SettingsPanelDeps['todos']>['names'] }
  seen?: { read: () => string | null; write?: (iso: string) => void }
}

/** 面板 deps(含老测试的假实现)→ 内部 API 要的 MattersService(照 pipeline-deps.ts 的 mattersService 接法)。 */
export function mattersServiceFromPanelDeps(d: PanelDepsWithFakes): MattersService | undefined {
  const m = d.matters, chat = d.chat
  if (!m && !chat && !d.entry?.createEntry && !d.entry?.entryReceipt && !d.changes && !d.review) return undefined
  const owner = () => chat?.owner()?.chatId ?? d.ownerChatId()
  return {
    list: f => (m ? m.list(f as never) : []) as never,
    withActs: rows => (m?.withActs ? m.withActs(rows as never) : rows) as never,
    detail: async id => { if (!m) throw new Error('matters_not_wired'); return await m.detail(id) as never },
    phoneMayOpen: matter => phoneMayOpenMatter(matter, d.ownerChatId()),
    seenOnPhone: id => m?.seenOnPhone(id),
    say: async (id, text, _surface, input) => { if (!m) throw new Error('matters_not_wired'); return await (input ? m.say(id, text, input) : m.say(id, text)) as never },
    searchOwnerChat: async (query, limit = 30) => {
      const q = query.trim(); if (!q || q.length > 200) throw Error('invalid_query')
      const chatId = chat?.owner()?.chatId ?? null
      if (!chatId || !chat?.search) return null
      // pipeline-deps.ts 的 chat.search 那一行
      return { hits: (await chat.search(chatId, q, Math.max(1, Math.min(50, Math.trunc(limit))))).map(r => ({ id: r.id, kind: r.direction === 'in' ? 'user' as const : 'text' as const, text: r.text, createdAt: Date.parse(r.ts), source: r.source })) as never }
    },
    // P3e 一件事上的动作(手机那一份):面板这一层交来的假实现原样转交;没交 ⇒ 同 MattersService 没接工作台
    ...phoneActionsFrom(m),
    createEntry: (input: unknown) => { if (!d.entry?.createEntry) throw new Error('workbench_not_wired'); return d.entry.createEntry(input as EntryInput) },
    entryReceipt: (requestId: string) => { if (!d.entry?.entryReceipt) throw new Error('workbench_not_wired'); return d.entry.entryReceipt(requestId) },
    // P3e-2 改动与逐文件审阅:同 MattersService(changes 是 reviewList 裁到一帧;别的原样转交)
    changes: (id: string) => { if (!d.changes) throw new Error('workbench_not_wired'); return latestChanges(d.changes(id)) },
    markReviewFile: (id: string, input: never) => { if (!d.review) throw new Error('workbench_not_wired'); return d.review.mark(id, input) },
    returnReviewFiles: async (id: string, input: never) => { if (!d.review) throw new Error('workbench_not_wired'); return await d.review.ret(id, input) as never },
    reviewComment: (id: string, input: Record<string, unknown>) => { if (!d.review?.comment) throw new Error('workbench_not_wired'); return d.review.comment(id, input as never) },
    sendReviewComments: async (id: string, input: { summary?: string; inputRequestId?: string }) => { if (!d.review?.sendComments) throw new Error('workbench_not_wired'); return await d.review.sendComments(id, input) },
    // pipeline-deps.ts 的 chat.file 那一行
    ownerChatFile: chat?.message
      ? makeOwnerChatFileReader({ ownerChatId: owner, ...(chat.inboxDir ? { inboxDir: chat.inboxDir } : {}), readChunk: fileChunkResponse, stickerDir: join(d.stateDir, 'stickers'), message: (chatId, id) => chat.message!(chatId, id) })
      : async () => ({ status: 503, body: { error: 'chat_not_wired' } }),
  } as Partial<MattersService> as MattersService
}

/** 手机那一份动作的假实现:有就转交,没有就抛 workbench_not_wired(同 MattersService 没接工作台时)。 */
function phoneActionsFrom(m: PhoneMatterActionFakes | undefined): PhoneMatterActionFakes {
  const out: Record<string, unknown> = {}
  for (const k of ['stop', 'permission', 'answer', 'artifactChunk', 'handoff', 'worktree', 'worktreeScript', 'rewindPreview', 'rewind'] as const) {
    const fn = m?.[k] as ((...a: unknown[]) => unknown) | undefined
    out[k] = (...a: unknown[]) => { if (!fn) throw new Error('workbench_not_wired'); return fn.apply(m, a) }
  }
  return out as PhoneMatterActionFakes
}

/**
 * 补上 `v1`;`mounts` = 各模块自己挂的路由(如语音的 POST /v1/companion/transcribe —— 功能之间不互相 import,由测试交进来)。
 * `api` 给要直接摸内部 API 的测试。
 */
export function withPanelV1(d: PanelDepsWithFakes, options: InternalApiOptions = {}, mounts: Partial<Record<ModuleName, RouteTable>> = {}): SettingsPanelDeps & { api: ReturnType<typeof createInternalApi> } {
  const matters = mattersServiceFromPanelDeps(d)
  const setFactStatus = d.todos?.facts.setFactStatus
  const api = createInternalApi({
    stateDir: d.stateDir, daemonPid: 1, ...(matters ? { matters } : {}), ...(d.connections ? { connections: d.connections } : {}),
    ...(setFactStatus ? { knowledge: { facts: { setFactStatus: (id: number, st: string, n: number) => setFactStatus(id, st, n) } } as never } : {}),
  }, options)
  const own: Partial<Record<ModuleName, RouteTable>> = {}
  if (d.memoryRetractions || d.restoreMemory) {
    const nightly = {
      retractions: () => { if (!d.memoryRetractions) throw new Error('not in this test'); return d.memoryRetractions() },
      restore: async (key: string) => { if (!d.restoreMemory) throw new Error('not in this test'); return await d.restoreMemory(key) },
    }
    own.memory = memoryRoutes({ stateDir: d.stateDir, memoryLlm: () => null, memoryNightly: () => nightly as never })
  }
  const seen = d.seen, write = seen?.write
  if (seen && write) own.journal = journalRoutes({ stateDir: d.stateDir, journal: {} as never, seen: { read: () => seen.read(), write }, ...(d.now ? { now: d.now } : {}) })
  const entry = d.entry, uploads = d.uploads
  if (entry?.entryOptions || entry?.entryModels || uploads?.discard || d.sessions) {
    const nope = (what: string) => () => { throw new Error(`${what} not in this test`) }
    const workbench = {
      entryOptions: entry?.entryOptions ? () => entry.entryOptions!() : nope('entryOptions'),
      entryModels: entry?.entryModels ? (input: { providerId: string; projectId?: string }) => entry.entryModels!(input) : nope('entryModels'),
      discardAttachmentUpload: uploads?.discard ? (input: { id: string; draftId: string }) => uploads.discard!(input) : nope('discard'),
    } as Partial<WorkbenchService> as WorkbenchService
    own.workbench = workbenchRoutes({ workbench, resolveAdminChatId: d.ownerChatId, phoneSessions: { ...(d.sessions ? { sessions: d.sessions } : {}), ...(d.executorName ? { executorName: d.executorName } : {}) } })
  }
  for (const [name, table] of Object.entries({ ...own, ...mounts })) if (table) api.mount(name as ModuleName, table)
  const { connections: _c, memoryRetractions: _r, restoreMemory: _m, sessions: _s, changes: _ch, review: _rv, ...panel } = d
  return { ...(panel as SettingsPanelDeps), v1: api.panelDispatch, api }
}
