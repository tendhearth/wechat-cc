/**
 * 终端会话(重构第二批步 6c 第一块,从 main.ts 搬出来):终端 Claude Code / Codex 的 hook 事件登记处、权限中继(微信 y/n、
 * 手机、放行规则)、「这边 / 那边」的脑手转发、对终端会话说话(送进开着的窗口 / resume)、「今天」一眼看完、接上 hooks。
 *
 * 它要的(deps)与给出去的(返回值)就是这一块在 main.ts 里的边界;main.ts 只负责按顺序调用。
 * 两样晚到的东西:工作台(`workbench()` getter,调用时取)与手机 App 推送出口(`setAppPush`,wireMain 建好后交进来)。
 */
import { hostname as osHostname } from 'node:os'
import { randomUUID as claimUuid } from 'node:crypto'
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import type { Db } from '../../lib/db'
import type { LifecycleSet } from '../../lib/lifecycle'
import { machineIdleSeconds } from '../../lib/machine-idle'
import { notifyDesktop } from '../../lib/desktop-notify'
import { makeCliEventHub, makeProjectNamer, type CliEvent, type CliSessionInfo } from '../../core/cli-events'
import { makeCliSessionStore } from '../../core/cli-session-store'
import { makeCliPermissionRelay, type CliPermissionRequest as CliPermissionRequestT } from '../../core/cli-permission-relay'
import { withReplyRefs } from '../../core/cli-session-digest'
import { makeExecutionClaims } from '../../core/workbench/execution-claims'
import type { TodayJobs } from '../../core/overseer-today'
import { defaultTerminalHooksDeps } from '../../cli/terminal-hooks'
import { resolveAdminChatId } from './index'
import { resolveClaudeBinary } from './claude-env'
import { loadCompanionConfig } from '../companion/config'
import { makePermissionGate, terminalAskAsync } from '../permission-gate'
import { makePermissionDecisionsStore } from '../permission-decisions-store'
import { defaultRunner, makeCliReplyCore, makeHandReplyExecutor, readHead } from '../cli-reply-handler'
import { makeOverseerTodaySource, TODAY_TERMINAL_LIMIT, type TodayWorkbench } from '../overseer-today-source'
import { makeTerminalHooksService } from '../terminal-hooks'
import { findLiveWindow, relayToWindow, transcriptStartCwd, type LiveWindow } from '../claude-live-window'
import { makeCliHubAppPush, makeCliPermissionAsk, type AppPushOutlet } from '../cli-app-push'
import { makeBrainForwarder } from '../cli-brain-forward'
import { CliEventRequest, CliPermissionRequest } from '../internal-api/schema'
import type { InternalApiLifecycle } from '../internal-api/lifecycle'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from './index'
import type { NetworkGate } from '../../lib/network-gate'

/** 工作台里这一块用到的两样:有没有跟外部会话撞文件夹、「今天」里那一节。 */
export type CliSessionsWorkbench = TodayWorkbench & { conflictsExternal(cwd: string, source: string, sessionId: string): boolean }

export interface WireCliSessionsDeps {
  stateDir: string
  dangerously: boolean
  db: Db
  ilink: IlinkAdapter
  lc: LifecycleSet
  internalApi: InternalApiLifecycle
  boot: Bootstrap
  networkGate: NetworkGate
  /** 工作台在后面才建:调用时取,没就绪 ⇒ null。 */
  workbench(): CliSessionsWorkbench | null
  /** 「今天」里定时那一节(定时的存储归 jobs 那块,这里只读汇总)。 */
  jobsSince(since: number): TodayJobs
}

