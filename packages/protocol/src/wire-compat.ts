/**
 * wire-compat.ts — 冻结的旧线上字段,一行一个(M6b,设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md「定案」)。
 *
 * src 里只剩「步」一种读形状;老客户端还在读的旧形状留在线上,由 daemon 现算。每一行写清:哪个字段、现在从哪推、
 * 什么时候能删。退休按版本不按日期:App 在握手里报 `build`(messages.ts 的 ClientHello),daemon 记每台设备最近一次的构建号;
 * **近 30 天连过的设备都 ≥ 那一版**才删那一行。桌面随版本走。删行是单独的 PR;`scripts/wire-compat.guard.test.ts` 只许行数变少。
 */
export interface WireCompatRow {
  /** 线上的字段(协议包里的形状名 + 字段)。 */
  field: string
  /** 读的人。 */
  readers: readonly ('app' | 'web' | 'desktop')[]
  /** daemon 现在从哪推出它。 */
  derivedFrom: string
  /** 什么时候删这一行(和字段)。 */
  retireWhen: string
}

export const WIRE_COMPAT: readonly WireCompatRow[] = Object.freeze([
  {
    field: 'Matter.status',
    readers: ['app'],
    derivedFrom: 'matters.state + archived_at + 最近一轮 matter_turns.status + 最近一轮上的 ready 步(任务再看 workbench_tasks.status;matters.status 列 v102 已删):src/domain/matters/legacy-status.ts 的 legacyStatus,出口经 wireMatter 插回原位(MattersService.list / detail)。手机网页 M6e 起改读 state / archivedAt(和 daemon 一起部署,退回它只为老 daemon);列表的 ?status= 筛选参数照收',
    retireWhen: '近 30 天连过的设备都 ≥ 改读 Matter.state / archivedAt 的 App 构建(M6f)',
  },
  {
    field: 'MatterDetail.events(MatterEvent)',
    readers: ['app', 'web', 'desktop'],
    derivedFrom: '任务 = 步(matter_items)经 workbench.detail().events;对话 = messages 表(正文唯一来源)',
    retireWhen: '线上有了步的读形状、三端改读之后(还没定;M6 只冻结不删)',
  },
  {
    field: 'WorkbenchTaskEvent(/v1/workbench/task)',
    readers: ['desktop'],
    derivedFrom: '步(matter_items)→ 旧事件形状的投影:src/adapters/store/workbench/timeline-events.ts',
    retireWhen: '桌面 ≥ 改读步的那一版(还没定)',
  },
  {
    field: 'CliActivityItem(/m/api/cli/activity、CliSessionRow.now)',
    readers: ['app', 'web'],
    derivedFrom: '终端那件事的步(payload 就是它);会话还没有那件事时解析记录(M6d 删这条退路)',
    retireWhen: '线上有了步的读形状、App 改读之后(还没定)',
  },
  {
    field: 'topic matter/<id>.phase',
    readers: ['app', 'web'],
    derivedFrom: '任务 = 工作台 phase;其余 = Matter.status(同第一行)',
    retireWhen: '与 Matter.status 同一版(M6f)',
  },
] satisfies WireCompatRow[])

/**
 * 旧路由别名表(P3,设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「定案 · 别名表一处」)。
 *
 * 一行 = 一条旧路径:老 App / 网页还在读的 `/m/api`,或桌面装着的 .app 还在调的 `/v1/workbench/*` 双胞胎(P3e,`desktopAlias`);
 * 目标是一份数据一条 `/v1` 路径、一个处理器。P3a 把 61 条 `/m/api` 全部登记上,
 * 新键先按设计稿写好;还没并的标 `handler: 'own'`(面板里还是它自己的处理器,daemon 不读这张表)。并一条 ⇒ 那行改
 * `handler: 'alias'`,daemon 那边只有 `src/features/phone/legacy-routes.ts` 认这张表(按 `transform` 翻回包)。退休同上面那张表:
 * 按构建号,近 30 天连过的设备都 ≥ 改读新路径的那一版才删行。`scripts/wire-compat.guard.test.ts` 管两把棘轮:行数只许变少,
 * 「还是自己处理器」的行只许变少。
 */
