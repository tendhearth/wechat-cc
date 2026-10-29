/**
 * desktop-calls.ts —— 桌面(`/v1/*`)的类型化客户端(架构终态 F5):一张表 `DESKTOP_CALLS`,`命名空间.方法 → 路由键`
 * 外加查询参数 / 正文的类型。路由键只能是路由表(`routes.ts` 的 `ROUTES`)里登记过的 `/v1` 那半 —— 写错一个字编译就不过。
 *
 * 和手机那份(`phone-calls.ts`)共用 `calls.ts` 的拼法与传输接口。不同的是桌面的 webview 引不到这个包:
 * `bun run gen:routes` 把这张表写成 `apps/desktop/src/generated/daemon-calls.js`(纯数据,`命名空间.方法 → 路由键`
 * 外加两份宿主代理的名单),桌面的 `apps/desktop/src/daemon-client.js` 照 `calls.ts` 拼请求。
 * 守卫:`scripts/route-registry.guard.test.ts` 盯生成物与这张表一致,`scripts/client-paths.guard.test.ts` 盯桌面源码里
 * 一条手写的 `/v1/…` 都没有、两边拼出来的路径逐字一样。
 *
 * 返回形状桌面还没用上(`desktop-api.ts` 的 `RESPONSE_SCHEMAS` 键是 string,推不出来),`makeDesktopApi` 先回 unknown。
 * 桌面加一条调用 = 在这里加一行,跑 `bun run gen:routes`。
 */
import type { DeclaredRouteKey } from './routes'
import { callSpec, makeApi, t, type CallArgs, type CallRequest, type CallSpec } from './calls'

/** 路由表里 `/v1` 那半的键。 */
export type DesktopRouteKey = Extract<DeclaredRouteKey, `${string} /v1/${string}`>

function call<K extends DesktopRouteKey, Q = void, B = void>(key: K, types?: { query?: Q; body?: B }): CallSpec<K, Q, B> {
  return callSpec(key, types)
}

type Body = Record<string, unknown>
const body = () => ({ body: t<Body>() })

