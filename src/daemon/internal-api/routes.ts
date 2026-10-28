import { CONVERSE_IMAGE_LIMITS, type ConverseImage } from '../app-reply'
import { turnRoutes } from './routes-turn'
import { mattersRoutes } from './routes-matters'
import { connectionsRoutes } from './routes-connections'
/**
 * Route table for internal-api. Returns the full Record<"METHOD /path", handler>
 * given a deps closure + a `getDelegate` accessor (for late-binding via
 * setDelegate) + a `maybePrefix` helper (kept in index.ts because it
 * captures the same deps closure that auth/dispatch do).
 *
 * Adding a new endpoint = add a row in the appropriate section. The
 * sections are kept in stable order to match the original file's layout
 * so blame survives the split.
 */
import { errMsg, type InternalApiDeps, type InternalApiDelegateDep, type RouteTable } from './types'
import { splitReply, paceMs } from '../reply-split'
import { lookup } from '../../domain/capability-matrix'
import { noAskNotice } from '../../domain/enforcement-matrix'
import { resolveTier, type UserTier } from '../../domain/user-tier'
import { loadAccess } from '../../lib/access'
import { PROVIDER_IDS } from '../../lib/provider-ids'
import { normalizeUserName } from '../../lib/user-name'
import type { Mode } from '../../domain/conversation'
import { pluginsHealthForTier } from '../plugins/health'
import { a2aRoutes } from './routes-a2a'
import { probeFsAccess, describeFsAccess, hasFullDiskAccess, FDA_MISSING_HINT } from '../../lib/fs-access'
import { presenceRoutes } from './routes-presence'
import { petRoutes } from './routes-pet'
import { permissionRoutes } from './routes-permissions'
import { selfChangeRoutes } from './routes-self-change'
import { socialRoutes } from './routes-social'
import { knowledgeRoutes } from './routes-knowledge'
import { configRoutes } from './routes-config'
import { pairRoutes } from './routes-pair'
import { healthRoutes } from './routes-health'
import { pluginRoutes } from './routes-plugins'
import { licenseRoutes } from './routes-license'
import { daemonControlRoutes } from './routes-daemon-control'
import { fileRoutes } from './routes-files'
import { federationRoutes } from './routes-federation'
import type {
  ProjectsSwitchRequestT, ProjectsAddRequestT, ProjectsRemoveRequestT,
  UserSetNameRequestT,
  SharePageRequestT, ShareResurfaceRequestT,
  WechatReplyRequestT, WechatSendFileRequestT,
  WechatEditMessageRequestT, WechatBroadcastRequestT,
  DelegateRequestT,
  ConversationSetModeRequestT,
} from './schema'