export type WireRouteStep = 'P3c-1' | 'P3c-2' | 'P3c-3' | 'P3c-4' | 'P3d' | 'P3e'
export type RouteRetirement = { client: 'app' | 'web' | 'desktop' | 'selftest'; milestone: string; minimum: string | null }
// P3e 尚未发版:不能拿当前 daemon/package 版本冒充已发布的桌面门槛。
export const ROUTE_RETIREMENT = {
  app: { client: 'app', milestone: 'P3f', minimum: '3' },
  web: { client: 'web', milestone: 'P3g', minimum: 'P3g' },
  desktop: { client: 'desktop', milestone: 'P3e', minimum: '1.7.9' },
  selftest: { client: 'selftest', milestone: 'P3d', minimum: 'P3d' },
} as const satisfies Record<string, RouteRetirement>
export interface WireRouteAlias {
  /** 旧键(`METHOD /m/api/...`,或桌面的 `METHOD /v1/workbench/...`;和 routes.ts 的键同一写法)。 */
  from: string
  /** 新键(`METHOD /v1/...`)。有 `/v1` 双胞胎的就是那条;手机独有的是 P3d 要起的新路径;P3e 是 `/v1/matter/<动词>`。 */
  to: string
  /** 别名的转换名(信封 / phone 错误码列 / 手机默认筛选 / 参数改名);纯改名写 null。实现在 legacy-routes.ts。 */
  transform: string | null
  /** 读的人(selftest = `wechat-cc selftest phone`,daemon 自己带,随改它的 PR 换)。 */
  readers: readonly ('app' | 'web' | 'desktop' | 'selftest')[]
  /** 链接令牌能不能走:照 P3a 那天 routes.ts 的 phone.link 冻结,新行照抄。 */
  link: 'none' | 'read' | 'write'
  /** own = 面板里还是自己的处理器;alias = 已经翻到新键、走同一个分发。 */
  handler: 'own' | 'alias'
  /** 哪一步并它(设计稿「分步」)。 */
  step: WireRouteStep
  retirement: readonly RouteRetirement[]
  /** 什么时候删这一行。 */
  retireWhen: string
}

type Readers = WireRouteAlias['readers']
const RETIRE: Record<Readers[number], string> = {
  app: '近 30 天活跃 App 都 ≥ build 3(P3f)，且近 30 天无别名调用',
  web: '网页改读新路径(P3g,随 self deploy 当场换)',
  selftest: 'selftest 改调新路径(随 P3d 同一个 PR)',
  desktop: '桌面 ≥ P3e 发行版(未发布，版本号待登记)，且近 30 天无别名调用',
}
/**
 * 已并的旧键(handler: 'alias'):面板里没有自己的处理器了,翻到新键走同一个分发(转换在 legacy-routes.ts)。
 * 路由表里已经没有这几行;`routes.ts` 的 `PanelRouteKey` 把它们并进来,老 App 的类型化客户端(phone-calls.ts)和
 * daemon 的别名表照样按键写。每并一条往这里加一个键,删一行别名就从这里删。
 */
