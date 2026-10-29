/**
 * routes.ts —— 路由表:每一条 HTTP 路由在各端的登记,**只写在这里一处**(重构第二批 5a,2026-10-20)。
 *
 * 以前一条桌面路由要登记五处(route-tiers 的档位、token-registry 的 operator routeAllow、
 * workbench-proxy.ts 的 ROUTES、lib.rs 的 workbench_request_allowed 和它的测试),手机路由要登记
 * PHONE_ROUTES + LINK_READ_OK / LINK_WRITE_OK。现在这些名单都从下面的 `ROUTES` 推出来:
 *
 * - daemon:`src/daemon/internal-api/route-tiers.ts`(ROUTE_MIN_TIER)、`token-registry.ts`
 *   (operator 的 routeAllow)、`routes-federation.ts` / `selftest.ts`(各自那一条)、
 *   `src/features/phone/phone-routes.ts`(PHONE_ROUTES、LINK_*、LAN_ONLY_OPS、PHONE_TOPICS)—— 名字和类型都没变。
 * - 桌面:`bun run gen:routes` 生成 `apps/desktop/src-tauri/generated/workbench-routes.json`(带 version),
 *   `lib.rs` 用 include_str! 编进去、`apps/desktop/workbench-proxy.ts` import 同一份。生成物进仓库,
 *   `scripts/route-registry.guard.test.ts` 盯着它和这张表一致。
 * - 行为没变的证据:`scripts/fixtures/routes-snapshot-2026-10-20.json` 是改造前 origin/dev 上各份名单的
 *   快照,`scripts/routes-snapshot.guard.test.ts` 断言从表推出来的逐条一致(只比快照里已有的路由)。
 *   加新路由不用碰快照;改了已有路由的档位 / 令牌 / link 或删掉一条,快照测试会红 —— 有意为之就把
 *   快照里那一条一起改,在 PR 里写明。
 *
 * **加一条路由 = 在这里加一行,跑 `bun run gen:routes`。** 处理器照旧写在 routes-*.ts /
 * settings-panel.ts / mobile-*.ts 里;这张表只是数据(不 import 处理器、不 import zod),
 * 手机 App 与 Rust 都能读。档位、令牌种类、link 都是普通字符串,以后加新值不用改类型。
 *
 * 字段:
 * - `desktop`(`/v1/*`,内部 API):
 *   - `tier` 最低档位(guest / trusted / admin);不在表里的 `/v1` 路由按 admin 处理(minTierFor,fail-closed)。
 *   - `tokens` 除了按档位放行之外、**按路由逐条放行**的令牌种类:`operator`(桌面 / CLI 的 admin 凭据,
 *     见 token-registry.ts 的 ROUTE-SCOPING 说明)、`federation`(hearth 铸的短命令牌,只够 knowledge/search)、
 *     `selftest`(`selftest chat` 起的会话,只够 health)。
 *   - `tauri` 打包版 App 的宿主代理(lib.rs workbench_request_allowed)放行;`devProxy` 浏览器预览的 dev 代理
 *     (workbench-proxy.ts)也放行。`devProxy` 必须同时 `tauri`;matter 那几条只走 tauri(dev 代理经 test-shim
 *     另一条路)。`tauri` 必须同时有 `operator` —— 宿主代理拿的就是 operator 凭据。
 *   - `ownerWorkspace` 主人工作区(待办、记下的想法):打包版走 lib.rs 的 `daemon_request` 宿主命令(主人工作区那一半)
 *     (按路径放行,GET / POST 都收),桌面 api.js 的 OWNER_WORKSPACE_PATHS 据此把请求交给宿主,dev 预览的
 *     test-shim.ts 照同一份名单代理。和 `tauri` 互斥(一条路由只走一个宿主命令),必须有 `operator`。
 * - `phone`(`/m`、`/m/api/*`)与 `set`(`/set`、`/set/api/*`):设置面板的令牌(配过对的设备令牌一律能走)。
 *   - `link` 10 分钟链接令牌能不能走:`none` 只给设备、`read` / `write` 要写一句 `reason`
 *     (逐字搬自原来的 LINK_READ_OK / LINK_WRITE_OK,规矩见 phone-routes.ts 的注释)。开成 read / write 的集合
 *     必须**等于**链接页面源码里扫出来的调用(`scripts/link-routes-from-source.guard.test.ts`,理念 2):
 *     页面不调的不开,页面调的不能是 none。
 *   - `lanOnlyOps`:经隧道一律拒的 `/set/api/apply` 操作(原来的 LAN_ONLY_OPS)。
 *   - 以 `/` 结尾的键是前缀(贴纸一族),见 phone-routes.ts 的 phoneRouteAllowed。
 *
 * 这一批不合并命名空间(桌面 `/v1/matter/say` 与手机 `/m/api/matter/say` 仍是两行):手机 App 不能强制升级。
 */

export type RouteKey = `${string} /${string}`

/** 内部 API(`/v1/*`)这一端。 */
export interface DesktopSurface {
  /** 'guest' | 'trusted' | 'admin';普通字符串,向前兼容。 */
  readonly tier: string
  /** 按路由逐条放行的令牌种类:'operator' | 'federation' | 'selftest'。 */
  readonly tokens?: readonly string[]
  /** 打包版宿主代理(lib.rs)放行。 */
  readonly tauri?: true
  /** dev 代理(workbench-proxy.ts)放行。 */
  readonly devProxy?: true
  /** 主人工作区:lib.rs 的 daemon_request(主人工作区那一半)/ api.js 的 OWNER_WORKSPACE_PATHS / test-shim.ts 放行。 */
  readonly ownerWorkspace?: true
}

/** 设置面板(`/set`、`/m`)这一端。 */
export interface PanelSurface {
  /** 链接令牌:'none'(只给设备)| 'read' | 'write'。 */
  readonly link: 'none' | 'read' | 'write'
  /** link 为 read / write 时必填:为什么链接令牌也能走。 */
  readonly reason?: string
  /** 经隧道一律拒的 apply 操作。 */
  readonly lanOnlyOps?: readonly string[]
}

/**
 * 功能模块(第三批 3b;架构终态 A3 起也是「谁挂这条路由」)。名字就是 daemon 子系统的名字(`/v1/health.subsystems[].name`)。
 * 表里标了 `module: X` 的路由:daemon 的路由层按 X 此刻的状态判能不能走(关着 ⇒ module_off、坏了 ⇒ module_degraded、
 * 还没挂上 ⇒ module_starting);处理器由模块 X 自己挂(`internalApi.mount`),不在 internal-api 的总表里。
 */
