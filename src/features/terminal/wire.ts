/**
 * 终端会话的接线(重构第二批步 6c 从 main.ts 搬出来,架构终态 A5 搬进 src/features/terminal):终端 Claude Code / Codex 的
 * hook 事件登记处、权限中继(微信 y/n、手机、放行规则)、「这边 / 那边」的脑手转发、对终端会话说话(送进开着的窗口 / resume)、
 * 「今天」一眼看完、接上 hooks,以及微信「终端 / 看 码 / @码 / y 码」那条命令和手机上的拍板 / 说一句。
 *
 * 它要的(`WireTerminalDeps`)由组装的地方(daemon-modules.ts)从上游模块里填;给出去的(返回值)就是模块的值。
 * 路由不在这里挂:返回值里的 `routes` 交给 index.ts 去 `internalApi.mount('terminal', …)`。
 * 两样晚到的东西:工作台与手机 App 推送出口(wireMain 里才造),都是调用时现取的读口(模块容器的 `ctx.late`)。
 * 要停的东西经 `own` 登记(模块容器的 `ctx.own`,关机逆序)。
 */
import { hostname as osHostname } from 'node:os'
import { randomUUID as claimUuid } from 'node:crypto'
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import type { Db } from '../../lib/db'
import { machineIdleSeconds } from '../../lib/machine-idle'
import { notifyDesktop } from '../../lib/desktop-notify'
import { makeCliEventHub, makeProjectNamer, type CliEvent, type CliSessionInfo } from '../../core/cli-events'
import { makeCliSessionStore } from '../../adapters/store/cli-session-store'
import { makeCliPermissionRelay, type CliPermissionRequest as CliPermissionRequestT } from '../../core/cli-permission-relay'
import { withReplyRefs } from '../../domain/cli-session-digest'
import { makeExecutionClaims } from '../../core/workbench/execution-claims'
import type { TodayJobs } from '../../domain/overseer-today'
import { defaultTerminalHooksDeps } from '../../cli/terminal-hooks'
import { resolveAdminChatId } from '../../daemon/bootstrap/index'
import { resolveClaudeBinary } from '../../daemon/bootstrap/claude-env'
import { loadCompanionConfig } from '../../daemon/companion/config'
import { ensureStarterRules, makePermissionGate, makeTerminalDecide, STARTER_NOTICE } from '../../daemon/permission-gate'
import { makePendingNotices } from '../../daemon/speech/pending-notices'
import { makePermissionDecisionsStore } from '../../daemon/permission-decisions-store'
import { defaultRunner, makeCliReplyCore, makeCliReplyHandler, makeHandReplyExecutor, readHead, readTail } from './reply-handler'
import { turnTimeoutMsFromEnv } from '../../lib/turn-timeout'
import { makeOverseerTodaySource, TODAY_TERMINAL_LIMIT, type TodayWorkbench } from './today'
import { makeTerminalHooksService } from './hooks'
import { findLiveWindow, liveSessionIds, relayToWindow, transcriptStartCwd, type LiveWindow } from './live-window'
import { makeTerminalSay } from './terminal-say'
import { currentStepOf, makeCliPhoneActions } from './phone-actions'
import { makeRemoteReply } from './remote-reply'
import type { TerminalRoutesDeps } from './routes'
import { scopedSend } from '../../daemon/inbound/reply-scope'
import { makeCliHubAppPush, makeCliPermissionAsk, type AppPushOutlet } from './app-push'
import { makeBrainForwarder } from './brain-forward'
import { CliEventRequest, CliPermissionRequest } from '../../daemon/internal-api/schema'
import type { IlinkAdapter } from '../../daemon/ilink-glue'
import type { Bootstrap } from '../../daemon/bootstrap/index'
import type { NetworkGate } from '../../lib/network-gate'

/** 工作台里这一块用到的两样:有没有跟外部会话撞文件夹、「今天」里那一节。 */
export type CliSessionsWorkbench = TodayWorkbench & { conflictsExternal(cwd: string, source: string, sessionId: string): boolean }