export const MERGED_ALIAS_KEYS = [
  'GET /m/api/matters', 'GET /m/api/matter', 'POST /m/api/matter/say',
  'GET /m/api/chat/search', 'GET /m/api/chat/file', 'POST /m/api/chat/transcribe',
  // P3c-2 终端与总览
  'GET /m/api/cli/sessions', 'GET /m/api/today', 'GET /m/api/connections',
  // P3c-3 记忆、待办、看到哪了
  'GET /m/api/memory/retractions', 'POST /m/api/memory/restore', 'POST /m/api/todo', 'POST /m/api/seen',
  // P3c-4 交办选项与会话(分块上传与进度两条不是 /v1 那条的同一个动作,改到 P3d)
  'GET /m/api/entry/options', 'GET /m/api/entry/models', 'POST /m/api/attachment/discard', 'GET /m/api/sessions', 'GET /m/api/session',
  // P3d-1 手机独有的纯改名(transform null):新键的处理器还在面板这一口,别名把路径换成新键交给它,回包原样
  'GET /m/api/state', 'POST /m/api/push/register', 'POST /m/api/push/test',
  'GET /m/api/matter/insight', 'GET /m/api/matter/input-receipt', 'GET /m/api/home', 'GET /m/api/cli/activity', 'GET /m/api/activity',
  'GET /m/api/jobs', 'POST /m/api/jobs/action', 'GET /m/api/letters', 'GET /m/api/letters/page',
  // P3d-2 主人对话、记忆、表情、接着做、分块上传(纯改名,同上)
  'GET /m/api/chat', 'POST /m/api/chat/say', 'GET /m/api/chat/voice', 'GET /m/api/chat/transcribe', 'GET /m/api/chat/model', 'POST /m/api/chat/model',
  'GET /m/api/memory', 'POST /m/api/memory/correct', 'GET /m/api/sticker/', 'GET /m/api/session/continue', 'POST /m/api/session/continue',
  'GET /m/api/attachment/upload', 'POST /m/api/attachment/chunk',
  // P3d-3 撞名的两条起不撞的名字(纯改名,同上)
  'POST /m/api/cli/permission', 'POST /m/api/cli/say',
  // P3e-1 一件事上的动作与交办:翻到 /v1/matter/<动词> 那一个处理器(MattersService 那一层)
  'POST /m/api/matter/stop', 'POST /m/api/matter/permission', 'POST /m/api/matter/answer', 'GET /m/api/matter/artifact',
  'POST /m/api/matter/handoff', 'POST /m/api/matter/worktree', 'POST /m/api/matter/create', 'GET /m/api/matter/create-receipt',
  // P3e-2 撤掉这一轮、改动与逐文件审阅(同上)
  'GET /m/api/matter/rewind', 'POST /m/api/matter/rewind', 'GET /m/api/matter/changes',
  'POST /m/api/matter/review-mark', 'POST /m/api/matter/review-return', 'POST /m/api/matter/review-comment', 'POST /m/api/matter/review-comments-send',
] as const
export type MergedAliasKey = (typeof MERGED_ALIAS_KEYS)[number]
const MERGED: ReadonlySet<string> = new Set(MERGED_ALIAS_KEYS)
const alias = (from: string, to: string, step: WireRouteStep, transform: string | null, readers: Readers = ['app'], link: WireRouteAlias['link'] = 'none'): WireRouteAlias =>
  ({ from, to, transform, readers, link, handler: MERGED.has(from) ? 'alias' : 'own', step, retirement: [...new Set([...readers, 'app', 'web'] as const)].map(r => ROUTE_RETIREMENT[r]), retireWhen: readers.map(r => RETIRE[r]).join(';') })
/**
 * 桌面的旧键(P3e):一件事上的动作收进 `/v1/matter/*` 以后,桌面装着的 .app 还调 `/v1/workbench/*` 双胞胎(tauri 白名单编在 .app 里)。
 * 旧键照旧在路由表里(档位、operator、tauri 不动),处理器就是新键那一个(新键在 operator 范围下认旧键的参数、回旧键的回包),
 * 所以一律纯改名(transform null)、登记即并(handler alias)、链接令牌走不了。daemon 里认它的是 src/daemon/internal-api/legacy-desktop-routes.ts。
 */
const desktopAlias = (from: string, to: string): WireRouteAlias =>
  ({ from, to, transform: null, readers: ['desktop'], link: 'none', handler: 'alias', step: 'P3e', retirement: [ROUTE_RETIREMENT.desktop], retireWhen: RETIRE.desktop })