export const MODULE_NAMES = ['social', 'calendar', 'reminders', 'letters', 'atelier', 'stickers', 'journal', 'voice', 'terminal', 'memory', 'phone', 'workbench', 'companion', 'console'] as const
export type ModuleName = (typeof MODULE_NAMES)[number]

/**
 * 搬家前就有、客户端已经认得的「没准备好」码(架构终态 A5 · 工作台):这几个模块不是 ok(还没挂上 / 关着 / 坏了)时,
 * 模块门回 503 `{ error: 这个码 }`(原样,不带 module / detail),不回 module_starting / module_off / module_degraded。
 *
 * 工作台:搬家前 44 条 /v1/workbench/* 的处理器各自回 503 workbench_not_wired(workbench 是必需模块,
 * 只有开机途中、或上游没起来时才不在);桌面与 workbench-errors 表认的就是这个码(10-21 那次就是字面量 503
 * 和表里 500 对不上)。换成 module_* 是看得见的变化,不在搬家里做。
 */
export const MODULE_UNAVAILABLE_CODE: Partial<Record<ModuleName, string>> = { workbench: 'workbench_not_wired' }

export interface RouteSpec {
  /**
   * 这条路由属于哪个模块:那个模块此刻不是 ok ⇒ daemon 在**鉴权之后**、处理器之前统一回
   * 503 `module_off`(主人关的)/ `module_degraded`(开着但没起来,带原因),处理器里不用再写分支。
   * 只给「模块没起来就做不了」的路由标;开关路由本身(`POST /v1/social/enable`)和不依赖模块的读
   * (关系视图、入站设置)不标。不进 gen:routes 的生成物(壳不需要知道,改它不用发版)。
   */
  readonly module?: ModuleName
  readonly desktop?: DesktopSurface
  readonly phone?: PanelSurface
  readonly set?: PanelSurface
}

/**
 * operator 令牌为什么能走这些路由(原 token-registry.ts registerOperatorToken 里的逐条注释,原样搬来;
 * 每段后面是它说的那几条)。新给 operator 加一条,在这里补一句。
 *
 *   → POST /v1/companion/converse, POST /v1/companion/speak, POST /v1/companion/transcribe
 *
 *
 * 待办 workspace (2026-08-24) — same owner-only trust class and the
 * same delivery channel (the Tauri host's owner-workspace command;
 * webview JS never holds this token): obligation list + status
 * writes, contact display names, reminder scheduling.
 *   → POST /v1/knowledge/facts/find_facts, POST /v1/llm/keys
 *
 * Owner's retained thoughts, read through the desktop host only.
 *   → GET /v1/companion/thoughts, POST /v1/knowledge/facts/set_fact_status, POST /v1/knowledge/graph/top_contacts, POST /v1/reminders/schedule
 *
 * 桌宠权限卡片(spec 2026-09-05-cc-desktop-pet §6)—— 主人在陪伴窗上
 * 点「允许 / 拒绝」,经 Tauri 的 pet_permission_resolve 命令走这一条。
 * 路由本身是 admin 档(route-tiers),所以只有这个 operator 凭据够得着;
 * 少了这一行,按钮按下去必然 403 route_not_allowed(2026-09-05 终审
 * Critical #1)。**只加 resolve,不加 GET /v1/permissions/pending**:
 * 这个集合的口径是「桌面 app 真会调的那几条」,而待决列表桌面是从
 * GET /v1/companion/pet(trusted 档)读的,operator 凭据永远不会去
 * 调 /v1/permissions/pending —— 不调的就不给。
 *   → POST /v1/permissions/resolve
 *
 * hearth federation mint (grant-gated, see routes-federation.ts) —
 * the operator token alone is not enough; readGrant(stateDir) must
 * also be non-null (explicit owner authorization, design option B).
 *   → POST /v1/federation/mint
 *
 * Owner Workbench (2026-09-11) — the Tauri host proxies these
 * requests with this operator credential; the webview never sees
 * the token. Keep the grant to the exact Workbench methods.
 *   → GET /v1/workbench/entry-options, POST /v1/workbench/create-entry, GET /v1/workbench/entry-receipt, POST /v1/workbench/attachment, GET /v1/workbench/attachment, POST /v1/workbench/discard-attachment, GET /v1/workbench
 *
 * 「一件事」三条:桌面 / 手机都从这里读同一份列表(2026-09-16)。
 *   → GET /v1/matters, GET /v1/matter, GET /v1/matter/owner-chat, GET /v1/matter/owner-chat/search, POST /v1/matter/say
 *
 * 「CC 的连接」:桌面「此刻」右上角的连接浮层(2026-10-01)。
 *   → GET /v1/connections
 *
 * 桌面「连接手机」(plan 7a):设置抽屉弹层与引导页的码、轮询「已连上」。
 *   → POST /v1/phone/link, GET /v1/phone/devices, GET /v1/workbench/models, GET /v1/workbench/sessions, GET /v1/workbench/session, GET /v1/workbench/task, POST /v1/workbench/project, POST /v1/workbench/create, POST /v1/workbench/continue, POST /v1/workbench/cancel, GET /v1/workbench/artifact, POST /v1/workbench/approve, POST /v1/workbench/permission, POST /v1/workbench/archive, POST /v1/workbench/writer-exited, POST /v1/workbench/unattended-ack, GET /v1/workbench/review, POST /v1/workbench/review-mark, POST /v1/workbench/review-return, POST /v1/workbench/review-revert, POST /v1/workbench/review-comment, POST /v1/workbench/review-comments-send, POST /v1/workbench/review-hunk, POST /v1/workbench/worktree, POST /v1/workbench/script-approve, GET /v1/workbench/rewind-preview, POST /v1/workbench/rewind, POST /v1/workbench/rewind-resolve, POST /v1/workbench/import, POST /v1/workbench/prepare-resume, POST /v1/workbench/prepare-continuation, POST /v1/workbench/quota-handoff, POST /v1/workbench/handoff-preview, POST /v1/workbench/handoff, GET /v1/workbench/handoff, GET /v1/workbench/attention, POST /v1/workbench/input, POST /v1/workbench/answer, POST /v1/workbench/withdraw-input
 *
 * 自维护三件套(spec 2026-09-18-self-maintenance §1/§2) — the
 * `wechat-cc selftest chat` CLI drives this route with the SAME
 * operator token it uses for Workbench above (own credential
 * read from internal-api-info.json, never the shared trusted
 * file token). The desktop app itself never calls this route.
 *   → POST /v1/selftest/converse
 *
 * 自改流水线(spec 2026-09-18-self-change-pipeline §daemon 侧)——
 * `wechat-cc self change` 跑在 daemon 外面,用的是和 Workbench /
 * selftest 同一份 operator 凭据(从 internal-api-info.json 读,不是
 * 共享的 trusted 文件 token)。三条路由都是 admin 档,少了这三行
 * 自改一开口就 403 route_not_allowed。
 *   → POST /v1/self-change/notice, POST /v1/self-change/ask, GET /v1/self-change/decision
 *
 * `wechat-cc selftest phone` 用这份 operator 凭据取配对链接 —— 路由 plan 7a 起是 admin 档
 * (铸 admin 链接令牌),共享的 trusted 文件 token 够不着了。桌面不再调它(改走 /v1/phone/link)。
 *   → GET /v1/settings/link
 *
 * `wechat-cc cli upgrade|rollback`(外部 agent CLI 自动升级,2026-10-04):同一份 operator 凭据,
 * admin 档。桌面不调(状态从 /v1/health 的 cli_upgrade 读)。
 *   → POST /v1/cli/upgrade, POST /v1/cli/rollback
 *
 * 终端会话登记处(v76,2026-10-14):CC 统管主人所有终端 agent 会话的只读列表。admin 档,
 * 同一份 operator 凭据。桌面「此刻」的等你行读它(2026-10-14):Tauri 宿主(lib.rs)与
 * workbench-proxy.ts 都已登记;拍板不走这条,走 POST /v1/permissions/resolve。
 *   → GET /v1/cli/sessions
 *
 * 「今天」一眼看完(2026-10-14):同一份 operator 凭据,admin 档、只读。桌面暂不调(保持简单)。
 *   → GET /v1/overseer/today
 *
 * 接上 / 撤掉终端里的 Claude Code / Codex(2026-10-14):桌面「CC 现在怎么样」与引导页的「接上」/「修复」。
 * admin 档,同一份 operator 凭据;Tauri 宿主(lib.rs)与 workbench-proxy.ts 都已登记。
 *   → POST /v1/cli/hooks/install, POST /v1/cli/hooks/uninstall
 *
 * CC 的信(2026-10-16):`wechat-cc` 与维护者自检用同一份 operator 凭据看状态、当面写一封、开关。admin 档。
 *   → GET /v1/letters, POST /v1/letters/write, POST /v1/letters/settings
 *
 * 记忆编辑(2026-10-23,设计稿 2026-10-23-memory-edits-stick-design):主人在记忆页上改生成的记忆 = 更正 + 主人原话,
 * 改的是主人自己的记忆,只给主人。trusted 档的那把 file token 也在别人对话的会话手里,所以不能走 trusted;
 * `wechat-cc memory view|edit` 与桌面(经宿主)用 operator 凭据。
 *   → POST /v1/memory/view, POST /v1/memory/edit
 *
 * 桌面不再起 CLI(架构终态 F6,主人 2026-10-26 拍板):桌面以前 `wechat_cli_json` 读写的主人私事(记忆文件整份读写、画像、
 * 本机项目记忆、对话页、会话名单、观察 / 里程碑 / 决策、头像、allowlist 里的 admins、对话模式快照)改走这些路由,
 * 经宿主代理(daemon_request)用 operator 凭据。不能是 trusted:trusted 那把 file token 别人对话的会话手里也有,
 * 这些都是别人的聊天记录 / 主人的记忆。处理器在 src/features/console 与 src/features/memory/owner-routes.ts,
 * 每条调的是原来那条 CLI 命令调的同一个函数、回同一个形状。
 *   → GET /v1/memory/files, GET /v1/memory/file, POST /v1/memory/file/write, GET /v1/memory/profile, GET /v1/memory/profile/status, GET /v1/memory/projects, GET /v1/conversations/list, GET /v1/observations/list, POST /v1/observations/archive, GET /v1/milestones/list, GET /v1/events/list, GET /v1/access/list, GET /v1/avatar/info, POST /v1/avatar/set, POST /v1/avatar/remove, GET /v1/sessions/projects, GET /v1/sessions/chats, POST /v1/sessions/delete, GET /v1/dialogue/timeline, GET /v1/dialogue/threads, GET /v1/dialogue/thread, GET /v1/dialogue/search, POST /v1/dialogue/unlock
 */