export function wireCliSessions(d: WireCliSessionsDeps) {
  const { stateDir, dangerously, db, ilink, lc, internalApi, boot } = d
  // 终端 claude / codex 会话的 hook 事件(spec 2026-09-09-cli-hook-push):压一段
  // 再推给主人,同会话再敲一句就撤。发到哪:与权限卡、A2A notify 同一个主人
  // chat;怎么发:boot.sendAssistantText(同一条外发,断线时它自己退避、这里不重试)。
  // 手机 app 推送出口:pipeline-deps(wireMain)里才造,这里先占位、建完再接上(cli-app-push.ts)。
  let cliAppPush: AppPushOutlet | null = null
  const cliEvents = makeCliEventHub({
    send: async (text) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      if (!owner || !boot.sendAssistantText) return 'no_target'
      return await boot.sendAssistantText(owner, text) ? 'sent' : 'rejected'
    },
    // 第二个出口:同一批、同一套在场判断,微信拒了手机照样收到。
    pushApp: makeCliHubAppPush({ push: () => cliAppPush, log: (t, l) => log(t, l) }),
    projectName: makeProjectNamer(() => ilink.projects.list()),
    log: (t, l) => log(t, l),
    // 在场的主信号:这台电脑上次键鼠输入距今多久。人在 ⇒ 系统通知;走了 ⇒ 微信。
    machineIdle: () => machineIdleSeconds(),
    notifyDesktop: (title, body) => notifyDesktop(title, body),
    // 超长的最后一句:全文进 share_page,微信里只放前一段 + 链接。
    sharePage: async (title, markdown) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      const r = await ilink.sharePage(title, markdown, owner ? { chat_id: owner } : undefined)
      return r.url
    },
    localMachine: osHostname(),
    // 终端会话登记处(v76):状态落库,重启后「看 码」「@码」照样认得;GET /v1/cli/sessions、手机都读它。
    store: makeCliSessionStore(db),
  })
  lc.register({ name: 'cli-events', stop: async () => cliEvents.dispose() })
  // 终端会话的权限 → 微信 y/n(同 spec §6.3)。复用 ilink.askUser,所以微信「y 码」、
  // 桌宠权限卡都能拍板 —— 一个权限,几个呈现面。主人在场(3 分钟内敲过字)就不问。
  // 放行规则(spec 2026-10-19-permission-rules-design):终端会话与一起做在问主人之前先问它。
  // 规则文件默认没有 / 关着 ⇒ 每条都是 ask,两处入口照旧。初审走 registry 的 cheapEval(自带网络守护)。
  const permissionDecisions = makePermissionDecisionsStore(db)
  const permissionGate = makePermissionGate({
    stateDir,
    store: permissionDecisions,
    cheapEval: () => boot.registry.getCheapEval(),
    notifyOwner: (text) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      if (owner) void ilink.sendMessage(owner, text)
    },
    log: (t, l) => log(t, l),
  })
  const cliPermissions = makeCliPermissionRelay({
    // 先推手机、再发微信卡;手机够得着 ⇒ 微信卡没送到(errcode=-2)也不作废码,手机照样拍板。
    ask: makeCliPermissionAsk({
      ownerChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null),
      askUser: (c, p, h, ms, o) => ilink.askUser(c, p, h, ms, o),
      registerPending: (h, ms, meta) => ilink.registerPendingPermission(h, ms, meta),
      sweepPending: () => ilink.sweepPendingPermissions(),
      push: () => cliAppPush,
      localMachine: osHostname(),
      log: (t, l) => log(t, l),
    }),
    presence: (s, idle) => cliEvents.presence(s, idle),
    projectName: makeProjectNamer(() => ilink.projects.list()),
    onRelayed: (s) => cliEvents.notePermissionRelay(s),
    onAsked: (req) => cliEvents.permissionAsked(req),
    onSettled: (s, status) => cliEvents.permissionSettled(s, status),
    log: (t, l) => log(t, l),
    localMachine: osHostname(),
    decide: async (req) => (await permissionGate.decide(() => terminalAskAsync(req))).verdict,
  })
  lc.register({ name: 'cli-permissions', stop: async () => cliPermissions.dispose() })
  // 这边 / 那边(§6.5)。手侧:配对时脑留了回叫的 url + key ⇒ 本机终端事件与权限请求
  // 转给脑,由脑决定发不发、发到哪;人就在这只手前的除外(本机桌面说一声)。
  // 脑侧:a2a 服务多三条路 —— 收手的事件 / 权限、把「看 / 说」派给手。
  const a2a = boot.a2aDeps
  const forwarder = a2a ? makeBrainForwarder({
    registry: a2a.registry, client: a2a.client, selfId: boot.selfId,
    notifyDesktop: (t, b) => notifyDesktop(t, b),
    projectName: makeProjectNamer(() => ilink.projects.list()),
    log: (t, l) => log(t, l),
  }) : null
  // 登记处列表 + 等批准那一项在微信里怎么回(中继开的 5 位码与卡片上的两位数码)。微信「终端」、
  // GET /v1/cli/sessions(桌面「此刻」、CC 的只读工具 terminal_sessions)都读这一份。
  const cliSessionViews = (opts?: { includeEnded?: boolean; limit?: number }) =>
    withReplyRefs(cliEvents.list(opts), (id) => cliPermissions.pendingHash(id), (h) => ilink.pendingPermissionCodeOf(h))
  internalApi.provide({ cliEvents: {
    // 转给脑的事件本机登记处也记一笔(observe 只记不推):这台机自己的列表也看得到。
    ingest: (ev) => {
      // 会话又有了动静(Stop / 新 prompt / 结束)⇒ 终端已自己答过,挂着的码作废(评审 10-15 #5)。
      if (ev.kind === 'stop' || ev.kind === 'prompt' || ev.kind === 'session_end') cliPermissions.expireSession(ev.session_id)
      if (!forwarder?.brain()) return cliEvents.ingest(ev)
      cliEvents.observe(ev)
      return forwarder.event(ev)
    },
    // displayName(收敛清单 ⑥):桌面「此刻」画终端会话时读它,不存名字表。
    list: (opts) => cliSessionViews(opts).map(v => ({ ...v, displayName: boot.registry.namesOf(v.source).name })),
  } })
  internalApi.provide({ cliPermissions: {
    open: async (req) => {
      if (!forwarder?.brain()) return cliPermissions.open(req)
      const fwd = await forwarder.permissionOpen(req)
      if (!fwd) return cliPermissions.open(req)
      // 只有脑那边真开了码才记 waiting;主人在场(owner_present)就留给终端,不挂「等你批准」(评审 10-15 #1)。
      if (fwd.status === 'pending') cliEvents.permissionAsked(req)
      return fwd
    },
    status: (h) => cliPermissions.status(h),
    wait: (h, ms) => forwarder?.ownsHash(h) ? forwarder.permissionWait(h, ms) : cliPermissions.wait(h, ms),
  } })
  const legacyClaims=makeExecutionClaims()
  // 工作台在后面才接上(wireWorkbench):调用时经 getter 取,没就绪 ⇒ 不算冲突
  const executionConflict=(s:CliSessionInfo)=>d.workbench()?.conflictsExternal(s.cwd,s.source,s.session_id)??false
  const reserveExecution=(s:CliSessionInfo)=>{
    const release=legacyClaims.acquire({owner:claimUuid(),path:s.cwd,providerId:s.source,nativeId:s.session_id})
    // A legacy runner's early pipe return is not proof that its writer exited.
    return(closed:boolean)=>{if(closed)release()}
  }
  // 开在电脑窗口里的 Claude 会话(2026-10-18):说一句送进那个窗口,不另起 resume 副本;不开着时 resume 在会话起点的文件夹里起。
  // daemon 由 launchd 起,PATH 里没有 ~/.local/bin:发信小进程 / resume 用启动时解析出的 claude(device-e2e 10-20 真机)
  const claudeCli = resolveClaudeBinary()
  const liveWindow = {
    find: (s: CliSessionInfo) => findLiveWindow(s.session_id),
    relay: (w: LiveWindow, text: string) => relayToWindow(w, text, { run: defaultRunner, cwd: stateDir, dangerously, ...(claudeCli ? { bin: claudeCli } : {}) }),
  }
  const startCwd = (s: CliSessionInfo) => s.transcript_path ? transcriptStartCwd(readHead(s.transcript_path, 64 * 1024)) : null
  const replyCore = makeCliReplyCore({ executionConflict,reserveExecution,hub: cliEvents, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l), dangerously, ...(claudeCli ? { claudeBin: claudeCli } : {}), networkGate: d.networkGate, liveWindow, startCwd })
  const handExecutor = makeHandReplyExecutor(replyCore, {
    hub: cliEvents,
    notifyBrain: async (text) => {
      const link = forwarder?.brain()
      if (!link || !a2a) throw new Error('no brain to notify')
      const r = await a2a.client.send({ url: `${link.url}/a2a/notify`, bearer: link.key, body: { agent_id: boot.selfId, text } })
      if (!r.ok) throw new Error(r.error ?? `http_${r.http_status ?? '?'}`)
    },
    log: (t, l) => log(t, l),
  })
  boot.a2aServer?.setCliHandlers({
    onEvent: async (agent, raw) => {
      const parsed = CliEventRequest.safeParse(raw)
      if (!parsed.success) return { ok: false, error: 'invalid_body' }
      const ev: CliEvent = { ...parsed.data, origin_agent: agent.id, machine: parsed.data.machine || agent.name }
      return { ok: true, action: cliEvents.ingest(ev) }
    },
    onPermissionOpen: async (agent, raw) => {
      const parsed = CliPermissionRequest.safeParse(raw)
      if (!parsed.success) return { error: 'invalid_body' }
      const req: CliPermissionRequestT = { ...parsed.data, machine: parsed.data.machine || agent.name }
      return cliPermissions.open(req, { forwarded: true })
    },
    onPermissionWait: async (_agent, hash, waitMs) => ({ hash, status: await cliPermissions.wait(hash, waitMs) }),
    onReply: async (_agent, req) => handExecutor(req),
  })
  // 「今天」一眼看完(2026-10-14):终端登记处 + 一起做,过去 24 小时。微信「日报」、GET /v1/overseer/today、
  // 手机 /m/api/today 读同一个函数。工作台在下面才建 ⇒ 晚绑定(调用时它早已就绪)。只读,只在被问时算。
  const overseerToday = makeOverseerTodaySource({
    terminal: () => cliSessionViews({ includeEnded: true, limit: TODAY_TERMINAL_LIMIT }),
    workbench: () => d.workbench(),
    ccDecided: (since) => ({ ...permissionDecisions.countsSince(since), recent: permissionDecisions.since(since, 20) }),
    jobs: (since) => d.jobsSince(since),
    localMachine: osHostname(),
    log: (t, l) => log(t, l),
  })
  internalApi.provide({ overseerToday: overseerToday })
  // 接上终端里的 Claude Code / Codex(2026-10-14):「CC 现在怎么样」那一行 + 桌面「接上」/「修复」的路由。
  // 只在主人点了确认时写 hook 配置,绝不自动装。
  const terminalHooks = makeTerminalHooksService({ deps: defaultTerminalHooksDeps, sessions: () => cliEvents.list({ includeEnded: true, limit: 500 }) })
  internalApi.provide({ cliHooks: terminalHooks })
  return {
    cliEvents, cliPermissions, replyCore, permissionDecisions, permissionGate, cliSessionViews,
    legacyClaims, executionConflict, reserveExecution, liveWindow, startCwd, overseerToday, terminalHooks,
    /** 手机 App 推送出口:pipeline-deps(wireMain)里才造,建好后交进来。 */
    setAppPush(p: AppPushOutlet | null) { cliAppPush = p },
  }
}