export const WIRE_ROUTE_ALIASES: readonly WireRouteAlias[] = Object.freeze([
  // ── P3c-1 一件事与主人对话:已并(MERGED_ALIAS_KEYS),一份数据一个 /v1 处理器
  alias('GET /m/api/matters', 'GET /v1/matters', 'P3c-1', 'phoneMatters', ['app'], 'read'),
  alias('GET /m/api/matter', 'GET /v1/matter', 'P3c-1', 'phoneMatter', ['app'], 'read'),
  alias('POST /m/api/matter/say', 'POST /v1/matter/say', 'P3c-1', 'phoneMatterSay'),
  alias('GET /m/api/chat/search', 'GET /v1/matter/owner-chat/search', 'P3c-1', 'phoneChatSearch'),
  alias('GET /m/api/chat/file', 'GET /v1/matter/owner-chat/file', 'P3c-1', 'phoneChatFile'),
  alias('POST /m/api/chat/transcribe', 'POST /v1/companion/transcribe', 'P3c-1', 'phoneChatTranscribe'),
  // ── P3c-2 终端与总览:已并(MERGED_ALIAS_KEYS),一份数据一个 /v1 处理器
  alias('GET /m/api/cli/sessions', 'GET /v1/cli/sessions', 'P3c-2', 'phoneCliSessions'),
  alias('GET /m/api/today', 'GET /v1/overseer/today', 'P3c-2', 'phoneToday'),
  alias('GET /m/api/connections', 'GET /v1/connections', 'P3c-2', 'phoneConnections'),
  // ── P3c-3 记忆、待办、看到哪了:已并(MERGED_ALIAS_KEYS),一份数据一个 /v1 处理器
  alias('GET /m/api/memory/retractions', 'GET /v1/memory/retractions', 'P3c-3', 'phoneMemoryRetractions'),
  alias('POST /m/api/memory/restore', 'POST /v1/memory/retractions/restore', 'P3c-3', 'phoneMemoryRestore'),
  alias('POST /m/api/todo', 'POST /v1/knowledge/facts/set_fact_status', 'P3c-3', 'phoneTodo'),
  alias('POST /m/api/seen', 'POST /v1/journal/seen', 'P3c-3', 'phoneSeen'),
  // ── P3c-4 交办选项与会话:已并(MERGED_ALIAS_KEYS),一份数据一个 /v1 处理器
  alias('GET /m/api/entry/options', 'GET /v1/workbench/entry-options', 'P3c-4', 'phoneEntryOptions'),
  alias('GET /m/api/entry/models', 'GET /v1/workbench/models', 'P3c-4', 'phoneEntryModels'),
  alias('POST /m/api/attachment/discard', 'POST /v1/workbench/discard-attachment', 'P3c-4', 'phoneAttachmentDiscard'),
  alias('GET /m/api/sessions', 'GET /v1/workbench/sessions', 'P3c-4', 'phoneSessions'),
  alias('GET /m/api/session', 'GET /v1/workbench/session', 'P3c-4', 'phoneSession'),
  // 分块上传与进度(P3c-4 核过,改到 P3d):手机是可续传的分块协议(id + draftId + offset,查进度),桌面 `/v1/workbench/attachment`
  // 是一次传完 base64 / 按 taskId 读回材料内容 —— 不是同一个动作,并进去就是「一条路径按调用方做两件事」(设计稿「否决的」)。
  // 起新路径,回包就是 /m/api 今天的回包。
  alias('GET /m/api/attachment/upload', 'GET /v1/workbench/attachment/upload', 'P3d', null),
  alias('POST /m/api/attachment/chunk', 'POST /v1/workbench/attachment/chunk', 'P3d', null),
  // ── P3d 手机独有的、相近的、撞名的:搬到新的 /v1 路径,纯改名(回包就是 /m/api 今天的回包)
  alias('GET /m/api/state', 'GET /v1/phone/state', 'P3d', null),
  alias('POST /m/api/push/register', 'POST /v1/phone/push/register', 'P3d', null),
  alias('POST /m/api/push/test', 'POST /v1/phone/push/test', 'P3d', null),
  alias('GET /m/api/matter/insight', 'GET /v1/matter/insight', 'P3d', null),
  alias('GET /m/api/matter/input-receipt', 'GET /v1/matter/input-receipt', 'P3d', null),
  alias('GET /m/api/home', 'GET /v1/home', 'P3d', null, ['app'], 'read'),
  alias('GET /m/api/cli/activity', 'GET /v1/cli/activity', 'P3d', null),
  alias('GET /m/api/activity', 'GET /v1/activity', 'P3d', null),
  alias('GET /m/api/jobs', 'GET /v1/jobs', 'P3d', null),
  alias('POST /m/api/jobs/action', 'POST /v1/jobs/action', 'P3d', null),
  alias('GET /m/api/letters', 'GET /v1/letters/sent', 'P3d', null),
  alias('GET /m/api/letters/page', 'GET /v1/letters/page', 'P3d', null),
  alias('GET /m/api/chat', 'GET /v1/matter/owner-chat/page', 'P3d', null),
  alias('POST /m/api/chat/say', 'POST /v1/matter/owner-chat/say', 'P3d', null),
  alias('GET /m/api/chat/voice', 'GET /v1/matter/owner-chat/voice', 'P3d', null),
  // 设计稿:「形状一样就并进 GET /v1/stt/status;不一样起 GET /v1/companion/transcribe」—— P3a 核过,不一样(设计稿「进度」)
  alias('GET /m/api/chat/transcribe', 'GET /v1/companion/transcribe', 'P3d', null),
  alias('GET /m/api/chat/model', 'GET /v1/matter/owner-chat/model', 'P3d', null),
  alias('POST /m/api/chat/model', 'POST /v1/matter/owner-chat/model', 'P3d', null),
  alias('GET /m/api/memory', 'GET /v1/memory/curated', 'P3d', null),
  alias('POST /m/api/memory/correct', 'POST /v1/memory/correct', 'P3d', null),
  alias('GET /m/api/sticker/', 'GET /v1/stickers/file/', 'P3d', null),
  alias('GET /m/api/session/continue', 'GET /v1/workbench/session/continue', 'P3d', null),
  alias('POST /m/api/session/continue', 'POST /v1/workbench/session/continue', 'P3d', null),
  // 撞名不同义的两条起不撞的名字(cli/permission 并不并进 /v1/permissions/resolve:P3a 核过,见设计稿「进度」)
  alias('POST /m/api/cli/permission', 'POST /v1/cli/decide', 'P3d', null),
  alias('POST /m/api/cli/say', 'POST /v1/cli/session-say', 'P3d', null),
  // ── P3e 一件事上的动作 + 交办:收进 /v1/matter/*(处理器是 MattersService 那一层)
  alias('POST /m/api/matter/stop', 'POST /v1/matter/stop', 'P3e', 'phoneMatterStop', ['app'], 'write'),
  alias('POST /m/api/matter/permission', 'POST /v1/matter/permission', 'P3e', 'phoneMatterPermission'),
  alias('POST /m/api/matter/answer', 'POST /v1/matter/answer', 'P3e', 'phoneMatterAnswer'),
  alias('GET /m/api/matter/artifact', 'GET /v1/matter/artifact', 'P3e', 'phoneMatterArtifact'),
  alias('POST /m/api/matter/handoff', 'POST /v1/matter/handoff', 'P3e', 'phoneMatterHandoff'),
  alias('POST /m/api/matter/worktree', 'POST /v1/matter/worktree', 'P3e', 'phoneMatterWorktree'),
  alias('GET /m/api/matter/changes', 'GET /v1/matter/changes', 'P3e', 'phoneMatterChanges'),
  alias('POST /m/api/matter/review-mark', 'POST /v1/matter/review-mark', 'P3e', 'phoneMatterReviewMark'),
  alias('POST /m/api/matter/review-return', 'POST /v1/matter/review-return', 'P3e', 'phoneMatterReviewReturn'),
  alias('POST /m/api/matter/review-comment', 'POST /v1/matter/review-comment', 'P3e', 'phoneMatterReviewComment'),
  alias('POST /m/api/matter/review-comments-send', 'POST /v1/matter/review-comments-send', 'P3e', 'phoneMatterReviewCommentsSend'),
  alias('GET /m/api/matter/rewind', 'GET /v1/matter/rewind', 'P3e', 'phoneMatterRewindPreview'),
  alias('POST /m/api/matter/rewind', 'POST /v1/matter/rewind', 'P3e', 'phoneMatterRewind'),
  alias('POST /m/api/matter/create', 'POST /v1/matter/create', 'P3e', 'phoneMatterCreate'),
  alias('GET /m/api/matter/create-receipt', 'GET /v1/matter/create-receipt', 'P3e', 'phoneMatterCreateReceipt'),
  // ── P3e 桌面的双胞胎(读的人 = desktop;旧键还在路由表里,处理器是新键那一个)
  desktopAlias('POST /v1/workbench/cancel', 'POST /v1/matter/stop'),
  desktopAlias('POST /v1/workbench/permission', 'POST /v1/matter/permission'),
  desktopAlias('POST /v1/workbench/answer', 'POST /v1/matter/answer'),
  desktopAlias('GET /v1/workbench/artifact', 'GET /v1/matter/artifact'),
  // 手机的「交给另一位」是额度用完那一个(quota-handoff);/v1/workbench/handoff 是交接预览之后带 token 的另一个动作,不是双胞胎
  desktopAlias('POST /v1/workbench/quota-handoff', 'POST /v1/matter/handoff'),
  desktopAlias('POST /v1/workbench/worktree', 'POST /v1/matter/worktree'),
  desktopAlias('POST /v1/workbench/create-entry', 'POST /v1/matter/create'),
  desktopAlias('GET /v1/workbench/entry-receipt', 'GET /v1/matter/create-receipt'),
  desktopAlias('GET /v1/workbench/rewind-preview', 'GET /v1/matter/rewind'),
  desktopAlias('POST /v1/workbench/rewind', 'POST /v1/matter/rewind'),
  desktopAlias('GET /v1/workbench/review', 'GET /v1/matter/changes'),
  desktopAlias('POST /v1/workbench/review-mark', 'POST /v1/matter/review-mark'),
  desktopAlias('POST /v1/workbench/review-return', 'POST /v1/matter/review-return'),
  desktopAlias('POST /v1/workbench/review-comment', 'POST /v1/matter/review-comment'),
  desktopAlias('POST /v1/workbench/review-comments-send', 'POST /v1/matter/review-comments-send'),
] satisfies WireRouteAlias[])