export interface WireTerminalDeps {
  stateDir: string
  dangerously: boolean
  db: Db
  ilink: IlinkAdapter
  /** 项目登记(别名 → 文件夹),给终端会话起项目名用。 */
  projects: Pick<import('../../daemon/projects').Projects, 'list'>
  /** 登记一个要停的资源(模块容器的 ctx.own)。 */
  own(name: string, stop: () => unknown): void
  /** 只认主人(微信「终端 / 看 码 / @码」)。 */
  isOwner(chatId: string): boolean
  /** 手机拍板等批准的那一项:与微信「y/n 码」、桌宠权限卡同一份待批(ilink.resolvePermission,拍板了记一次接触)。 */
  resolvePermission(hash: string, decision: 'allow' | 'deny'): boolean
  boot: Bootstrap
  /** CC 开口那道门(第三批 3a),懒取(这里比门早接线)。取不到 ⇒ 终端汇总不发微信(桌面 / App 照旧),规则通知不发。 */
  speech: () => Pick<import('../../daemon/speech/policy').SpeechPolicy, 'tell'> | null
  networkGate: NetworkGate
  /** 工作台在后面才建:调用时取,没就绪 ⇒ null。 */
  workbench(): CliSessionsWorkbench | null
  /** 手机 App 推送出口(wireMain 里才造):调用时取,没就绪 ⇒ null。 */
  appPush(): AppPushOutlet | null
  /** 「今天」里定时那一节(定时的存储归 jobs 那块,这里只读汇总)。 */
  jobsSince(since: number): TodayJobs
}