const ROUTE_TABLE = {
  // ── 内部 API(/v1/*)。注释原样搬自 route-tiers.ts 的 ROUTE_MIN_TIER ─────────────────────
  // Owner Workbench: task instructions and generated artifacts are private.
  'GET /v1/workbench/entry-options': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/create-entry': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/entry-receipt': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 「一件事」(2026-09-16):任务指令、聊天都是主人的私事。
  // 桌面(原 lib.rs 注释):「一件事」的 matter 列表与会话面、此刻里搜主人那条对话。只走 tauri:dev 代理经 test-shim 另一条路。
  'GET /v1/matter/owner-chat/file': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  'GET /v1/matters': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  'GET /v1/matter': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  'GET /v1/matter/owner-chat': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  'GET /v1/matter/owner-chat/search': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  'POST /v1/matter/say': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true } },
  // 「CC 的连接」:带插件目录与原因,只给 admin。
  'GET /v1/connections': { desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 桌面「连接手机」(plan 7a):铸 admin 链接令牌 / 打开远程隧道,只给 operator 凭据。
  // 桌面(原 lib.rs 注释):出码(必要时打开远程隧道)与轮询已配对设备。
  'POST /v1/phone/link': { module: 'phone', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/phone/devices': { module: 'phone', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/models': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/attachment': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/attachment': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/discard-attachment': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/attention': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/input': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/answer': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/withdraw-input': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/sessions': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/session': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/task': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/project': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/create': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/continue': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/cancel': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/artifact': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/approve': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/permission': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/archive': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/writer-exited': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/unattended-ack': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/review': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/review-mark': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/review-return': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/review-revert': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 行评论 / 按块撤回(2026-10-21)
  'POST /v1/workbench/review-comment': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/review-comments-send': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/review-hunk': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/worktree': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/script-approve': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 回到某一轮(2026-10-21):预览 / 执行 + 撤销 / 停住后主人拍板
  'GET /v1/workbench/rewind-preview': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/rewind': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/rewind-resolve': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/import': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/prepare-resume': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/prepare-continuation': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/quota-handoff': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/handoff-preview': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/workbench/handoff': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/workbench/handoff': { module: 'workbench', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // guest — liveness + read/reply
  'GET /v1/health': { desktop: { tier: 'guest', tokens: ['selftest'] } },
  'POST /v1/wechat/reply': { desktop: { tier: 'guest' } },
  // 回复交付(spec 2026-10-03 §4.5):语音 / 表情附件与 reply 同级;文件附件在 handler 里再收紧到 trusted
  // (与 send_file 同级)。目标永远是会话令牌里的 chat,不收 chat_id。
  'POST /v1/turn/attach': { desktop: { tier: 'guest' } },
  // §4.6:往别处发(别的聊天 / 主人微信 / 群发)只给 admin;trusted / guest 根本不注册这个工具。
  'POST /v1/wechat/message': { desktop: { tier: 'admin' } },
  'POST /v1/wechat/reply_voice': { module: 'voice', desktop: { tier: 'guest' } },
  'POST /v1/memory/read': { module: 'memory', desktop: { tier: 'guest' } },
  'GET /v1/memory/list': { module: 'memory', desktop: { tier: 'guest' } },
  'POST /v1/share/page': { desktop: { tier: 'guest' } },
  'POST /v1/share/resurface': { desktop: { tier: 'guest' } },
  'GET /v1/companion/status': { module: 'companion', desktop: { tier: 'guest' } },
  // send_sticker draws only from the curated sticker lib (pre-approved
  // images, no arbitrary-path read) and has no exfiltration surface —
  // same trust class as reply/reply_voice, so it's guest not trusted.
  'POST /v1/wechat/send_sticker': { module: 'stickers', desktop: { tier: 'guest' } },
  'POST /v1/wechat/search_online_sticker': { module: 'stickers', desktop: { tier: 'guest' } },
  'POST /v1/wechat/search_online_sticker_candidates': { module: 'stickers', desktop: { tier: 'guest' } },
  'POST /v1/wechat/send_online_sticker_candidate': { module: 'stickers', desktop: { tier: 'guest' } },
  'POST /v1/wechat/sticker_feedback': { module: 'stickers', desktop: { tier: 'guest' } },
  'GET /v1/stickers': { module: 'stickers', desktop: { tier: 'guest' } },
  // reminders — scope (own chat only for session callers) is enforced in
  // routes-reminders.ts; the tier floor is guest ("提醒我" is harmless).
  'POST /v1/reminders/schedule': { module: 'reminders', desktop: { tier: 'guest', tokens: ['operator'], ownerWorkspace: true } },
  'POST /v1/reminders/cancel': { module: 'reminders', desktop: { tier: 'guest' } },
  'GET /v1/reminders/list': { module: 'reminders', desktop: { tier: 'guest' } },
  // trusted — operator/agent ops (also reachable by the CLI, capped at trusted)
  'POST /v1/wechat/broadcast': { desktop: { tier: 'trusted' } },
  'POST /v1/wechat/send_file': { desktop: { tier: 'trusted' } },
  'POST /v1/wechat/edit_message': { desktop: { tier: 'trusted' } },
  'POST /v1/memory/write': { module: 'memory', desktop: { tier: 'trusted' } },
  'POST /v1/memory/delete': { module: 'memory', desktop: { tier: 'trusted' } },
  'POST /v1/user/set_name': { desktop: { tier: 'trusted' } },
  'POST /v1/voice/save_config': { module: 'voice', desktop: { tier: 'trusted' } },
  'GET /v1/voice/status': { module: 'voice', desktop: { tier: 'trusted' } },
  'POST /v1/stt/save_config': { module: 'voice', desktop: { tier: 'trusted' } },
  'GET /v1/stt/status': { module: 'voice', desktop: { tier: 'trusted' } },
  'POST /v1/companion/enable': { module: 'companion', desktop: { tier: 'trusted' } },
  'POST /v1/companion/disable': { module: 'companion', desktop: { tier: 'trusted' } },
  'POST /v1/companion/snooze': { module: 'companion', desktop: { tier: 'trusted' } },
  'POST /v1/companion/import-local': { module: 'companion', desktop: { tier: 'trusted' } },
  'GET /v1/companion/presence': { desktop: { tier: 'trusted' } },
  // CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。trusted,和
  // presence 同一类:桌面的唯一凭据是 daemon 级 0600 FILE token(=trusted),
  // admin 会让每一次真机轮询 403 —— 觅食台 2026-07-22 就是这么静默坏的。
  'GET /v1/companion/pet': { desktop: { tier: 'trusted' } },
  'POST /v1/conversation/set-mode': { desktop: { tier: 'trusted' } },
  'GET /v1/projects/list': { desktop: { tier: 'trusted' } },
  'POST /v1/projects/add': { desktop: { tier: 'trusted' } },
  'POST /v1/projects/remove': { desktop: { tier: 'trusted' } },
  'POST /v1/projects/switch': { desktop: { tier: 'trusted' } },
  'GET /v1/a2a/list': { desktop: { tier: 'trusted' } },
  'GET /v1/a2a/info': { desktop: { tier: 'trusted' } },
  'GET /v1/a2a/activity': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/preview': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/install': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/remove': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/pause': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/send': { desktop: { tier: 'trusted' } },
  'POST /v1/a2a/test': { desktop: { tier: 'trusted' } },
  'GET /v1/plugins/list': { desktop: { tier: 'trusted' } },
  'POST /v1/plugins/toggle': { desktop: { tier: 'trusted' } },
  'GET /v1/plugins/registry': { desktop: { tier: 'trusted' } },
  'POST /v1/plugins/install': { desktop: { tier: 'trusted' } },
  'POST /v1/plugins/upgrade': { desktop: { tier: 'trusted' } },
  'GET /v1/license/status': { desktop: { tier: 'trusted' } },
  'POST /v1/license/activate': { desktop: { tier: 'trusted' } },
  'POST /v1/license/deactivate': { desktop: { tier: 'trusted' } },
  'POST /v1/delegate': { desktop: { tier: 'trusted' } },
  // 终端 claude / codex 的 hook 事件(spec 2026-09-09-cli-hook-push):hook 子命令
  // 拿的是 FILE token(= trusted)。
  'POST /v1/cli/event': { module: 'terminal', desktop: { tier: 'trusted' } },
  'POST /v1/cli/permission': { module: 'terminal', desktop: { tier: 'trusted' } },
  'GET /v1/cli/permission': { module: 'terminal', desktop: { tier: 'trusted' } },
  // 终端会话登记处(v76):列出主人所有终端会话的路径、最后一句、等批准的命令 —— 主人的私事,admin。
  // 桌面(原 lib.rs / workbench-proxy.ts 注释):此刻「N 件事等你」里列出终端里等批准的 Claude Code / Codex,只读。
  // 拍板不走这里,走 pet_permission_resolve(POST /v1/permissions/resolve)。
  'GET /v1/cli/sessions': { module: 'terminal', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // CC 代主人对终端会话说一句、等它回话(terminal_say,2026-10-24):往主人终端里正在干活的会话里送话 —— admin,
  // 不给 operator(桌面 / CLI 没有这个入口;主人自己说走微信「@码」/ 手机)。路由里另外只认主人那条聊天的会话令牌。
  'POST /v1/cli/say': { module: 'terminal', desktop: { tier: 'admin' } },
  'GET /v1/cli/say': { module: 'terminal', desktop: { tier: 'admin' } },
  // 「今天」一眼看完(2026-10-14):同上一份登记处 + 一起做的标题与待批 —— 主人的私事,admin。
  'GET /v1/overseer/today': { module: 'terminal', desktop: { tier: 'admin', tokens: ['operator'] } },
  // 读日历(对标 #8):日程是主人的私事。
  'GET /v1/calendar/agenda': { module: 'calendar', desktop: { tier: 'admin' } },
  // 接上 / 撤掉终端里的 Claude Code / Codex(2026-10-14):改主人 ~/.claude/settings.json 与 $CODEX_HOME/hooks.json,admin。
  // 桌面(原 lib.rs 注释):「CC 现在怎么样」与引导页的「接上」/「修复」,主人点了确认才调。
  'POST /v1/cli/hooks/install': { module: 'terminal', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/cli/hooks/uninstall': { module: 'terminal', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // CC 的信(2026-10-16):信是写给主人的私事;开关改主人的 companion 配置。admin。
  'GET /v1/letters': { module: 'letters', desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/letters/write': { module: 'letters', desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/letters/settings': { module: 'letters', desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/chat-prefs': { desktop: { tier: 'trusted' } },
  // POST /v1/stickers writes an arbitrary sourcePath into the lib — same
  // trust class as send_file, so it's trusted not guest.
  'POST /v1/stickers': { module: 'stickers', desktop: { tier: 'trusted' } },
  // 社交总开关。trusted 而非 admin:桌面端的凭证是 daemon 全局 FILE token
  // (=trusted,见 api-info),admin 会让每一次真机点击 403 —— 2026-07-22 那个
  // P0 就是这么来的。**发版评审时请连同同族 trusted 路由一起过一遍。**
  'POST /v1/social/enable': { desktop: { tier: 'trusted' } },
  // 心愿 (spec 2026-09-04-wish-postcard §4) — same trust class as the old
  // P4 propose/confirm/cancel it replaces: the CLI/desktop's only credential
  // is the daemon-wide FILE token (trusted); an admin-tiered route here
  // would 403 every CLI/desktop call. send IS the real "broadcast to
  // strangers" step, so FLAG all four for the release security review.
  'POST /v1/social/wish': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/social/wish/send': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/social/wish/cancel': { module: 'social', desktop: { tier: 'trusted' } },
  'GET /v1/social/wishes': { module: 'social', desktop: { tier: 'trusted' } },
  // 介绍 (spec 2026-09-04-introduction) — same trust class as the wish
  // routes above: CLI/desktop's only credential is the daemon-wide FILE
  // token (trusted); an admin-tiered route here would 403 every real call.
  'POST /v1/social/intro/request': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/social/intro/accept': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/social/intro/decline': { module: 'social', desktop: { tier: 'trusted' } },
  'GET /v1/social/intro/offers': { module: 'social', desktop: { tier: 'trusted' } },
  // admin — owner-only same-session power: drives a real turn on the
  // owner's own chat session and returns the reply to the caller (app
  // conversation channel, voice arc Stage 0). Same trust class as the
  // other admin daemon-control routes below.
  // admin — 待决权限的桌面面(spec §6)。读出来的是 agent 想动的手(命令原文),
  // 拍板等于替主人说「可以」—— 和 converse 同一个信任等级:主人本人的事,不是
  // 任何 trusted 联系人的事。微信侧的对应面是「y/n <hash>」,只认 admin 主人。
  'GET /v1/permissions/pending': { desktop: { tier: 'admin' } },
  'POST /v1/permissions/resolve': { desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin — 自改流水线的三个抓手(spec 2026-09-18-self-change-pipeline)。
  // notice 往主人微信里发字,ask 替主人开一张 y/n 卡片,decision 读主人拍了什么:
  // 三条都是「代表主人」,和上面两条权限面同一档。调用方是 operator 凭据。
  'POST /v1/self-change/notice': { desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/self-change/ask': { desktop: { tier: 'admin', tokens: ['operator'] } },
  'GET /v1/self-change/decision': { desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/companion/converse': { desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin — same trust class as converse above (voice arc Stage 1): synths
  // reply audio for the owner's app-conversation-channel session.
  'POST /v1/companion/speak': { module: 'voice', desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin — voice arc Stage 2: transcribes inbound app-channel audio to text.
  'POST /v1/companion/transcribe': { module: 'voice', desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin — daemon-control (daemon_introspect / daemon_remediate)
  'GET /v1/turns': { desktop: { tier: 'admin' } },
  'GET /v1/sessions': { desktop: { tier: 'admin' } },
  'GET /v1/model': { desktop: { tier: 'admin' } },
  'POST /v1/sessions/release': { desktop: { tier: 'admin' } },
  'POST /v1/model': { desktop: { tier: 'admin' } },
  'POST /v1/daemon/restart': { desktop: { tier: 'admin' } },
  // 自维护三件套(spec 2026-09-18-self-maintenance §1)——同上一类:一次真实
  // spawn,只是权限比 companion/converse 还窄(session token 只放行
  // GET /v1/health)。admin 而非 trusted:允许任何持 file token 的会话
  // 白嫖 daemon 去开一整条真会话,不该比 daemon-control 的其它成员松。
  'POST /v1/selftest/converse': { desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin —— 换主人电脑上的软件版本(外部 agent CLI 自动升级,2026-10-04);`wechat-cc cli` 用 operator 凭据调。
  'POST /v1/cli/upgrade': { desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/cli/rollback': { desktop: { tier: 'admin', tokens: ['operator'] } },
  // admin — on-demand file locate over the owner's computer (file_locate)
  'GET /v1/locate': { desktop: { tier: 'admin' } },
  // trusted — 觅食台 inbound toggle. DEMOTED admin→trusted 2026-07-22: the
  // desktop's ONLY credential is the daemon-wide FILE token (= trusted;
  // `daemon api-info` hands out the file token, and the admin operator
  // token is route-scoped to converse/speak) — admin here 403'd every
  // real-daemon 觅食台 read, silently rendering "社交觅食未启用" even when
  // wired. Found by live visual acceptance; same root cause as the earlier
  // reveal-route demotion below. localhost-only, 0600 file token.
  // ⚠️ RELEASE-REVIEW FLAG (surface at next dev→master).
  'GET /v1/social/inbound': { desktop: { tier: 'trusted' } },
  'POST /v1/social/inbound': { desktop: { tier: 'trusted' } },
  'GET /v1/social/relationships': { desktop: { tier: 'trusted' } },
  'POST /v1/social/visit': { module: 'social', desktop: { tier: 'trusted' } },
  // 打猎战利品(2026-09-03)。trusted 而非 admin:桌面端的凭证是 daemon 级
  // FILE token(=trusted),admin 会让每一次真实的桌面读 403 —— 觅食台的读
  // 路由 2026-07-22 正是这么静默坏了一个多月。写的两个也是 trusted:它们
  // 只改主人自己那份清单的状态,不外发、不触网。
  // 背包后来也装串门见闻 / 明信片 / 回忆,不只是打猎的:这几条归日志模块(src/features/journal)。
  'GET /v1/companion/thoughts': { module: 'companion', desktop: { tier: 'admin', tokens: ['operator'], ownerWorkspace: true } },
  'GET /v1/journal': { module: 'journal', desktop: { tier: 'trusted' } },
  'GET /v1/journal/postcards': { module: 'journal', desktop: { tier: 'trusted' } },
  'POST /v1/journal/favorite': { module: 'journal', desktop: { tier: 'trusted' } },
  'POST /v1/journal/status': { module: 'journal', desktop: { tier: 'trusted' } },
  'POST /v1/journal/seen': { module: 'journal', desktop: { tier: 'trusted' } },
  'POST /v1/journal/remove': { module: 'journal', desktop: { tier: 'trusted' } },
  // trusted — 配对码 (spec §7). Same trust class as a2a/send + social wish:
  // internal-api is 127.0.0.1 + 0600 file token; the CLI holds the FILE token
  // (trusted). Acts on an operator-driven pairing, not a world-open broadcast.
  'POST /v1/pair/start': { desktop: { tier: 'trusted' } },
  'POST /v1/pair/accept': { desktop: { tier: 'trusted' } },
  // 笔友信箱(spec 2026-07-22-penpal-mailbox-desktop)。读=admin(P2
  // seeks/echoes 读路由先例:桌面 token 是 admin)。发信=trusted —
  // ⚠️ RELEASE-REVIEW FLAG(下次 dev→master 发布时在 PR body surface):
  // 作用于已互揭的既有信道(同 reveal / a2a/send 类),不产生新广播或
  // 新关系;localhost-only internal-api + 0600 文件 token。顺带解锁
  // 未来的 CLI 回信入口。
  // (2026-07-22 same-day demotion: reads were born admin copying the P2
  // precedent — which the live acceptance above proved wrong for the
  // desktop's trusted file token. All four are trusted now.)
  'GET /v1/penpal/channels': { module: 'social', desktop: { tier: 'trusted' } },
  'GET /v1/penpal/letters': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/penpal/letters': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/penpal/letters/read': { module: 'social', desktop: { tier: 'trusted' } },
  'POST /v1/penpal/letters/resend': { module: 'social', desktop: { tier: 'trusted' } },
  // LLM 记忆操作(spec 2026-07-23-daemon-owns-llm-memory-ops)。trusted:桌面/CLI
  // 唯一凭据是 0600 文件 token;localhost、动主人自己的记忆、烧一次 LLM。
  // ⚠️ RELEASE-REVIEW FLAG(下次 dev→master surface)。
  'POST /v1/memory/synthesize': { module: 'memory', desktop: { tier: 'trusted' } },
  'POST /v1/memory/nightly/run': { module: 'memory', desktop: { tier: 'trusted' } },
  'GET /v1/memory/source': { module: 'memory', desktop: { tier: 'trusted' } },
  'POST /v1/memory/source/review': { module: 'memory', desktop: { tier: 'trusted' } },
  'POST /v1/memory/profile/generate': { module: 'memory', desktop: { tier: 'trusted' } },
  // 桌面经宿主调(F6 起,以前桌面起 `wechat-cc memory view|edit`):打 tauri / devProxy。
  'POST /v1/memory/view': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/memory/edit': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 收回的话(架构终态 G6):和记忆编辑同一档,桌面经宿主调。
  'GET /v1/memory/retractions': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/memory/retractions/restore': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  // 桌面不再起 CLI(架构终态 F6):主人私事,admin + operator,经宿主代理。理由见文件头 operator 那一段。
  'GET /v1/memory/files': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/memory/file': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/memory/file/write': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/memory/profile': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/memory/profile/status': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/memory/projects': { module: 'memory', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/conversations/list': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/observations/list': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/observations/archive': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/milestones/list': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/events/list': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/access/list': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/avatar/info': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/avatar/set': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/avatar/remove': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/sessions/projects': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/sessions/chats': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/sessions/delete': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/dialogue/timeline': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/dialogue/threads': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/dialogue/thread': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/dialogue/search': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'POST /v1/dialogue/unlock': { module: 'console', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true } },
  'GET /v1/llm/health': { desktop: { tier: 'trusted' } },
  'POST /v1/net/probe': { desktop: { tier: 'trusted' } },
  'POST /v1/llm/keys': { desktop: { tier: 'admin', tokens: ['operator'], ownerWorkspace: true } },
  // 铸的是 admin 档链接令牌(手机拿去配对),trusted 的普通聊天会话不能够着(spec 2026-10-01-tendhearth-pairing-ux §11.7,
  // plan 7a 修)。调用方:selftest phone 用 operator 凭据;微信 /set 走进程内 settingsPanelLink(),不经 HTTP。
  'GET /v1/settings/link': { desktop: { tier: 'admin', tokens: ['operator'] } },
  'POST /v1/memory/portrait/generate': { module: 'memory', desktop: { tier: 'trusted' } },
  'GET /v1/memory/portrait': { module: 'memory', desktop: { tier: 'trusted' } },
  // 桌面读故障记录以显示"上次故障"横幅。trusted:桌面/CLI 的唯一凭据是
  // 0600 文件 token;内容只有时间戳与分类,不含聊天数据。
  'GET /v1/health/incidents': { desktop: { tier: 'trusted' } },
  'GET /v1/atelier/works': { module: 'atelier', desktop: { tier: 'trusted' } },
  'GET /v1/atelier/model-status': { module: 'atelier', desktop: { tier: 'trusted' } },
  // Explicit desktop action; sends only to companion.default_chat_id and
  // never accepts a caller-controlled recipient.
  'POST /v1/atelier/share': { module: 'atelier', desktop: { tier: 'trusted' } },
  // Knowledge Kernel (Phase 01, T3, docs/superpowers/specs/
  // 2026-07-12-knowledge-kernel-phase01-design.md "Knowledge API").
  // Ingest = admin/internal only: source/put and semantic/put are written
  // by daemon-internal jobs (the wxvault source adapter, wxsearch's
  // indexer) — no ordinary chat session has business writing into the
  // owner's message store, so these fail closed at admin (same trust
  // class as the rest of the owner workspace: raw wxvault-derived content).
  'POST /v1/knowledge/source/put': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/semantic/put': { desktop: { tier: 'admin' } },
  // Query = admin-only (NOT trusted), same as ingest above. These read the
  // owner's full indexed cross-conversation message archive back out (raw
  // source pages + semantic search over message text) with an optional,
  // caller-supplied `conversation` filter — a non-owner `trusted` WeChat
  // contact (who legitimately holds a session internal-api token, e.g. via
  // POST /v1/a2a/send-class routes) could otherwise page every conversation
  // in the store, not just their own. Knowledge query is admin-only until
  // per-caller conversation scoping (memoryScopeDenied-style, see
  // routes.ts's memoryScopeDenied) exists — opening it to `trusted` without
  // that would let a trusted contact read the owner's full cross-conversation
  // archive. Revisit once that scoping lands or a real "agent" caller
  // identity beyond trusted/admin exists.
  'GET /v1/chat/history': { desktop: { tier: 'admin' } },
  'GET /v1/knowledge/messages': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/search': { desktop: { tier: 'admin', tokens: ['federation'] } },
  'GET /v1/knowledge/semantic/status': { desktop: { tier: 'admin' } },
  // Graph Query (Knowledge Graph inproc, Task 5) — same admin-only trust
  // class as the search/messages routes above: reads the owner's full
  // contact/relationship graph, not just the current caller's own scope.
  'POST /v1/knowledge/graph/contact_profile': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/graph/top_contacts': { desktop: { tier: 'admin', tokens: ['operator'], ownerWorkspace: true } },
  'POST /v1/knowledge/graph/rank_contacts': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/graph/relationship_subgraph': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/graph/connectors': { desktop: { tier: 'admin' } },
  'GET /v1/knowledge/graph/status': { desktop: { tier: 'admin' } },
  // Facts + Person (Knowledge Facts/Person inproc, Task 4) — same
  // admin-only trust class as the graph routes above: reads/writes the
  // owner's private fact store and per-contact briefs, not just the
  // current caller's own scope.
  'POST /v1/knowledge/facts/extraction_batch': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/facts/record_facts': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/facts/contact_facts': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/facts/find_facts': { desktop: { tier: 'admin', tokens: ['operator'], ownerWorkspace: true } },
  'POST /v1/knowledge/facts/set_fact_status': { desktop: { tier: 'admin', tokens: ['operator'], ownerWorkspace: true } },
  'GET /v1/knowledge/facts/extraction_status': { desktop: { tier: 'admin' } },
  'POST /v1/knowledge/person/brief': { desktop: { tier: 'admin' } },
  // Config surface (config_get/config_set MCP tools) — admin-only: reads and
  // writes the owner's daemon configuration (whitelist-bounded in
  // src/daemon/config-surface.ts). Same trust class as the facts routes above.
  'GET /v1/config/surface': { desktop: { tier: 'admin' } },
  'POST /v1/config/set': { desktop: { tier: 'admin' } },
  // admin — reads the owner's private wxvault history and stores personal
  // customer judgments. Never expose to guest/trusted chat sessions.
  // admin — hearth federation mint (grant-gated, see routes-federation.ts).
  // Mints a short-lived admin-tier token; a trusted-tier caller must not
  // reach this even before the operator-routeAllow gate is considered.
  'POST /v1/federation/mint': { desktop: { tier: 'admin', tokens: ['operator'] } },
  // ── 设置面板(/set、/m)。注释原样搬自 phone-routes.ts 的 PHONE_ROUTES ────────────────────
  // 设置页
  'GET /set': { set: { link: 'read', reason: '设置页本身(配对就从这里开始)' } },
  'GET /set/api/state': { set: { link: 'read', reason: '设置页要显示的状态' } },
  'POST /set/api/apply': { set: { link: 'write', reason: '设置页本身;开关远程 / 撤设备这类在 LAN_ONLY_OPS 另有一道', lanOnlyOps: ['set_remote', 'revoke_device', 'forget_devices'] } },
  'POST /set/api/pair': { set: { link: 'write', reason: '用链接换设备令牌,就是配对这一步' } },
  // 随身 CC
  // 收敛 5b(2026-10-21):网页删了对话 / 记忆 / 电脑会话 / 终端会话那几页,链接令牌对它们的读一并收回
  // (#463 标的「私事,收敛时再看」);设备令牌与 App 照旧。眨眼帧、动态翻页、项目经验三组接口只有网页在用,连路由删了。
  // 理念 2(2026-10-21):`link` 不再逐条判,= 链接页面(/m 网页、/set、中继壳页、App 配对)源码里扫出来的调用,
  // scripts/link-routes-from-source.guard.test.ts 双向核对。网页不再调的 22 条(state、today、todo、贴纸、交办与材料、
  // 一件事的进展 / 改动 / 成果 / 回执、审阅标记、对话模型、语音转字、连接、seen、记忆纠错)一并收成 'none'。
  // 给链接页面加一条调用:先写进页面,守卫会红着告诉你开哪一行。
  'GET /m': { phone: { link: 'read', reason: '手机页面本身(配对之前也要能打开)' } },
  'GET /m/api/state': { phone: { link: 'none' } },
  'GET /m/api/art/presence': { phone: { link: 'read', reason: 'CC 的形象画(在不在身边)' } },
  'GET /m/api/memory': { phone: { link: 'none' } },
  // 「CC 记得你」逐条纠错(2026-10-06)
  'POST /m/api/memory/correct': { phone: { link: 'none' } },
  // 收回的话与恢复(架构终态 G6)
  'GET /m/api/memory/retractions': { phone: { link: 'none' } },
  'POST /m/api/memory/restore': { phone: { link: 'none' } },
  'GET /m/api/home': { phone: { link: 'read', reason: '此刻页的内容(只读)' } },
  'POST /m/api/seen': { phone: { link: 'none' } },
  'GET /m/api/matters': { phone: { link: 'read', reason: '一起做的列表' } },
  'GET /m/api/matter': { phone: { link: 'read', reason: '一件事的详情' } },
  'GET /m/api/matter/input-receipt': { phone: { link: 'none' } },
  'GET /m/api/matter/insight': { phone: { link: 'none' } },
  'GET /m/api/matter/changes': { phone: { link: 'none' } },
  // 手机逐文件审阅(2026-10-17):没问题 / 退回(同桌面 review-mark / review-return);两条都只给设备(链接页面不调)
  'POST /m/api/matter/review-mark': { phone: { link: 'none' } },
  'POST /m/api/matter/review-return': { phone: { link: 'none' } },
  // 行评论(切片 4,2026-10-21):整块评论建 / 删 + 发出;只给设备(不在链接白名单里)
  'POST /m/api/matter/review-comment': { phone: { link: 'none' } },
  'POST /m/api/matter/review-comments-send': { phone: { link: 'none' } },
  // 撤掉这一轮(回退切片 4,2026-10-21):预览 + 带 token 执行;只给设备(不在链接白名单里)
  'GET /m/api/matter/rewind': { phone: { link: 'none' } },
  'POST /m/api/matter/rewind': { phone: { link: 'none' } },
  'POST /m/api/matter/say': { phone: { link: 'none' } },
  // 跟 CC 说(spec 2026-10-01,mobile-chat.ts):主人对话一页 + 收下即回的说一句
  'GET /m/api/chat': { phone: { link: 'none' } },
  'POST /m/api/chat/say': { phone: { link: 'none' } },
  // 搜主人那条对话(2026-10-06)
  'GET /m/api/chat/search': { phone: { link: 'none' } },
  // 回复里的语音附件按需合成(2026-10-04):只念库里那一行真有的那段
  'GET /m/api/chat/voice': { phone: { link: 'none' } },
  // 按住说话(2026-10-18):配没配语音转文字 + 一段录音转成字(只回字,不发、不执行)
  'GET /m/api/chat/transcribe': { phone: { link: 'none' } },
  'POST /m/api/chat/transcribe': { phone: { link: 'none' } },
  // CC 回复里的文件按块读(2026-10-06)
  'GET /m/api/chat/file': { phone: { link: 'none' } },
  // CC 的信(2026-10-18,mobile-letters.ts):寄出去了的信 + 一页 PNG 按块读。信是私事:链接令牌不在册(见 LINK_ROUTES)
  'GET /m/api/letters': { phone: { link: 'none' } },
  // 定时(对标 B7,2026-10-20):只给设备
  'GET /m/api/activity': { phone: { link: 'none' } },
  'GET /m/api/jobs': { phone: { link: 'none' } },
  'POST /m/api/jobs/action': { phone: { link: 'none' } },
  'GET /m/api/letters/page': { phone: { link: 'none' } },
  // 主人对话用哪个后端 / 模型:读与钉(2026-10-06)
  'GET /m/api/chat/model': { phone: { link: 'none' } },
  'POST /m/api/chat/model': { phone: { link: 'none' } },
  // CC 的连接(spec 2026-10-01,mobile-reads.ts),去掉 detail
  'GET /m/api/connections': { phone: { link: 'none' } },
  // 电脑上的原生会话(只读,spec 2026-10-01),项目只给目录名
  'GET /m/api/sessions': { phone: { link: 'none' } },
  'GET /m/api/session': { phone: { link: 'none' } },
  // 终端会话登记处(v76,2026-10-14):主人在 CC 外面开的 claude / codex 会话 —— 谁在跑、谁在等批准
  'GET /m/api/cli/sessions': { phone: { link: 'none' } },
  // 手机上拍板终端会话等批准的那一项(同微信「y/n 码」)、接着说一句(同微信「@码」)(2026-10-14)
  'POST /m/api/cli/permission': { phone: { link: 'none' } },
  'POST /m/api/cli/say': { phone: { link: 'none' } },
  // 看着它跑(2026-10-17):一条终端会话最近几步(跑了什么、改了哪、说了什么),只读
  'GET /m/api/cli/activity': { phone: { link: 'none' } },
  // 「今天」一眼看完(2026-10-14):终端 + 一起做,过去 24 小时;与微信「日报」同一份
  'GET /m/api/today': { phone: { link: 'none' } },
  // 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions,mobile-workbench.ts):预览 + 接成一件事
  'GET /m/api/session/continue': { phone: { link: 'none' } },
  'POST /m/api/session/continue': { phone: { link: 'none' } },
  'POST /m/api/todo': { phone: { link: 'none' } },
  'GET /m/api/sticker/': { phone: { link: 'none' } },
  // 交办与材料(mobile-workbench.ts,#129)
  // 交办时可选的模型(2026-10-06)
  'GET /m/api/entry/models': { phone: { link: 'none' } },
  'POST /m/api/attachment/chunk': { phone: { link: 'none' } },
  'GET /m/api/attachment/upload': { phone: { link: 'none' } },
  'POST /m/api/attachment/discard': { phone: { link: 'none' } },
  'GET /m/api/entry/options': { phone: { link: 'none' } },
  'POST /m/api/matter/create': { phone: { link: 'none' } },
  'GET /m/api/matter/create-receipt': { phone: { link: 'none' } },
  'POST /m/api/matter/permission': { phone: { link: 'none' } },
  // 手机上停下正在跑的这一轮(2026-10-06)
  'POST /m/api/matter/stop': { phone: { link: 'write', reason: '停下是安全方向:能停,不能让它多做什么' } },
  // 独立工作区:提交到分支 / 删除工作区(2026-10-07)
  'POST /m/api/matter/worktree': { phone: { link: 'none' } },
  'POST /m/api/matter/answer': { phone: { link: 'none' } },
  'GET /m/api/matter/artifact': { phone: { link: 'none' } },
  // 额度用完 ⇒ 交给另一位执行者继续(spec 2026-10-01-tendhearth-continue-sessions §7-3,mobile-workbench.ts)
  'POST /m/api/matter/handoff': { phone: { link: 'none' } },
  // 推送(中继 v2,spec 2026-09-30 §5):登记 APNs / FCM token、发一条测试通知。只认设备令牌。
  'POST /m/api/push/register': { phone: { link: 'none' } },
  'POST /m/api/push/test': { phone: { link: 'none' } },
} satisfies Record<RouteKey, RouteSpec>

export const ROUTES: Readonly<Record<RouteKey, RouteSpec>> = ROUTE_TABLE

/** 表里登记过的键(字面量类型):写错一个字编译就不过。 */
export type DeclaredRouteKey = keyof typeof ROUTE_TABLE
/**
 * 手机面板那一端(`/m`、`/m/api/*`、`/set`、`/set/api/*`)的键(架构终态 F3)。daemon 的处理器表
 * (`src/features/phone/phone-route-table.ts` 的 `PhoneRouteTable`)和类型化客户端(`phone-calls.ts`)都只认这些键 ——
 * 路径只在这张表里写一次。
 */
export type PanelRouteKey = Extract<DeclaredRouteKey, `${string} /m` | `${string} /m/${string}` | `${string} /set` | `${string} /set/${string}`>

/**
 * 手机能订阅的事件主题(phone-events.ts 的 `subscribe`)。`matter/` 以 `/` 结尾是前缀标记:
 * 真正允许的是 `matter/<id>`,见 phone-routes.ts 的 phoneTopicAllowed。
 */
export const PHONE_TOPIC_NAMES: readonly string[] = ['home', 'approvals', 'agents', 'matter/']