export interface MakeRoutesContext {
  deps: InternalApiDeps
  getDelegate: () => InternalApiDelegateDep | null
  maybePrefix: (chatId: string, text: string, tag: string | undefined) => string
  /** 功能模块挂上来的路由(index.ts 的 MOUNTED,模块 init 时才填)。附件交付要经它调到表情那几条(stickers 模块挂的)和语音的 reply_voice(voice 模块挂的)。 */
  mounted?: RouteTable
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function toWireOutbound(h: import('../ilink/outbound-health').OutboundHealth) {
  return {
    state: h.state,
    consecutive_failures: h.consecutiveFailures,
    last_ok_at: h.lastOkAt,
    last_error: h.lastError,
  }
}

export function makeRoutes({ deps, getDelegate, maybePrefix, mounted }: MakeRoutesContext): RouteTable {
  const table: RouteTable = {
    // 回复交付(spec 2026-10-03 §4.5 / §4.6):附件登记 + admin 往别处发。表情 / 语音附件交付时复用老路由
    // (表情由 stickers 模块、语音由 voice 模块挂上来)。
    ...turnRoutes(deps, (key) => table[key] ?? mounted?.[key]),
    // 工作台的 44 条 /v1/workbench/* 由 workbench 模块自己挂(src/features/workbench,路由表标 module: 'workbench')
    ...mattersRoutes(deps),
    ...connectionsRoutes(deps),
    'GET /v1/health': (_q, _body, caller) => ({
      status: 200,
      body: {
        ok: true,
        daemon_pid: deps.daemonPid,
        // Ops fields for the admin self-diagnosis tool: is the turn store
        // wired, how many sessions are live, is the poll-cycle heartbeat
        // fresh (false ⇒ the daemon may be wedged / not serving).
        turns_store_wired: !!deps.turns,
        sessions_live: deps.listSessions?.()?.length ?? 0,
        heartbeat_fresh: deps.heartbeatFresh?.() ?? null,
        // 只有两个计数,没有账号 id(这条路由是 guest 档)。null = 开机还没走到拉消息那一步。
        ...(deps.polling ? { polling: deps.polling() } : {}),
        ...(deps.version ? { version: deps.version() } : {}),
        subsystems: deps.subsystems?.() ?? [],
        // 网络守护(2026-10-02):safe=false 时所有模型调用都暂停。桌面「网络守护」那一行读它。
        ...(deps.guard ? { guard: deps.guard() } : {}),
        ...(deps.outbound ? { outbound: toWireOutbound(deps.outbound()) } : {}),
        // 开机 `--version` 探测失败的外部 CLI provider(2026-10-04):还在退避重探 / 已晚注册。
        // guest 只给 provider 名、状态、次数和时间;失败原因(可能带路径 / stderr)给 trusted 以上
        // —— CLI 拿的 file token 就是 trusted,`wechat-cc status` 要能说出「为什么」。
        ...(deps.providerProbes ? { provider_probes: deps.providerProbes().map(p => caller?.tier === 'admin' || caller?.tier === 'trusted' ? p : { ...p, last_error: '' }) } : {}),
        // 真回合里被拒着的执行者(2026-10-23,provider-refusals.ts):只有码和起始时间,guest 也给
        ...(deps.providerRefusals ? { provider_refusals: deps.providerRefusals() } : {}),
        // 外部 agent CLI 自动升级(2026-10-04):各家装的 / 最新的版本、上次检查与升级、坏版本名单、自检状态。
        // 只有版本号与时间,没有路径(这条路由是 guest 档)。
        ...(deps.cliUpgrade ? { cli_upgrade: (() => { try { return deps.cliUpgrade!.status() } catch { return undefined } })() } : {}),
        // 启动时实际加载的插件(2026-09-30)。null = bootstrap 还在接线;`self deploy`
        // 的健康门等它变成对象,再看 expected_missing / pointer_broken。这条路由是 guest
        // 档:admin 以下只给计数和缺了哪些名字,不给绝对路径与 not-ready 原因。
        ...(deps.plugins ? { plugins: (() => { const h = deps.plugins!(); return h ? pluginsHealthForTier(h, caller?.tier === 'admin') : null })() } : {}),
        // 在 daemon 进程里探(权限记在责任进程上,CLI 能读不代表 daemon 能读)。
        // 三次 readdir,便宜;每次 health 都重探,这样勾完权限刷新就变绿。
        fs_access: (() => {
          const r = probeFsAccess()
          // 完全磁盘访问(不弹框的探针):没有它,后台 wxvault 同步会暂停(见 lib/fs-access.ts)。
          const fda = hasFullDiskAccess()
          return {
            any_denied: r.anyDenied, folders: r.folders.map(f => ({ folder: f.folder, path: f.path, state: f.state })), settings_url: r.settingsUrl, hint: describeFsAccess(r),
            full_disk_access: fda,
            ...(fda === false ? { fda_hint: FDA_MISSING_HINT } : {}),
          }
        })(),
      },
    }),

    // ── memory (RFC 03 P1.B B2):读 / 写 / 列 / 删四条归记忆功能(src/features/memory/fs-routes.ts),模块自己挂 ──

    // ── projects (RFC 03 P1.B B3) ───────────────────────────────────────
    'GET /v1/projects/list': () => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Legacy wire shape returned the array directly (not wrapped). Preserve.
      return { status: 200, body: deps.projects.list() }
    },
    'POST /v1/projects/switch': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsSwitchRequest schema.
      const { alias } = body as ProjectsSwitchRequestT
      const r = await deps.projects.switchTo(alias)
      return { status: 200, body: r }
    },
    'POST /v1/projects/add': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsAddRequest schema.
      const { alias, path } = body as ProjectsAddRequestT
      try {
        await deps.projects.add(alias, path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        // Match legacy behaviour: in-process tool handler did not catch
        // here; the SDK surfaced the error. Mirror that by returning 200
        // with {ok:false,error} so the agent sees a structured result
        // rather than a transport exception. Stricter callers can read
        // the body and decide.
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/projects/remove': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsRemoveRequest schema.
      const { alias } = body as ProjectsRemoveRequestT
      try {
        await deps.projects.remove(alias)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── user name (RFC 03 P1.B B3) ──────────────────────────────────────
    // 设置面板链接 (2026-08-25) — 此刻页「手机上改设置」二维码的数据源。
    // 每次调用都换新令牌(单活 10 分钟),与 /set 的链接同一套机制。
    'GET /v1/settings/link': async () => {
      if (!deps.settingsLink) return { status: 503, body: { error: 'settings_link_not_wired' } }
      const url = await deps.settingsLink()
      if (!url) return { status: 200, body: { ok: false, error: 'no_lan_or_owner' } }
      return { status: 200, body: { ok: true, url } }
    },

    // LLM key 图形化填入 (2026-08-25, owner: 「你让小白用户写到变量里?」)
    // — 桌面大脑卡的「OpenAI/Gemini +」表单落到这里;daemon 自己写
    // daemon.env(0600,原子替换),用户永远不用知道那个文件存在。
    // admin 层(密钥),桌面走 owner-workspace 通道。值绝不进日志。
    'POST /v1/llm/keys': async (_q, body) => {
      const b = (body ?? {}) as { provider?: unknown; key?: unknown; base_url?: unknown; model?: unknown }
      const { saveLlmKey } = await import('../llm-keys')
      const r = await saveLlmKey(deps.stateDir, b, deps.log)
      if (!r.ok) {
        const msg = r.error === 'unsupported_provider' ? 'unsupported_provider (openai | gemini)' : r.error
        return { status: 400, body: { error: msg } }
      }
      return { status: 200, body: { ok: true, restart_required: true } }
    },

    // LLM 通道体检 (2026-08-25) — 微信通道绿灯不等于大脑能用。真拨只在
    // ?fresh=1(用户点「测试连接」)时发生 —— 绝不自动外呼(owner ruling:
    // 网络不稳时的无人值守外呼是风控/封号形状);默认只回上次结果 +
    // 已注册/未接入清单(未接入的带配置方法人话)。
    // 网络体检(排障前置,2026-08-26)— provider 连不上大多是国际出口
    // 问题而非登录问题;先分清,修复指引才对路。daemon 侧 HTTPS 可达性
    // (HEAD,不带 key,不调真实 API),用户点击触发。
    'POST /v1/net/probe': async () => {
      const { probeTargetsFor, runNetProbe, verdictOf, dialAdvisable } = await import('../net-probe')
      const registered = deps.llmRegistered?.() ?? []
      const endpoints = deps.llmEndpoints?.() ?? undefined   // 自配 base_url(国内/本地大脑)→ 探真实端点
      const results = await runNetProbe(probeTargetsFor(registered, endpoints))
      // dial_advisable:哪怕国际不通,只要有个已注册大脑端点可达就该真拨 ——
      // 别把国内/本地自配的大脑挡在「先开代理」的墙后面。
      return { status: 200, body: { ok: true, results, verdict: verdictOf(results), dial_advisable: dialAdvisable(results, registered, endpoints) } }
    },
    'GET /v1/llm/health': async (q) => {
      if (!deps.llmHealth) return { status: 503, body: { error: 'llm_health_not_wired' } }
      const { unconfiguredHints } = await import('../llm-health')
      const fresh = q.get('fresh') === '1'
      const report = fresh ? await deps.llmHealth.dial(q.get('scope') === 'current' ? 'current' : undefined) : deps.llmHealth.cached()
      const registered = deps.llmRegistered?.() ?? []
      // names(收敛清单 ⑥):六家内置 + 已注册的(含自定义 ACP)都给正式名字和设置里的写法;桌面不存名字表,
      // 没注册的也给(「连接其他 AI 服务」的选项、旧对话里的执行者)。老 daemon 不带 ⇒ 桌面退回 id。
      const names = deps.llmNames ? Object.fromEntries([...new Set([...PROVIDER_IDS, ...registered])].map(id => { const n = deps.llmNames!(id); return [id, { displayName: n.name, settingsLabel: n.settings }] })) : undefined
      return { status: 200, body: {
        ok: true,
        registered,
        ...(names ? { names } : {}),
        unconfigured: unconfiguredHints(registered),
        ...(report ?? { checked_at: null, default_provider: null, results: [] }),
      } }
    },

    'POST /v1/user/set_name': async (_q, body) => {
      if (!deps.setUserName) return { status: 503, body: { error: 'set_user_name_not_wired' } }
      // Body is pre-validated by index.ts via UserSetNameRequest schema.
      const { chat_id, name } = body as UserSetNameRequestT
      try {
        // 「叫我大人」→「大人」 — the model routinely stores the human's whole
        // answer phrase as the name; normalize at the boundary (user-name.ts).
        await deps.setUserName(chat_id, normalizeUserName(name))
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── share_page / resurface_page (RFC 03 P1.B B5) ────────────────────
    'POST /v1/share/page': async (_q, body) => {
      if (!deps.sharePage) return { status: 503, body: { error: 'share_page_not_wired' } }
      // Body is pre-validated by index.ts via SharePageRequest schema.
      const { title, content, needs_approval, chat_id, account_id } = body as SharePageRequestT
      // Mirror legacy behaviour: only forward opts the agent supplied;
      // omit the entire arg if all opts are absent (deps.sharePage relies
      // on `undefined` to mean "use defaults" — passing {} would override).
      const opts: { needs_approval?: boolean; chat_id?: string; account_id?: string } = {}
      if (needs_approval === true) opts.needs_approval = true
      if (chat_id !== undefined) opts.chat_id = chat_id
      if (account_id !== undefined) opts.account_id = account_id
      try {
        const r = await deps.sharePage(title, content, Object.keys(opts).length ? opts : undefined)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/share/resurface': async (_q, body) => {
      if (!deps.resurfacePage) return { status: 503, body: { error: 'resurface_page_not_wired' } }
      // Body is pre-validated by index.ts via ShareResurfaceRequest schema.
      const { slug, title_fragment } = body as ShareResurfaceRequestT
      try {
        const r = await deps.resurfacePage({
          ...(slug !== undefined ? { slug } : {}),
          ...(title_fragment !== undefined ? { title_fragment } : {}),
        })
        // Legacy wire shape: returns the page record OR `{ok:false, reason:'not found'}`.
        return { status: 200, body: r ?? { ok: false, reason: 'not found' } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── ilink-bound message family (RFC 03 P1.B B1) ─────────────────────
    // The reply / reply_voice / send_file / edit_message / broadcast tools
    // detected by both providers' replyToolCalled flag. After B1 these are
    // exposed by the stdio `wechat` server (renamed from `wechat_ipc`),
    // which is what claude-agent-provider's REPLY_TOOL_NAMES set and
    // the codex chat provider's WECHAT_MCP_SERVER='wechat' check match against.
    'POST /v1/wechat/reply': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatReplyRequest schema.
      const { chat_id, text, participant_tag } = body as WechatReplyRequestT
      // 空白回复在任何表面都不是一条消息(2026-10-02 手机真机验收:模型调了一次
      // text 为空的 reply,App 回复里多一行空行,模型自己还补一句「上面那条空的是
      // 误发」)。不截、不发,并且明说什么都没发出去 —— 模型不必补发或道歉。
      // 放在 sink 检查之前,两个表面给模型的回答一致。
      if (!text.trim()) {
        return { status: 200, body: { ok: false, error: 'empty_text: nothing was sent (text was empty or whitespace only); the user saw nothing, so do not apologize for it' } }
      }
      // App-conversation-channel, Stage 0: when a reply sink is open for
      // this chat, capture the RAW text (whole, pre-split, pre-prefix — the
      // app shows the whole reply) instead of ilink-sending it.
      if (deps.replySinks?.capture(chat_id, text)) {
        return { status: 200, body: { ok: true, captured: true } }
      }
      // 旁听(不改道):打猎那一拍开着 tap,发出去的东西同时进战利品清单。
      // 放在 sink 检查**之后** —— 被 app 通道截走的回复从没到过微信,记进
      // 「CC 给你带回来的东西」会是假的。放在分片之前:记原文,不记分片。
      deps.outboundTaps?.observe(chat_id, text)
      // RFC 03 P3 — mode-aware prefixing. Only applies when the chat is
      // in a multi-participant mode AND the caller supplied its tag.
      // Solo mode (and absent prefix deps) → text passes through unchanged.
      const prefixed = maybePrefix(chat_id, text, participant_tag)
      // Reply splitting (活人感, spec 2026-07-09): only un-prefixed replies —
      // chunks 2+ of a prefixed send would lose their [Display] attribution.
      // Absent getChatPrefs dep ⇒ disabled (tests/embedded unchanged);
      // wired ⇒ default ON unless this chat set split:false.
      const prefs = prefixed === text ? deps.getChatPrefs?.(chat_id) : undefined
      const chunks = prefs !== undefined && prefs.split !== false ? splitReply(text) : [prefixed]
      const sleep = deps.sleepMs ?? defaultSleep
      let sentCount = 0
      try {
        let lastMsgId = ''
        for (let i = 0; i < chunks.length; i++) {
          const r = await deps.ilink.sendReply(chat_id, chunks[i]!)
          // Legacy in-process wrapper reshaped {msgId,error?} → {ok,msg_id} or
          // {ok:false,error}. Preserve verbatim so the agent's mental model
          // doesn't shift across this migration.
          if (r.error) {
            if (sentCount > 0) deps.log?.('WECHAT_REPLY', `split partial failure chat=${chat_id} sent=${sentCount}/${chunks.length} err=${r.error}`)
            return { status: 200, body: { ok: false, error: r.error, ...(sentCount > 0 ? { sent: sentCount } : {}) } }
          }
          sentCount++
          lastMsgId = r.msgId
          if (i < chunks.length - 1) await sleep(paceMs(chunks[i]!))
        }
        return { status: 200, body: { ok: true, msg_id: lastMsgId } }
      } catch (err) {
        if (sentCount > 0) deps.log?.('WECHAT_REPLY', `split partial failure chat=${chat_id} sent=${sentCount}/${chunks.length} err=${errMsg(err)}`)
        return { status: 200, body: { ok: false, error: errMsg(err), ...(sentCount > 0 ? { sent: sentCount } : {}) } }
      }
    },
    'POST /v1/wechat/send_file': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatSendFileRequest schema.
      const { chat_id, path } = body as WechatSendFileRequestT
      try {
        await deps.ilink.sendFile(chat_id, path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/edit_message': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatEditMessageRequest schema.
      const { chat_id, msg_id, text } = body as WechatEditMessageRequestT
      try {
        await deps.ilink.editMessage(chat_id, msg_id, text)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    // ── delegate consultation (RFC 03 P4) ───────────────────────────────
    'POST /v1/delegate': async (_q, body) => {
      const d = getDelegate()
      if (!d) return { status: 503, body: { error: 'delegate_not_wired' } }
      // Body is pre-validated by index.ts via DelegateRequest schema.
      // Schema enforces: peer (string), prompt (string), optional cwd (absolute path),
      // optional context_summary (string), optional depth (number).
      const { peer, prompt, context_summary, cwd, depth: depthVal } = body as DelegateRequestT
      const known = d.knownPeers()
      if (!known.includes(peer)) {
        return { status: 400, body: { error: 'unknown_peer', allowed: known } }
      }
      // RFC 03 P5 review #7 — defense in depth against recursion. The
      // bare delegate provider has no delegate-mcp loaded, so the peer
      // CAN'T call this route through normal paths — recursion is
      // structurally prevented. But a curious peer that read the token
      // file + posted directly could still attempt nesting; reject any
      // depth > 0 server-side as a backstop. (delegate-mcp client always
      // sends depth=0 from a regular session env; peers don't have the
      // env so they'd have to fabricate.)
      const depth = depthVal ?? 0
      if (depth > 0) {
        deps.log?.('DELEGATE', `nested-call rejected: peer=${peer} depth=${depth}`, {
          event: 'delegate_nested_rejected',
          peer,
          depth,
        })
        return { status: 403, body: { ok: false, reason: 'nested_delegate_rejected', depth } }
      }
      // Compose the actual prompt that the peer sees. The peer is
      // bare-bones (no conversation history, no wechat tools), so the
      // prompt is self-contained.
      const fullPrompt = context_summary && context_summary.length > 0
        ? `${prompt}\n\nContext from the calling agent:\n${context_summary}`
        : prompt
      const started = Date.now()
      try {
        const r = await d.dispatchOneShot(peer, fullPrompt, cwd)
        const elapsed = Date.now() - started
        if (r.ok) {
          deps.log?.('DELEGATE', `peer=${peer} ok response_chars=${r.response.length} ms=${elapsed}`, {
            event: 'delegate_ok',
            peer,
            response_chars: r.response.length,
            duration_ms: elapsed,
          })
        } else {
          deps.log?.('DELEGATE', `peer=${peer} fail reason=${r.reason}`, {
            event: 'delegate_fail',
            peer,
            reason: r.reason,
            duration_ms: elapsed,
          })
        }
        return { status: 200, body: r }
      } catch (err) {
        deps.log?.('DELEGATE', `peer=${peer} threw: ${errMsg(err)}`, {
          event: 'delegate_threw',
          peer,
          error: errMsg(err),
          duration_ms: Date.now() - started,
        })
        return { status: 200, body: { ok: false, reason: errMsg(err) } }
      }
    },

    'POST /v1/wechat/broadcast': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatBroadcastRequest schema.
      const { text, account_id } = body as WechatBroadcastRequestT
      try {
        const r = await deps.ilink.broadcast(text, account_id)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── conversation mode switch (console-triggered) ─────────────────────
    'POST /v1/conversation/set-mode': async (_q, body) => {
      if (!deps.conversation) return { status: 503, body: { error: 'conversation_not_wired' } }
      // Body is pre-validated by index.ts via ConversationSetModeRequest schema.
      // Schema enforces chatId (string) and mode (discriminated union of known kinds).
      const { chatId, mode, quiet } = body as ConversationSetModeRequestT
      try {
        deps.conversation.setMode(chatId, mode as unknown as Mode)
      } catch (err) {
        return { status: 400, body: { error: errMsg(err) } }
      }
      // Human-readable name for the confirmation message.
      const kindNames: Record<string, string> = {
        solo: `solo · ${'provider' in mode ? mode.provider : '?'}`,
        parallel: 'parallel',
        primary_tool: `primary_tool · ${'primary' in mode ? mode.primary : '?'}`,
        chatroom: 'chatroom',
      }
      const humanName = kindNames[mode.kind] ?? String(mode.kind)
      // 切到一家「问不了就放行」的执行者:照实说一句(稿 2026-10-22-policy-compile §6)。provider_switch(quiet)
      // 由 agent 转告主人,所以放进回执;控制台那条直接接在回执后面。
      // 主人自己的对话按 admin 档说(codex 在那里逐条问 ⇒ 不提醒);别的对话 / 读不到 access ⇒ 不分档,宁可多提醒
      // (访客本来就切不过去,派发时就拒)。
      const tierOf = (): UserTier | undefined => { try { return resolveTier(chatId, loadAccess()) === 'admin' ? 'admin' : undefined } catch { return undefined } }
      const notice = mode.kind === 'solo' && 'provider' in mode ? noAskNotice(mode.provider, tierOf()) : null
      // Best-effort wechat reply — never fail the route if send fails.
      // `quiet`: an agent (wechat-mcp provider_switch) is the caller and will
      // tell the user itself — a second「来自控制台」line would be noise.
      if (deps.ilink && !quiet) {
        deps.ilink.sendReply(chatId, `已切换到 ${humanName}（来自控制台）${notice ? `\n${notice}` : ''}`).catch(err => {
          deps.log?.('SET_MODE', `wechat reply failed: ${errMsg(err)}`)
        })
      }
      deps.log?.('SET_MODE', `chat=${chatId} mode=${JSON.stringify(mode)}`, {
        event: 'set_mode_ok',
        chatId,
        mode,
      })
      return { status: 200, body: { ok: true, ...(notice ? { notice } : {}) } }
    },

    // ── companion converse (app-conversation-channel, voice arc Stage 0) ──
    // Drives one real turn on the owner's own session and hands the reply
    // back to the caller synchronously — the app channel's core primitive.
    'POST /v1/companion/converse': async (_q, body) => {
      if (!deps.companionConverse) return { status: 503, body: { error: 'companion_converse_not_wired' } }
      const { text, images } = body as { text?: unknown; images?: unknown }
      // 图(2026-10-05)与文件(2026-10-06):[{ mime, data_b64, name? }],最多 4 份、每份 ≤10MB、只认常见图片与文档格式。有附件时文字可以空。
      const decoded: ConverseImage[] = []
      if (images !== undefined) {
        if (!Array.isArray(images) || images.length > CONVERSE_IMAGE_LIMITS.count) return { status: 400, body: { error: 'too_many_images' } }
        for (const raw of images) {
          const { mime, data_b64, name } = (raw ?? {}) as { mime?: unknown; data_b64?: unknown; name?: unknown }
          if (typeof mime !== 'string' || !(mime in CONVERSE_IMAGE_LIMITS.mimes) || typeof data_b64 !== 'string' || (name !== undefined && (typeof name !== 'string' || name.length > 255))) return { status: 400, body: { error: 'invalid_image' } }
          if (data_b64.length > Math.ceil(CONVERSE_IMAGE_LIMITS.bytes / 3) * 4 + 4) return { status: 413, body: { error: 'image_too_large' } }
          const bytes = Buffer.from(data_b64, 'base64')
          if (bytes.length === 0 || bytes.length > CONVERSE_IMAGE_LIMITS.bytes) return { status: bytes.length ? 413 : 400, body: { error: bytes.length ? 'image_too_large' : 'invalid_image' } }
          decoded.push({ mime, bytes, ...(typeof name === 'string' && name ? { name } : {}) })
        }
      }
      if (typeof text !== 'string' || (text.trim().length === 0 && decoded.length === 0)) {
        return { status: 400, body: { error: 'text required' } }
      }
      try {
        const r = await deps.companionConverse(text, 'desktop', decoded.length ? decoded : undefined)
        // 回复交付(spec 2026-10-03 §4.10,app 显示 2026-10-04):附件与旁白**总在**(没有就是空数组),桌面不用分新旧形状。
        // 附件是 app 的形状(src/daemon/app-reply.ts):语音 { text }、表情 { label, file?, image? }、文件 { name, path }。
        // path 只给桌面的 Rust 层(换成一次性引用再交给网页,见 lib.rs agent_converse);这条路由本来就只认 admin 令牌。
        return { status: 200, body: { ok: true, reply: r.reply, attachments: r.attachments ?? [], narration: r.narration ?? [] } }
      } catch (err) {
        const msg = errMsg(err)
        if (msg === 'reply_sink_busy') return { status: 409, body: { ok: false, error: 'session_busy' } }
        if (msg === 'companion_owner_chat_not_configured') {
          return { status: 503, body: { ok: false, error: msg } }
        }
        return { status: 500, body: { ok: false, error: msg } }
      }
    },

    // ── chat prefs (主动关心档位 / 拆分偏好) ───────────────────────────────
    // INLINE-validated deliberately (no REQUEST_SCHEMAS entry) — keeps the
    // schema-table route count untouched. Backs the set_chat_pref MCP tool:
    // the wechat-mcp child calls this when the user states a preference
    // ("别烦我" / "多关心我" / "别拆分") mid-conversation.
    'POST /v1/chat-prefs': (_q, body) => {
      if (!deps.setChatPref) return { status: 503, body: { error: 'chat_prefs_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; care?: unknown; split?: unknown }
      if (typeof b.chat_id !== 'string' || b.chat_id.trim() === '') {
        return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      }
      if (b.care !== undefined && b.care !== 'off' && b.care !== 'low' && b.care !== 'high') {
        return { status: 400, body: { error: "care must be one of 'off' | 'low' | 'high'" } }
      }
      if (b.split !== undefined && typeof b.split !== 'boolean') {
        return { status: 400, body: { error: 'split must be a boolean' } }
      }
      if (b.care === undefined && b.split === undefined) {
        return { status: 400, body: { error: 'at least one of care or split is required' } }
      }
      const patch: { care?: 'off' | 'low' | 'high'; split?: boolean } = {}
      if (b.care !== undefined) patch.care = b.care
      if (b.split !== undefined) patch.split = b.split
      const prefs = deps.setChatPref(b.chat_id, patch)
      return { status: 200, body: { ok: true, prefs } }
    },

    // ── a2a (send / test / dashboard CRUD) + daemon-control (sessions / model
    //    / restart / turns) live in sibling files — spread in here. ──────────
    ...a2aRoutes(deps),
    ...socialRoutes(deps),
    ...presenceRoutes(deps),
    ...petRoutes(deps),
    ...permissionRoutes(deps),
    ...selfChangeRoutes(deps),
    ...knowledgeRoutes(deps),
    ...configRoutes(deps),
    ...pairRoutes(deps),
    // 笔友信箱 /v1/penpal/* 归社交模块自己挂(src/features/social)。
    ...healthRoutes(deps),
    ...pluginRoutes(deps),
    ...licenseRoutes(deps),
    ...daemonControlRoutes(deps),
    ...federationRoutes(deps),
    ...fileRoutes(),
  }
  return table
}

/**
 * RFC 03 review #5 fix: defers the "should this reply be prefixed?"
 * decision to the capability matrix via `lookup().replyPrefix` so
 * internal-api stops switching on mode.kind directly. The matrix is now
 * the single source of truth — adding a new mode or permissionMode
 * requires only a new matrix row, not a code change here.
 *
 * replyPrefix semantics:
 *   'always'           — prefix [DisplayName] (parallel / chatroom)
 *   'never'            — no prefix (solo)
 *   'on-fallback-only' — no prefix at this call site (primary_tool; the
 *                        fallback path in coordinator.ts handles its own label)
 *
 * Unknown provider fallback: if the participant_tag references a provider
 * not yet in the capability matrix (e.g. a future 'gemini' provider before
 * a matrix row is added), the lookup throws. In that case we fall back to
 * the mode's structural semantics: parallel and chatroom always prefix,
 * other modes never do. This preserves correctness while allowing future
 * providers to work before their matrix rows are defined.
 */
export function makeMaybePrefix(deps: InternalApiDeps): (chatId: string, text: string, tag: string | undefined) => string {
  return function maybePrefix(chatId, text, tag) {
    if (!tag || !deps.prefix) return text
    const mode = deps.prefix.conversationStore.get(chatId)?.mode
    if (!mode) return text
    const permissionMode = deps.prefix.permissionMode
    // Look up the capability row for this (mode × provider-tag × permissionMode).
    let replyPrefix: 'always' | 'never' | 'on-fallback-only'
    try {
      replyPrefix = lookup(mode.kind, tag, permissionMode).replyPrefix
    } catch {
      // Unknown provider-tag (not yet in the matrix) — fall back to structural
      // mode semantics: multi-participant modes prefix, single-voice modes don't.
      replyPrefix = (mode.kind === 'parallel' || mode.kind === 'chatroom') ? 'always' : 'never'
    }
    if (replyPrefix !== 'always') return text
    const dn = deps.prefix.providerDisplayName(tag)
    return `[${dn}] ${text}`
  }
}