export const DESKTOP_CALLS = {
  access: { list: call('GET /v1/access/list') },
  avatar: {
    info: call('GET /v1/avatar/info', { query: t<{ key: string }>() }),
    set: call('POST /v1/avatar/set', body()),
    remove: call('POST /v1/avatar/remove', body()),
  },
  a2a: {
    list: call('GET /v1/a2a/list'),
    info: call('GET /v1/a2a/info'),
    activity: call('GET /v1/a2a/activity', { query: t<{ agent_id: string; limit: number }>() }),
    preview: call('POST /v1/a2a/preview', body()),
    install: call('POST /v1/a2a/install', body()),
    remove: call('POST /v1/a2a/remove', body()),
    pause: call('POST /v1/a2a/pause', body()),
    test: call('POST /v1/a2a/test', body()),
  },
  atelier: {
    modelStatus: call('GET /v1/atelier/model-status'),
    share: call('POST /v1/atelier/share', body()),
    works: call('GET /v1/atelier/works', { query: t<{ limit: number }>() }),
  },
  cli: {
    hooksInstall: call('POST /v1/cli/hooks/install', body()),
    sessions: call('GET /v1/cli/sessions', { query: t<{ limit: number }>() }),
  },
  companion: {
    pet: call('GET /v1/companion/pet'),
    presence: call('GET /v1/companion/presence'),
    status: call('GET /v1/companion/status'),
    thoughts: call('GET /v1/companion/thoughts'),
  },
  connections: { get: call('GET /v1/connections') },
  conversation: { setMode: call('POST /v1/conversation/set-mode', body()) },
  conversations: { list: call('GET /v1/conversations/list') },
  dialogue: {
    timeline: call('GET /v1/dialogue/timeline', { query: t<{ chat_id: string; limit: number; before?: string }>() }),
    threads: call('GET /v1/dialogue/threads', { query: t<{ chat_id: string; facet: string; include_private?: number }>() }),
    thread: call('GET /v1/dialogue/thread', { query: t<{ id: string }>() }),
    search: call('GET /v1/dialogue/search', { query: t<{ chat_id: string; q: string }>() }),
    unlock: call('POST /v1/dialogue/unlock', body()),
  },
  events: { list: call('GET /v1/events/list', { query: t<{ chat_id: string; limit: number }>() }) },
  health: {
    get: call('GET /v1/health'),
    incidents: call('GET /v1/health/incidents'),
  },
  journal: {
    list: call('GET /v1/journal', { query: t<{ limit: number }>() }),
    favorite: call('POST /v1/journal/favorite', body()),
    postcards: call('GET /v1/journal/postcards', { query: t<{ limit: number; offset: number; favorites: string }>() }),
    remove: call('POST /v1/journal/remove', body()),
    seen: call('POST /v1/journal/seen'),
    status: call('POST /v1/journal/status', body()),
  },
  knowledge: {
    findFacts: call('POST /v1/knowledge/facts/find_facts', body()),
    setFactStatus: call('POST /v1/knowledge/facts/set_fact_status', body()),
    topContacts: call('POST /v1/knowledge/graph/top_contacts', body()),
  },
  license: {
    status: call('GET /v1/license/status'),
    activate: call('POST /v1/license/activate', body()),
    deactivate: call('POST /v1/license/deactivate'),
  },
  llm: {
    health: call('GET /v1/llm/health', { query: t<{ fresh?: number; scope?: string }>() }),
    keys: call('POST /v1/llm/keys', body()),
  },
  matter: {
    ownerChatFile: call('GET /v1/matter/owner-chat/file', { query: t<{ id:string; i:number; offset:number; sha256?:string; size?:number }>() }),
    ownerChat: call('GET /v1/matter/owner-chat'),
    ownerChatSearch: call('GET /v1/matter/owner-chat/search', { query: t<{ q: string; limit: number }>() }),
  },
  memory: {
    edit: call('POST /v1/memory/edit', body()),
    retractions: call('GET /v1/memory/retractions'),
    restore: call('POST /v1/memory/retractions/restore', body()),
    file: call('GET /v1/memory/file', { query: t<{ user_id: string; path: string }>() }),
    fileWrite: call('POST /v1/memory/file/write', body()),
    files: call('GET /v1/memory/files'),
    profile: call('GET /v1/memory/profile', { query: t<{ chat_id: string }>() }),
    profileStatus: call('GET /v1/memory/profile/status', { query: t<{ chat_id: string }>() }),
    projects: call('GET /v1/memory/projects'),
    view: call('POST /v1/memory/view', body()),
    portrait: call('GET /v1/memory/portrait'),
    portraitGenerate: call('POST /v1/memory/portrait/generate', body()),
    profileGenerate: call('POST /v1/memory/profile/generate', body()),
    source: call('GET /v1/memory/source', { query: t<URLSearchParams>() }),
    sourceReview: call('POST /v1/memory/source/review', body()),
    synthesize: call('POST /v1/memory/synthesize'),
  },
  milestones: { list: call('GET /v1/milestones/list', { query: t<{ chat_id: string }>() }) },
  net: { probe: call('POST /v1/net/probe', body()) },
  observations: {
    list: call('GET /v1/observations/list', { query: t<{ chat_id: string }>() }),
    archive: call('POST /v1/observations/archive', body()),
  },
  pair: {
    accept: call('POST /v1/pair/accept', body()),
    start: call('POST /v1/pair/start'),
  },
  penpal: {
    channels: call('GET /v1/penpal/channels'),
    letters: call('GET /v1/penpal/letters', { query: t<{ channel_id: string }>() }),
    send: call('POST /v1/penpal/letters', body()),
    read: call('POST /v1/penpal/letters/read', body()),
    resend: call('POST /v1/penpal/letters/resend', body()),
  },
  phone: {
    devices: call('GET /v1/phone/devices'),
    link: call('POST /v1/phone/link', body()),
  },
  plugins: {
    list: call('GET /v1/plugins/list'),
    registry: call('GET /v1/plugins/registry'),
    toggle: call('POST /v1/plugins/toggle', body()),
    install: call('POST /v1/plugins/install', body()),
    upgrade: call('POST /v1/plugins/upgrade', body()),
  },
  sessions: {
    projects: call('GET /v1/sessions/projects', { query: t<{ chat?: string }>() }),
    chats: call('GET /v1/sessions/chats'),
    delete: call('POST /v1/sessions/delete', body()),
  },
  reminders: { schedule: call('POST /v1/reminders/schedule', body()) },
  social: {
    enable: call('POST /v1/social/enable', body()),
    inbound: call('GET /v1/social/inbound'),
    setInbound: call('POST /v1/social/inbound', body()),
    introAccept: call('POST /v1/social/intro/accept', body()),
    introDecline: call('POST /v1/social/intro/decline', body()),
    introOffers: call('GET /v1/social/intro/offers'),
    introRequest: call('POST /v1/social/intro/request', body()),
    relationships: call('GET /v1/social/relationships'),
    visit: call('POST /v1/social/visit', body()),
    wish: call('POST /v1/social/wish', body()),
    wishCancel: call('POST /v1/social/wish/cancel', body()),
    wishSend: call('POST /v1/social/wish/send', body()),
    wishes: call('GET /v1/social/wishes'),
  },
  workbench: {
    list: call('GET /v1/workbench', { query: t<URLSearchParams | { limit: number }>() }),
    answer: call('POST /v1/workbench/answer', body()),
    approve: call('POST /v1/workbench/approve', body()),
    archive: call('POST /v1/workbench/archive', body()),
    artifact: call('GET /v1/workbench/artifact', { query: t<{ id: string; artifactId: string }>() }),
    attachment: call('GET /v1/workbench/attachment', { query: t<{ taskId: string; id: string }>() }),
    uploadAttachment: call('POST /v1/workbench/attachment', body()),
    attention: call('GET /v1/workbench/attention'),
    cancel: call('POST /v1/workbench/cancel', body()),
    continue: call('POST /v1/workbench/continue', body()),
    create: call('POST /v1/workbench/create', body()),
    createEntry: call('POST /v1/workbench/create-entry', body()),
    discardAttachment: call('POST /v1/workbench/discard-attachment', body()),
    entryOptions: call('GET /v1/workbench/entry-options'),
    entryReceipt: call('GET /v1/workbench/entry-receipt', { query: t<{ requestId: string }>() }),
    handoff: call('POST /v1/workbench/handoff', body()),
    handoffStatus: call('GET /v1/workbench/handoff', { query: t<{ taskId: string; handoffId: string }>() }),
    handoffPreview: call('POST /v1/workbench/handoff-preview', body()),
    import: call('POST /v1/workbench/import', body()),
    input: call('POST /v1/workbench/input', body()),
    models: call('GET /v1/workbench/models', { query: t<URLSearchParams>() }),
    permission: call('POST /v1/workbench/permission', body()),
    prepareContinuation: call('POST /v1/workbench/prepare-continuation', body()),
    prepareResume: call('POST /v1/workbench/prepare-resume', body()),
    project: call('POST /v1/workbench/project', body()),
    quotaHandoff: call('POST /v1/workbench/quota-handoff', body()),
    review: call('GET /v1/workbench/review', { query: t<{ id: string }>() }),
    reviewComment: call('POST /v1/workbench/review-comment', body()),
    reviewCommentsSend: call('POST /v1/workbench/review-comments-send', body()),
    reviewHunk: call('POST /v1/workbench/review-hunk', body()),
    reviewMark: call('POST /v1/workbench/review-mark', body()),
    reviewReturn: call('POST /v1/workbench/review-return', body()),
    reviewRevert: call('POST /v1/workbench/review-revert', body()),
    rewind: call('POST /v1/workbench/rewind', body()),
    rewindPreview: call('GET /v1/workbench/rewind-preview', { query: t<{ id: string; artifactId: string; to: string }>() }),
    rewindResolve: call('POST /v1/workbench/rewind-resolve', body()),
    scriptApprove: call('POST /v1/workbench/script-approve', body()),
    session: call('GET /v1/workbench/session', { query: t<URLSearchParams>() }),
    sessions: call('GET /v1/workbench/sessions', { query: t<URLSearchParams>() }),
    task: call('GET /v1/workbench/task', { query: t<{ id: string; since?: number; wait_ms?: number }>() }),
    unattendedAck: call('POST /v1/workbench/unattended-ack'),
    withdrawInput: call('POST /v1/workbench/withdraw-input', body()),
    worktree: call('POST /v1/workbench/worktree', body()),
    writerExited: call('POST /v1/workbench/writer-exited', body()),
  },
} as const

export type DesktopCallRequest = CallRequest<DesktopRouteKey>
export type DesktopTransport = (req: DesktopCallRequest) => Promise<unknown>
export type DesktopCallFn<S> = Record<string, never> extends CallArgs<S>
  ? (args?: CallArgs<S>) => Promise<unknown>
  : (args: CallArgs<S>) => Promise<unknown>
type Calls = typeof DESKTOP_CALLS
export type DesktopApi = { readonly [NS in keyof Calls]: { readonly [M in keyof Calls[NS]]: DesktopCallFn<Calls[NS][M]> } }

/** 类型化客户端:`api.workbench.task({ query: { id } })` …,底下是可换的传输。 */
export function makeDesktopApi(send: DesktopTransport): DesktopApi {
  return makeApi(DESKTOP_CALLS, send as (req: CallRequest) => Promise<unknown>) as DesktopApi
}