export function wireTerminal(d: WireTerminalDeps) {
  const { stateDir, dangerously, db, ilink, own, boot } = d
  // 终端 claude / codex 会话的 hook 事件(spec 2026-09-09-cli-hook-push):压一段
  // 再推给主人,同会话再敲一句就撤。发到哪:与权限卡、A2A notify 同一个主人
  // chat;怎么发:经 CC 开口那道门,投递走 boot.sendAssistantText —— 同一条外发,断线时它自己退避、这里不重试。
  // 手机 app 推送出口:pipeline-deps(wireMain)里才造,调用时现取(features/terminal/app-push.ts)。
  const cliAppPush = (): AppPushOutlet | null => d.appPush()
  // CC 代主人对终端会话说一句、等它回话(terminal_say,2026-10-24):replyCore 在下面才建,这里先占位
  let terminalSay: ReturnType<typeof makeTerminalSay> | null = null
  const cliEvents = makeCliEventHub({
    // 经 CC 开口那道门(cli_session,report;汇总里可能带 y/n 码 ⇒ expiring,不进待说队列),
    // 投递仍走 sendAssistantText;没说出去 ⇒ 'rejected',hub 照旧落到 App 推送 / 桌面通知。
    send: async (text, ctx) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      const sat = boot.sendAssistantText
      if (!owner || !sat) return 'no_target'
      // 微信的主动推送窗口已知关着(上一次被 errcode=-2 拒了,主人还没说话)、已经交给手机推送 ⇒ 不再去撞一定被拒的那一次。
      // 跟伙伴的主动通道同一个判断(proactive-channel.ts wechatUsable)。主人一说话,CC 回他那一句成功,窗口就标回开着。
      // 10-23 self discover:两天里同一件事被拒 ~80 次,每次在日志里记三行(RETRY_FAIL / FALLBACK_REPLY_FAIL / CLI_PUSH)。
      if (ctx?.appDelivered && ilink.proactiveClosedSince(owner)) return 'skipped'
      const speech = d.speech()
      if (!speech) return 'rejected'
      return await speech.tell('cli_session', owner, text, (c, t) => sat(c, t)) ? 'sent' : 'rejected'
    },
    // 第二个出口:同一批、同一套在场判断,微信拒了手机照样收到。
    pushApp: makeCliHubAppPush({ push: cliAppPush, log: (t, l) => log(t, l) }),
    projectName: makeProjectNamer(() => d.projects.list()),
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
  // terminal_say 的票(下面才建)随登记处一起收:放掉还持着的 busy、叫醒还在等的(启停只许一种写法,不另登记一行)
  own('cli-events', async () => { terminalSay?.dispose(); cliEvents.dispose() })
  // 终端会话的权限 → 微信 y/n(同 spec §6.3)。复用 ilink.askUser,所以微信「y 码」、
  // 桌宠权限卡都能拍板 —— 一个权限,几个呈现面。主人在场(3 分钟内敲过字)就不问。
  // 放行规则(spec 2026-10-19-permission-rules-design):终端会话与一起做在问主人之前先问它。
  // 规则文件默认没有 / 关着 ⇒ 每条都是 ask,两处入口照旧。初审走 registry 的 cheapEval(自带网络守护)。
  const permissionDecisions = makePermissionDecisionsStore(db)
  // 放行 v2 G1:主人 10-23 拍板三层生效 ⇒ 全空默认值的规则文件开机时装一次起步规则(装过 / 改过就不动)
  if (ensureStarterRules(stateDir, log)) {
    // 主人第一次碰到的变化是「问得少了」—— 说一次为什么(整合者审 #615)。进待说队列,由 SpeechPolicy 挑时候说(免打扰 / 断线照规矩推后)
    const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
    if (owner) {
      try { makePendingNotices({ stateDir, log }).add({ kind: 'rules_notice', chatId: owner, text: STARTER_NOTICE, at: new Date().toISOString() }) }
      catch (err) { log('PERMISSION_RULES', `starter notice not queued: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
  const permissionGate = makePermissionGate({
    stateDir,
    store: permissionDecisions,
    cheapEval: () => boot.registry.getCheapEval(),
    // 放行规则出了问题、退回逐条问(rules_notice,report):经门,推后 / 没发出去进待说队列
    notifyOwner: (text) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      const speech = d.speech()
      if (owner && speech) void speech.tell('rules_notice', owner, text)
      else if (owner) log('PERMISSION_GATE', 'rules notice not sent: speech policy not wired yet')
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
      push: cliAppPush,
      localMachine: osHostname(),
      log: (t, l) => log(t, l),
    }),
    presence: (s, idle) => cliEvents.presence(s, idle),
    projectName: makeProjectNamer(() => d.projects.list()),
    onRelayed: (s) => cliEvents.notePermissionRelay(s),
    onAsked: (req) => cliEvents.permissionAsked(req),
    onSettled: (s, status) => cliEvents.permissionSettled(s, status),
    log: (t, l) => log(t, l),
    localMachine: osHostname(),
    // 判定在 domain/authorize.ts(架构终态 C2),经 makeTerminalDecide:面是 terminal ⇒ 先过放行规则,规则没拿主意就问主人。
    decide: makeTerminalDecide(permissionGate),
  })
  own('cli-permissions', async () => cliPermissions.dispose())
  // 这边 / 那边(§6.5)。手侧:配对时脑留了回叫的 url + key ⇒ 本机终端事件与权限请求
  // 转给脑,由脑决定发不发、发到哪;人就在这只手前的除外(本机桌面说一声)。
  // 脑侧:a2a 服务多三条路 —— 收手的事件 / 权限、把「看 / 说」派给手。
  const a2a = boot.a2aDeps
  const forwarder = a2a ? makeBrainForwarder({
    registry: a2a.registry, client: a2a.client, selfId: boot.selfId,
    notifyDesktop: (t, b) => notifyDesktop(t, b),
    projectName: makeProjectNamer(() => d.projects.list()),
    log: (t, l) => log(t, l),
  }) : null
  // 登记处列表 + 等批准那一项在微信里怎么回(中继开的 5 位码与卡片上的两位数码)。微信「终端」、
  // GET /v1/cli/sessions(桌面「此刻」、CC 的只读工具 terminal_sessions)都读这一份。
  const cliSessionViews = (opts?: { includeEnded?: boolean; limit?: number }) =>
    withReplyRefs(cliEvents.list(opts), (id) => cliPermissions.pendingHash(id), (h) => ilink.pendingPermissionCodeOf(h))
  // CC 代主人对终端会话说一句、等它回话(terminal_say,2026-10-24):送话用下面「@码」同一个 replyCore,
  // 回话是这条会话 hooks 报来的下一个 Stop(ingest 那一口转给它)。晚绑定:replyCore 在下面才建。
  const cliEventsRoute: TerminalRoutesDeps['cliEvents'] = {
    // 转给脑的事件本机登记处也记一笔(observe 只记不推):这台机自己的列表也看得到。
    ingest: (ev) => {
      let handed = false
      try { handed = terminalSay?.noteEvent(ev) ?? false } catch (err) { log('TERMINAL_SAY', `noteEvent failed: ${err instanceof Error ? err.message : String(err)}`) }
      // 会话又有了动静(Stop / 新 prompt / 结束)⇒ 终端已自己答过,挂着的码作废(评审 10-15 #5)。
      if (ev.kind === 'stop' || ev.kind === 'prompt' || ev.kind === 'session_end') cliPermissions.expireSession(ev.session_id)
      // 这个 Stop 正是 CC 在等的回话,CC 这就转给主人 ⇒ 只登记、不再照常推一遍「做完了」(否则主人同一句收两次)。
      // CC 已经不等了(工具超时)⇒ handed=false,照常推。
      if (handed) { cliEvents.observe(ev); return 'noop' }
      if (!forwarder?.brain()) {
        const action = cliEvents.ingest(ev)
        // 这个 Stop 照常排了终端完成推送 ⇒ 记下主人会收到它,CC 之后再看到这份回话就别重复转述(评审 #662 二轮 #3)
        if (ev.kind === 'stop' && action === 'scheduled') { try { terminalSay?.markPushed(ev.session_id) } catch { /* 只少一句提示 */ } }
        return action
      }
      cliEvents.observe(ev)
      return forwarder.event(ev)
    },
    // displayName(收敛清单 ⑥):桌面「此刻」画终端会话时读它,不存名字表。
    list: (opts) => cliSessionViews(opts).map(v => ({ ...v, displayName: boot.registry.namesOf(v.source).name })),
    // CC 的 terminal_sessions 要的两样:开没开着窗口(读一遍 Claude 的会话登记)、此刻在做哪一步(同手机列表的判法)。
    detail: (ids) => {
      let live = new Set<string>()
      try { live = liveSessionIds() } catch { /* 读不到登记 ⇒ 都当没开着 */ }
      const out: Record<string, { live_window: boolean; now_step: string | null }> = {}
      for (const id of ids) {
        const s = cliEvents.lookup(id)
        const step = s && s.session_id === id ? currentStepOf(s, { localMachine: osHostname() }) : null
        out[id] = { live_window: live.has(id), now_step: step?.text ?? null }
      }
      return out
    },
  }
  const cliPermissionsRoute: TerminalRoutesDeps['cliPermissions'] = {
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
  }
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
    // noBypass(terminal_say,评审 #662 二轮 #4):发信小进程也不带免审 —— 话是模型写的;只 --allowedTools SendMessage。
    relay: (w: LiveWindow, text: string, o?: { header?: string; noBypass?: boolean }) => relayToWindow(w, text, { run: defaultRunner, cwd: stateDir, dangerously, ...(o?.noBypass ? { noBypass: true } : {}), ...(claudeCli ? { bin: claudeCli } : {}), ...(o?.header !== undefined ? { header: o.header } : {}) }),
  }
  const startCwd = (s: CliSessionInfo) => s.transcript_path ? transcriptStartCwd(readHead(s.transcript_path, 64 * 1024)) : null
  const replyCore = makeCliReplyCore({ executionConflict,reserveExecution,hub: cliEvents, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l), dangerously, ...(claudeCli ? { claudeBin: claudeCli } : {}), networkGate: d.networkGate, liveWindow, startCwd })
  terminalSay = makeTerminalSay({
    hub: cliEvents, core: replyCore, holdBusy: (l) => boot.holdBusy(l), localMachine: osHostname(), log: (t, l) => log(t, l),
    // 没人领的终局(CC 那一轮早结束了,比如 resume 跑了好几分钟):经 CC 开口那道门告诉主人,同终端完成推送(cli_session,report)。
    notifyOwner: async (text) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      const sat = boot.sendAssistantText
      const speech = d.speech()
      if (!owner || !sat || !speech) { log('TERMINAL_SAY', 'unclaimed reply not sent: no owner / speech not wired'); return }
      await speech.tell('cli_session', owner, text, (c, t) => sat(c, t))
    },
    sharePage: async (title, markdown) => {
      const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      return (await ilink.sharePage(title, markdown, owner ? { chat_id: owner } : undefined)).url
    },
    readTranscript: (path) => readTail(path, 256 * 1024),
    turnTimeoutMs: turnTimeoutMsFromEnv(process.env),
  })
  const terminalSayRoute: TerminalRoutesDeps['terminalSay'] = {
    say: (code, text) => terminalSay!.say(code, text),
    wait: (ticket, ms, signal) => terminalSay!.wait(ticket, ms, signal),
    claim: (ticket) => terminalSay!.claim(ticket),
    // 只认主人那条聊天(同微信「@码」的 isOwner)
    isOwnerChat: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
  }
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
  // 接上终端里的 Claude Code / Codex(2026-10-14):「CC 现在怎么样」那一行 + 桌面「接上」/「修复」的路由。
  // 只在主人点了确认时写 hook 配置,绝不自动装。
  const terminalHooks = makeTerminalHooksService({ deps: defaultTerminalHooksDeps, sessions: () => cliEvents.list({ includeEnded: true, limit: 500 }) })
  // 微信「终端」「看 码」「@码 …」「y 码」(命令表里 'cli' 那一项,owner-commands 按优先级排进去)。
  const command = makeCliReplyHandler({
    executionConflict, reserveExecution,
    hub: cliEvents,
    isOwner: d.isOwner,
    sendMessage: scopedSend((c: string, t: string) => ilink.sendMessage(c, t)),
    sharePage: async (title, md, chatId) => (await ilink.sharePage(title, md, { chat_id: chatId })).url,
    holdBusy: (l) => boot.holdBusy(l),
    log: (t, l) => log(t, l),
    dangerously,
    networkGate: d.networkGate,
    liveWindow, startCwd,
    localMachine: osHostname(),
    listSessions: () => cliSessionViews({ limit: 50 }),
    today: overseerToday,
    ...(a2a ? { remote: makeRemoteReply({ registry: a2a.registry, client: a2a.client, selfId: boot.selfId }) } : {}),
  })
  // 手机拍板 / 说一句:拍板与微信「y/n 码」、桌宠权限卡同一份待批;说一句与微信「@码」同一个 core。
  const phoneActions = makeCliPhoneActions({
    hub: cliEvents, relay: cliPermissions, core: replyCore, localMachine: osHostname(), log: (t, l) => log(t, l), liveIds: () => liveSessionIds(),
    resolve: (h, dec) => d.resolvePermission(h, dec),
  })
  const routes: TerminalRoutesDeps = { cliEvents: cliEventsRoute, cliPermissions: cliPermissionsRoute, terminalSay: terminalSayRoute, cliHooks: terminalHooks, overseerToday }
  return {
    cliEvents, cliPermissions, replyCore, permissionDecisions, permissionGate, cliSessionViews, terminalSay,
    legacyClaims, executionConflict, reserveExecution, liveWindow, startCwd, overseerToday, terminalHooks,
    command, phoneActions, routes,
  }
}
