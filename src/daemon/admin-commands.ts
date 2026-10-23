/**
 * Admin-only commands intercepted BEFORE routing to Claude:
 *   /health                    — report active + expired bots, session pool, uptime
 *   清理 <bot-id>               — remove one expired bot
 *   清理所有过期                 — remove every bot currently flagged expired
 *   整理记忆 / 重新整理你对我的理解  — re-synthesize the overview memory from local Claude memory
 *
 * Non-admin senders get silently dropped (matches the /project command
 * behaviour in the legacy server.ts). Admin check goes through
 * access.ts::isAdmin so admins + allowFrom fallback both work.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { NICKNAME_RE, NICKNAME_MAX_LEN } from './nickname'
import { isoFromMs } from '../lib/iso-time'
import type { InboundMsg } from '../core/prompt-format'
import type { WechatCommand } from './commands/registry'
import type { ProviderRegistry } from '../core/provider-registry'
import type { SessionManager } from '../core/session-manager'
import type { SessionStore } from '../core/session-store'
import type { SessionStateStore, ExpiredBot } from '../core/session-state'
import { loadHearthApi, type HearthApi, type HearthLoadResult } from './hearth-adapter'
import type { SynthesizeResult } from '../lib/memory-synthesis'
import { isConnectFailure } from '../lib/net-errors'
import type { SelfChangeSpawner } from './self-change-spawn'
import { formatNightlyReply } from './memory/nightly-notify'

export interface AdminCommandsDeps {
  stateDir: string
  isAdmin: (chatId: string) => boolean
  sessionState: SessionStateStore
  pollHandle: {
    stopAccount: (id: string) => void
    stopAccountAndWait: (id: string) => Promise<void>
    running: () => string[]
  }
  resolveUserName: (chatId: string) => string | undefined
  sendMessage: (chatId: string, text: string) => Promise<{ msgId: string; error?: string }>
  /** Optional. When wired, /hearth ingest publishes the plan as a share-page card. */
  sharePage?: (title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<{ url: string; slug: string }>
  /** Optional loader for tests; production discovers hearth lazily. */
  loadHearthApi?: () => Promise<HearthLoadResult>
  log: (tag: string, line: string) => void
  /** ISO timestamp when the daemon booted (for uptime display). */
  startedAt: string
  /** chatId → project alias resolver; same lookup the coordinator uses. */
  resolveProject: (chatId: string) => { alias: string; path: string } | null
  registry: Pick<ProviderRegistry, 'list'>
  sessionManager: Pick<SessionManager, 'release' | 'list'>
  sessionStore: Pick<SessionStore, 'get' | 'delete'>
  getBotName: () => string | null
  setBotName: (name: string | null) => Promise<void>
  botNameFallback: (chatId: string) => string  // mode-derived; shown when bot_name is null
  /**
   * Optional. Re-synthesize the admin's "overview memory" from their local
   * Claude per-project memory, using the admin conversation's provider.
   * Wired in pipeline-deps where the registry + coordinator are in scope.
   */
  synthesizeMemory?: (adminChatId: string) => Promise<SynthesizeResult>
  /**
   * Optional. Read back the admin's synthesized overview ("CC 眼中的你") so they
   * can see what the bot currently understands about them. Returns null when no
   * overview has been synthesized yet. Wired in pipeline-deps.
   */
  readOverview?: (adminChatId: string) => Promise<string | null>
  /** 每晚整理的长期记忆(渲染好的文本,带「最近整理」首行);没有 memory.md 时 null。 */
  readCuratedMemory?: (adminChatId: string) => Promise<string | null>
  /** 「整理记忆」:立刻跑一次每晚整理。 */
  runMemoryNightlyNow?: () => Promise<import('./memory/nightly-notify').NightlyRunResult>
  /**
   * Optional. Delegate a task to a registered "hand" (another machine running
   * wechat-cc with A2A exec). Returns the hand's result, or a list of known
   * hands when the name doesn't resolve. Wired in pipeline-deps.
   */
  delegateToHand?: (handName: string, task: string) => Promise<
    { ok: true; response: string } | { ok: false; reason: string; knownHands?: string[] }
  >
  /**
   * 已注册的手的名字/id。触发器**按名字认**派活,不按动词认 —— 见
   * {@link matchDelegate}。缺省 ⇒ 只剩明确动词形式(向后兼容)。
   */
  knownHandNames?: () => readonly string[]
  /**
   * 用一串配对码加一台手(微信里粘码即可,大脑那台不用开终端)。
   * 内部就是 CLI 的 `hand join`。
   */
  joinHandByCode?: (code: string) => Promise<
    { ok: true; id: string; name: string; url: string } | { ok: false; error: string }
  >
  /** 列出已注册的手(名字 + 地址),给发现性用。 */
  listHands?: () => readonly { id: string; name: string; url?: string }[]
  /** 伙伴日志(journal,v40)。缺失 ⇒ 「背包」命令说功能没接,而不是说空。 */
  huntBag?: () => readonly { title: string; url: string | null; ts: string; status: string }[]
  /**
   * Starts an external updater process. The updater must live outside this
   * daemon process because a real update can stop/restart the service that is
   * currently handling the WeChat message.
   */
  updateSelf?: () => Promise<{ ok: true; pid?: number } | { ok: false; reason: string }>
  /**
   * busy-registry hold (spec 2026-08-11 §2, code review — "微信管理命令两条
   * fire-and-forget 是清点漏掉的第七类"). `handle()` dispatches
   * runSynthesize (整理记忆 — minutes-long cheapEval over local memory) and
   * runDelegate (派活 — waits on a remote hand's A2A exec) via `void
   * run*(...)`: the handler returns immediately, so neither goes through
   * SessionManager or is otherwise visible to the idle self-restart check.
   * Held for the duration of the actual work (label 'admin-synthesize' /
   * 'admin-delegate'), released in a `finally` even on throw. Absent ⇒
   * no-op, same posture as every other Task-4/5/6 hold point.
   */
  holdBusy?: (label: string) => () => void
  /**
   * 自改流水线的进件口(spec 2026-09-18 §daemon 侧)。`start` 把
   * `wechat-cc self change` 作为独立进程拉起来 —— **不能**在 daemon 里跑:
   * 流水线最后要部署 + 重启这个 daemon。`list` 只读状态目录。
   * 缺省(没接)⇒ 「自改」命令老实说这台机器没接,而不是假装在跑。
   */
  selfChange?: SelfChangeSpawner
}

export interface AdminCommands {
  /** 只读:这条会不会被管理员命令吃掉(非管理员发命令也算 —— 会被丢掉,不再往下走)。 */
  probe(msg: InboundMsg): boolean
  /** Returns true iff the message was consumed (admin command handled or silently dropped). */
  handle(msg: InboundMsg): Promise<boolean>
  /**
   * 一条命令一行(第三批 3d,同 control / mode 的写法):`admin.owner-only`(非主人发显式命令 ⇒ 「这条只有主人能用。」)
   * + 每条命令一行 `admin.<id>`。各行两两互斥(测试钉住),所以表里的先后不影响谁认领。
   */
  commands(): WechatCommand[]
}

const CLEANUP_RE = /^\s*清理\s*(all-expired|所有过期|[a-zA-Z0-9-]+-im-bot)\s*$/
const HEARTH_INGEST_RE = /^\s*\/hearth\s+ingest(?:\s+([\s\S]+))?$/
const HEARTH_LIST_RE = /^\s*\/hearth\s+list\s*$/
const HEARTH_SHOW_RE = /^\s*\/hearth\s+show\s+([A-Za-z0-9_-]+)\s*$/
const HEARTH_APPLY_RE = /^\s*\/hearth\s+apply\s+([A-Za-z0-9_-]+)\s*$/
const HEARTH_HELP_RE = /^\s*\/hearth(\s+help)?\s*$/
// /reset and the Chinese alias /重置 both drop the current chat's AI sessions
// (every registered provider) so the next dispatch starts from a fresh
// subprocess + clean keychain read. Emergency recovery hatch for the operator
// when the desktop dashboard isn't reachable.
const RESET_RE = /^\s*\/(?:reset|重置)\s*$/
// 粘一串配对码 = 加一台手。**裸码直接认**:码以 WCCP1 开头 + base64url,
// 真实聊天里不可能误撞;而 owner 刚从终端复制完一串码,再要求他想一个命令
// 前缀,正是这次要拿掉的摩擦。`/hand <码>` 留作显式别名。
const HAND_JOIN_RE = /^\s*(?:\/(?:hand|配对)\s+)?(WCCP1[A-Za-z0-9_\-\s]+)$/
/** 列出已注册的手。补回上一轮为了精确性删掉的发现性(见 matchDelegate)。 */
const HANDS_LIST_RE = /^\s*(?:\/hands|有哪些手|手列表|看看有哪些手)\s*[?？]?\s*$/
// 打猎战利品的微信入口(2026-09-03)。打猎的消息本来就发在微信里,能在同一
// 个地方回头翻是最自然的;桌面端那个「🎒 打猎背包」是同一份数据的可编辑版。
const BAG_RE = /^\s*(?:\/(?:bag|背包)|背包|打猎背包|猎物|战利品|打到了什么|打到什么了)\s*[?？]?\s*$/
// 微信里下自改的单(2026-09-18)。**必须带需求**:`自改` 后面要么跟空白 + 一段
// 文字,要么正好是「状态 / 列表」。裸的「自改」二字落回正常聊天 —— 主人说
// 「你能自改吗」这类句子不该被劫成命令(同 matchDelegate 那条「别按动词认」的
// 教训:触发面越窄,和日常汉语抢词的机会越少)。
const SELF_CHANGE_RE = /^\s*自改\s+([\s\S]+)$/
const SELF_CHANGE_STATUS_RE = /^\s*自改\s*(?:状态|列表)\s*$/

/**
 * 明确的命令写法:斜杠命令、手的配对码、「自改 …」—— 不会和日常聊天撞。非主人发来 ⇒ 回一句「只有主人能用」。
 * 其余(背包 / 看记忆 / 有哪些手 / 整理记忆 / 让X执行…)和日常汉语重合,非主人说的就当普通聊天(重构第二批步 3a)。
 */
/**
 * 显式的管理员命令写法(斜杠开头、配对码、「自改」):非主人发这些 ⇒ 回一句「只有主人能用」;日常说法(「看看有哪些手」
 * 「背包」…)不认领,交给模型。由行表推出来:斜杠开头,或者命中标了 explicit 的那几行。
 */
export function isExplicitAdminCommand(text: string): boolean {
  return text.startsWith('/') || ADMIN_ROWS.some(r => r.explicit && r.match(text, { handNames: [] }) != null)
}

/** 管理员命令的识别面(纯函数):任一行认得它。以前是一份手写的、和 handle 里 if 链平行的 19 个正则清单,两边会悄悄对不上。 */
export function isAdminCommandText(text: string, handNames: readonly string[]): boolean {
  return ADMIN_ROWS.some(r => r.match(text, { handNames }) != null)
}

export function matchHandJoin(text: string): string | null {
  const m = HAND_JOIN_RE.exec(text)
  if (!m) return null
  // 微信会把长文本折行,粘过来可能带换行 —— 拼回去。
  const code = m[1]!.replace(/\s+/g, '')
  return code.length > 'WCCP1'.length ? code : null
}
const UPDATE_RE = /^\s*\/(?:update|updata)\s*$/
// /health ai is the AI-side companion of /health: per-provider session state
// for the current chat. Does not run the underlying CLIs (zero token, zero
// network) — just inspects the daemon's own bookkeeping.
const HEALTH_AI_RE = /^\s*\/health\s+ai\s*$/
// Re-synthesize the overview memory ("CC 眼中的你") from local Claude memory.
// Natural-language Chinese phrasings + slash aliases — the admin just asks the
// bot to refresh its understanding.
const SYNTHESIZE_RE = /^\s*(?:\/(?:synthesize|整理记忆)|重新整理记忆|整理一下记忆|整理记忆|重新整理你对我的理解|更新你对我的理解|更新记忆)\s*$/
// READ BACK the synthesized overview — show the admin what the bot understands
// about them. Distinct from SYNTHESIZE_RE (which *regenerates*): these are
// "show me", anchored so they don't collide with the 重新整理/更新 phrasings.
const SHOW_OVERVIEW_RE = /^\s*(?:\/overview|你对我的理解|看看你对我的理解|你眼中的我|你怎么(?:理解|看)我|你记得我(?:什么|啥)|查看记忆|看一下记忆|看下记忆|看记忆)\s*[?？]?\s*$/
// 名字后面紧跟的「执行/跑」只是语气词,剥掉,别混进任务里。
// 刻意**只在名字已经命中之后**才剥 —— 早期版本拿它当触发器
// (`让(\S+?)\s*(?:执行|跑)`),而中文没有词间空格,句中的「跑」会把名字
// 吃掉:「让公司那台帮我跑测试」被切成 名字=公司那台帮我 / 任务=测试。
const DELEGATE_VERB_PREFIX_RE = /^(?:执行|跑)\s*[:：]?\s*/
// 让/派 <hand> <任何话> — 按**已注册的手名**认。
//
// WHY(2026-09-02,owner 在微信里撞到):此前只有上面那条动词形式,于是
// 「让win想一想1+1=？」不触发派活、被本机答了。**判别维度选错了**:按动词
// 卡是打地鼠(想一想/看看/查一下/帮我/试试……补不完),而名字是天然的判别器
// —— 手名是 owner 亲手注册的,一共就那么几个,集合小且由人指定。按名字认
// 反而比按动词更严:动词表要跟整个汉语日常表达竞争,名字表不用。
//
// 中文没有词间空格(「让win想一想」里 win 和任务是连着的),所以不能靠分隔符
// 切,只能拿已知手名做前缀匹配 —— 这也正是它安全的原因:没注册过的名字
// 根本进不来。
const DELEGATE_LEAD_RE = /^\s*(?:让|派)\s*([\s\S]+)$/

export interface DelegateMatch { hand: string; task: string }

/**
 * 认出一条派活指令。`knownHands` 是**已注册的手名/id**。
 *
 * 顺序:先试动词形式(它能把「执行/跑」剥掉,不让动词混进任务里,而且名字
 * 未知时也返回 —— 明确说了「执行」就是明确想派活,该被告知名字打错了);
 * 再试名字前缀形式(只认已注册的名字,认不出就落回正常聊天)。
 */
export function matchDelegate(text: string, knownHands: readonly string[]): DelegateMatch | null {
  const lead = DELEGATE_LEAD_RE.exec(text)
  if (!lead) return null
  const rest = lead[1]!
  // 长名字优先:别让 "win" 抢走 "win-office" 的匹配。
  for (const name of [...knownHands].sort((a, b) => b.length - a.length)) {
    if (!name || !isDelegateName(name)) continue
    // 大小写不敏感:`让Win看看` 要能找到名叫 `win` 的手(输入法/自动大写
    // 每天都在制造这种差异)。中文没有大小写,toLowerCase 对它是恒等,所以
    // 这条对两种名字都安全。返回的是**注册时的原名**,下游按它查得到。
    if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue
    // ASCII 名字要词边界:`win` 不能从 `winn执行ls` / `winner去吧` 里匹出来。
    // 中文名不需要 —— 中文本来就没有词间空格,「公司那台帮我…」里
    // 「公司那台」后面接「帮」就是一个天然边界。
    const after = rest.charAt(name.length)
    if (/[A-Za-z0-9]$/.test(name) && /[A-Za-z0-9_-]/.test(after)) continue
    const task = rest.slice(name.length)
      .replace(/^[\s,，:：、]+/, '')
      .replace(DELEGATE_VERB_PREFIX_RE, '')   // 「让win执行1+1」→ 任务是「1+1」,不是「执行1+1」
      .trim()
    if (!task) return null                    // 「让win」不是一条指令
    return { hand: name, task }
  }
  return null
}
// Pronouns aren't hand names — without this, casual speech like "让我执行一下X"
// or "让它跑起来" would be hijacked as a delegate command (and reply "没找到叫
// 「我」的手"). Excluding them lets such phrases fall through to normal chat;
// real hands are named 家里/公司/home etc., never a pronoun.
const DELEGATE_PRONOUNS = new Set(['我', '你', '您', '他', '她', '它', '咱', '俺', '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '自己'])
export function isDelegateName(name: string): boolean {
  return !DELEGATE_PRONOUNS.has(name.trim())
}

// /botname <new-name>  — set the bot's user-facing self-name (admin only)
// /botname 跳过 / 不用 / 没有 / skip / clear / 清除  — clear (fall back to mode-derived)
// /botname             — show current
//
// NOTE: this is intentionally NOT `/name`. /name is the pre-existing
// user-self-rename command owned by mode-commands.ts:310-320 (PR2 #17 —
// "this user wants to be called X" → setUserName per-chat). Confusing
// the two would either silently swallow non-admin user-renames in
// mw-admin or accidentally redefine /name's meaning for admins. The
// rename to /botname is a deliberate disambiguation of the two scopes:
//   /name <X>     → per-chat user nickname (any sender, via mode-commands)
//   /botname <X>  → global bot self-name   (admin only, via this handler)
const BOTNAME_RE = /^\s*\/botname(?:\s+(.+?))?\s*$/
const BOTNAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])
// Same nickname constraint as onboarding + /name — sourced from ./nickname so
// the allowed set can't drift between them (was a hand-maintained duplicate).
const BOTNAME_VALID_RE = NICKNAME_RE
const BOTNAME_MAX_LEN = NICKNAME_MAX_LEN


/** 微信里的背包速览。只读:改状态去桌面端(在微信里做单选按钮不划算)。 */
async function sendHuntBag(deps: AdminCommandsDeps, chatId: string): Promise<void> {
  if (!deps.huntBag) {
    await deps.sendMessage(chatId, '这台还没接战利品记录 —— 升级到 1.7.0 以后打猎才会入库。').catch(() => {})
    return
  }
  const all = deps.huntBag()
  const kept = all.filter(r => r.status !== 'dropped')
  if (kept.length === 0) {
    await deps.sendMessage(chatId, all.length === 0
      ? '背包还是空的。我每天会上网替你找一两样东西,找到就记进来。'
      : '背包里的都处理完了(丢掉的那些还在桌面端折着)。').catch(() => {})
    return
  }
  const LABEL: Record<string, string> = { new: '没试', tried: '跑过', using: '在用' }
  const lines = kept.slice(0, 10).map(r =>
    `· [${LABEL[r.status] ?? '没试'}] ${r.title}${r.url ? `\n  ${r.url}` : ''}`)
  const more = kept.length > lines.length ? `\n\n还有 ${kept.length - lines.length} 件,桌面端「觅食台 → 打猎背包」看全部。` : ''
  await deps.sendMessage(chatId, `背包里有 ${kept.length} 件:\n\n${lines.join('\n')}${more}`).catch(() => {})
}

interface AdminCtx { handNames: readonly string[] }
/**
 * 一条管理员命令 = 一行(第三批 3d)。`match` 返回非 null ⇒ 这行认得这句,值交给 `run`。**各行两两互斥**(admin-commands
 * 的测试按语料逐对核):以前 if 链靠先后消歧(「自改 状态」要排在「自改 <需求>」前面),现在每行自己把别人的情况排除掉,
 * 以后谁调了表的先后也不会悄悄改行为。`background` 的那几行:handle 立刻回,活在后台跑(run 里自己持 holdBusy 的令牌)。
 */
interface AdminRow {
  id: string
  /** 显式命令写法(非主人发也要回一句「只有主人能用」)。斜杠开头的不用标,isExplicitAdminCommand 按前缀认。 */
  explicit?: true
  match(text: string, ctx: AdminCtx): unknown
  run(deps: AdminCommandsDeps, msg: InboundMsg, m: any): Promise<void>
  background?: true
}

const ADMIN_ROWS: readonly AdminRow[] = [
  { id: 'hand.join', explicit: true, match: t => matchHandJoin(t), run: (d, msg, code: string) => runHandJoin(d, msg.chatId, code) },
  { id: 'hands.list', match: t => HANDS_LIST_RE.test(t) || null, run: (d, msg) => sendHandsList(d, msg.chatId) },
  { id: 'bag', match: t => BAG_RE.test(t) || null, run: (d, msg) => sendHuntBag(d, msg.chatId) },
  { id: 'health', match: t => t === '/health' || null, run: (d, msg) => sendHealthReport(d, msg.chatId) },
  { id: 'health.ai', match: t => HEALTH_AI_RE.test(t) || null, run: (d, msg) => sendAiHealthReport(d, msg.chatId) },
  { id: 'reset', match: t => RESET_RE.test(t) || null, run: (d, msg) => runReset(d, msg.chatId) },
  { id: 'update', match: t => UPDATE_RE.test(t) || null, run: (d, msg) => runUpdate(d, msg.chatId) },
  { id: 'selfchange.status', explicit: true, match: t => SELF_CHANGE_STATUS_RE.test(t) || null, run: (d, msg) => runSelfChangeStatus(d, msg.chatId) },
  // 「自改 状态」也落在 `自改\s+<文字>` 里:这一行把它排除掉,两行互斥(以前靠 if 的先后)
  { id: 'selfchange.start', explicit: true, match: t => SELF_CHANGE_STATUS_RE.test(t) ? null : (SELF_CHANGE_RE.exec(t)?.[1]?.trim() || null), run: (d, msg, need: string) => runSelfChangeStart(d, msg.chatId, need) },
  { id: 'memory.show', match: t => SHOW_OVERVIEW_RE.test(t) || null, run: (d, msg) => runShowOverview(d, msg.chatId) },
  // 合成是慢的模型调用:先回、后台跑(runSynthesize 自己持 holdBusy)
  { id: 'memory.synthesize', background: true, match: t => SYNTHESIZE_RE.test(t) || null, run: (d, msg) => runSynthesize(d, msg.chatId) },
  // 按**已注册的手名**认(不是按动词):名字没命中就落回正常聊天,「让我看看这个」「让张三跑一趟」都不会被劫走。手跑整个 agent,慢 ⇒ 后台
  { id: 'delegate', background: true, match: (t, ctx) => matchDelegate(t, ctx.handNames), run: (d, msg, m: DelegateMatch) => runDelegate(d, msg.chatId, m.hand, m.task) },
  { id: 'cleanup', match: t => CLEANUP_RE.exec(t)?.[1] ?? null, run: (d, msg, which: string) => runCleanup(d, msg.chatId, which) },
  { id: 'hearth.ingest', match: t => { const m = HEARTH_INGEST_RE.exec(t); return m ? (m[1] ?? '') : null }, run: (d, msg, body: string) => runHearthIngest(d, msg, body) },
  { id: 'hearth.list', match: t => HEARTH_LIST_RE.test(t) || null, run: (d, msg) => runHearthList(d, msg.chatId) },
  { id: 'hearth.show', match: t => HEARTH_SHOW_RE.exec(t)?.[1] ?? null, run: (d, msg, id: string) => runHearthShow(d, msg.chatId, id) },
  { id: 'hearth.apply', match: t => HEARTH_APPLY_RE.exec(t)?.[1] ?? null, run: (d, msg, id: string) => runHearthApply(d, msg, id) },
  { id: 'hearth.help', match: t => HEARTH_HELP_RE.test(t) || null, run: (d, msg) => sendHearthHelp(d, msg.chatId) },
  { id: 'botname', match: t => { const m = t.match(BOTNAME_RE); return m ? { arg: m[1]?.trim() ?? '' } : null }, run: (d, msg, m: { arg: string }) => runBotname(d, msg.chatId, m.arg) },
]
/** 给测试:行 id 与先后。 */
export const ADMIN_ROW_IDS: readonly string[] = ADMIN_ROWS.map(r => r.id)
/** 给测试:哪几行认得这句(两两互斥 ⇒ 至多一行)。 */
export function adminRowsMatching(text: string, handNames: readonly string[] = []): string[] {
  return ADMIN_ROWS.filter(r => r.match(text, { handNames }) != null).map(r => r.id)
}

export function makeAdminCommands(deps: AdminCommandsDeps): AdminCommands {
  const knownHands = (): readonly string[] => { try { return deps.knownHandNames?.() ?? [] } catch { return [] } }   // 列不出手绝不能让整条消息处理不下去
  const rowFor = (text: string): { row: AdminRow; m: unknown } | null => {
    const ctx = { handNames: knownHands() }
    for (const row of ADMIN_ROWS) { const m = row.match(text, ctx); if (m != null) return { row, m } }
    return null
  }
  const runRow = async (row: AdminRow, msg: InboundMsg, m: unknown): Promise<void> => {
    if (row.background) { void row.run(deps, msg, m); return }
    await row.run(deps, msg, m)
  }
  const ownerOnly = async (msg: InboundMsg, text: string): Promise<void> => {
    // 以前一律静默吞掉、一个字不回;现在斜杠命令说清楚,日常说法不认领(进对话)
    deps.log('ADMIN_CMD', `non-admin ${msg.chatId} sent "${text.slice(0, 30)}" — owner only`)
    await deps.sendMessage(msg.chatId, '这条只有主人能用。').catch(() => {})
  }
  return {
    // 非主人:只认明确的命令写法(回一句「只有主人能用」);日常说法不认领,交给模型(重构第二批步 3a,§1.5 bug 4)
    probe(msg) { const t = msg.text.trim(); return isAdminCommandText(t, knownHands()) && (deps.isAdmin(msg.chatId) || isExplicitAdminCommand(t)) },
    async handle(msg) {
      const text = msg.text.trim()
      const hit = rowFor(text)
      if (!hit) return false
      if (!deps.isAdmin(msg.chatId)) {
        if (!isExplicitAdminCommand(text)) return false
        await ownerOnly(msg, text)
        return true
      }
      await runRow(hit.row, msg, hit.m)
      return true
    },
    commands() {
      const t = (msg: InboundMsg) => (msg.text ?? '').trim()
      return [
        { id: 'admin.owner-only', group: 'admin',
          probe: (msg) => !deps.isAdmin(msg.chatId) && isAdminCommandText(t(msg), knownHands()) && isExplicitAdminCommand(t(msg)),
          handle: async (msg) => { await ownerOnly(msg, t(msg)); return true } },
        ...ADMIN_ROWS.map((row): WechatCommand => ({
          id: `admin.${row.id}`, group: 'admin',
          probe: (msg) => deps.isAdmin(msg.chatId) && row.match(t(msg), { handNames: knownHands() }) != null,
          handle: async (msg) => {
            const m = row.match(t(msg), { handNames: knownHands() })
            if (m == null) return false
            await runRow(row, msg, m)
            return true
          },
        })),
      ]
    },
  }
}

/** 「有哪些手」:列出已配对的手(以前写在 handle 的 if 链里)。 */
async function sendHandsList(deps: AdminCommandsDeps, chatId: string): Promise<void> {
  const hands = deps.listHands?.() ?? []
  await deps.sendMessage(chatId, hands.length
    ? `已配对的手:\n${hands.map(h => `· ${h.name}${h.name === h.id ? '' : `(${h.id})`} → ${h.url ?? '没有地址'}`).join('\n')}\n\n说「让${hands[0]!.name} 看看…」就派给它。`
    : '还没配对任何手。在那台机器上跑 `wechat-cc hand invite`,把它给出的码粘到这里。').catch(() => {})
}

/** /botname [名字 | 跳过]:看 / 清 / 改 CC 的名字(以前写在 handle 的 if 链里,原样搬出来)。 */
async function runBotname(deps: AdminCommandsDeps, chatId: string, arg: string): Promise<void> {
  // /botname (no arg) — show current
  if (!arg) {
    const current = deps.getBotName()
    const display = current && current.trim() ? current.trim() : deps.botNameFallback(chatId)
    await deps.sendMessage(chatId, `我现在叫 ${display}`)
    return
  }
  // /botname 跳过 — explicit clear
  if (BOTNAME_SKIP_WORDS.has(arg.toLowerCase())) {
    try {
      await deps.setBotName(null)
      const fallback = deps.botNameFallback(chatId)
      await deps.sendMessage(chatId, `好的，回到默认「${fallback}」`)
    } catch (err) {
      deps.log('ADMIN_CMD', `/botname clear failed: ${err}`)
      await deps.sendMessage(chatId, '我没记住，稍后再试 /botname')
    }
    return
  }
  // /botname <new-name> — validate + set
  if (arg.length > BOTNAME_MAX_LEN) {
    await deps.sendMessage(chatId, `「${arg}」太长（最多 ${BOTNAME_MAX_LEN} 字符）。再试一次?`)
    return
  }
  if (!BOTNAME_VALID_RE.test(arg)) {
    await deps.sendMessage(chatId, `「${arg}」不行：只支持中文/字母/数字/空格/_/- (1-24 字)`)
    return
  }
  try {
    await deps.setBotName(arg)
    await deps.sendMessage(chatId, `好的，从现在开始我叫 ${arg}`)
  } catch (err) {
    deps.log('ADMIN_CMD', `/botname set failed: ${err}`)
    await deps.sendMessage(chatId, '我没记住，稍后再试 /botname')
  }
}

/**
 * 「自改 <需求>」—— 下单就回执,进展由流水线自己发卡回来(它是独立进程,
 * 微信通知走 internal-api,不经过这里)。这里**不等**:一条自改要跑几十分钟,
 * 在消息管道里 await 它等于把整条微信堵死。
 */
async function runSelfChangeStart(deps: AdminCommandsDeps, adminChatId: string, request: string): Promise<void> {
  if (!deps.selfChange) {
    await deps.sendMessage(adminChatId, '这台机器没法自改:daemon 没接自改流水线。').catch(() => {})
    return
  }
  const r = deps.selfChange.start(request)
  if (!r.ok) {
    deps.log('ADMIN_CMD', `自改 refused chat=${adminChatId}: ${r.reason}`)
    await deps.sendMessage(adminChatId, `这台机器没法自改:${r.reason}`).catch(() => {})
    return
  }
  deps.log('ADMIN_CMD', `自改 started chat=${adminChatId} pid=${r.pid}`)
  await deps.sendMessage(adminChatId, `自改开始了(pid ${r.pid}),进展会发到这里;说「自改 状态」看进度。`).catch(() => {})
}

/** 「自改 状态」—— 最近五条的 id · 步骤 · 结果。只读,不碰流水线。 */
async function runSelfChangeStatus(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  if (!deps.selfChange) {
    await deps.sendMessage(adminChatId, '这台机器没法自改:daemon 没接自改流水线。').catch(() => {})
    return
  }
  let rows: readonly { id: string; step: string; result: string | null }[] = []
  try { rows = deps.selfChange.list() }
  catch (err) { deps.log('ADMIN_CMD', `自改 状态 list failed: ${err}`) }
  if (rows.length === 0) {
    await deps.sendMessage(adminChatId, '还没有自改记录').catch(() => {})
    return
  }
  const lines = rows.slice(0, 5).map(r => `#${r.id} · ${r.step} · ${r.result ?? '进行中'}`)
  await deps.sendMessage(adminChatId, lines.join('\n')).catch(() => {})
}

async function runUpdate(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  if (!deps.updateSelf) {
    await deps.sendMessage(adminChatId, '/update 暂时用不了。')
    return
  }
  try {
    const r = await deps.updateSelf()
    if (!r.ok) {
      await deps.sendMessage(adminChatId, `更新没有启动：${r.reason}`)
      deps.log('ADMIN_CMD', `/update failed-to-start chat=${adminChatId}: ${r.reason}`)
      return
    }
    const pid = r.pid ? ` pid=${r.pid}` : ''
    await deps.sendMessage(adminChatId, `收到，开始更新 CC。更新过程会短暂重启服务，微信回复可能中断。${pid}`)
    deps.log('ADMIN_CMD', `/update started chat=${adminChatId}${pid}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `更新启动异常：${detail.slice(0, 160)}`)
    deps.log('ADMIN_CMD', `/update threw chat=${adminChatId}: ${detail}`)
  }
}

async function runHearthIngest(deps: AdminCommandsDeps, msg: InboundMsg, content: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, msg.chatId)
  if (!hearth) return
  const vault = process.env.HEARTH_VAULT
  if (!vault) {
    await deps.sendMessage(msg.chatId, 'HEARTH_VAULT 未设置。daemon 启动时加 env：HEARTH_VAULT=/path/to/vault')
    return
  }
  const agent = (process.env.HEARTH_AGENT === 'claude' ? 'claude' : 'mock') as 'mock' | 'claude'
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    await deps.sendMessage(msg.chatId, '用法：/hearth ingest <text>  （把 text 喂给 hearth ingest，落到 pending）')
    return
  }
  try {
    const result = await hearth.ingestFromChannel(
      {
        channel: 'wechat',
        message_id: `wechat-${msg.accountId}-${Date.now()}`,
        from: msg.chatId,
        text: trimmed,
        received_at: isoFromMs(msg.createTimeMs || Date.now(), Date.now()),
      },
      { vaultRoot: vault, agent, hearthStateDir: join(homedir(), '.hearth') },
    )
    if (result.ok) {
      const lines = [
        'hearth: ' + result.summary,
      ]
      // If the daemon is wired with share_page, publish a richer review card
      // and surface the URL alongside. The plan stays in pending either way —
      // share is a presentation surface, not a commit step.
      if (deps.sharePage && result.change_id) {
        try {
          const md = hearth.renderPlanMarkdown(result.change_id, { hearthStateDir: join(homedir(), '.hearth') })
          if (md.ok) {
            const card = await deps.sharePage(md.title ?? 'Hearth ChangePlan', md.markdown, {
              needs_approval: true,
              chat_id: msg.chatId,
            })
            lines.push('', 'review: ' + card.url)
          }
        } catch (err) {
          deps.log('HEARTH', `share_page failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      lines.push('', '↪ apply: /hearth apply ' + result.change_id)
      await deps.sendMessage(msg.chatId, lines.join('\n'))
    } else {
      await deps.sendMessage(msg.chatId, 'hearth ingest 失败: ' + result.summary + (result.error ? '\n详情: ' + result.error.slice(0, 500) : ''))
    }
    deps.log('HEARTH', `${msg.chatId} ingest agent=${agent} ok=${result.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(msg.chatId, 'hearth ingest 异常: ' + detail.slice(0, 500))
    deps.log('HEARTH', `ingest threw: ${detail}`)
  }
}

async function runHearthList(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, adminChatId)
  if (!hearth) return
  try {
    const r = hearth.listPending({ hearthStateDir: join(homedir(), '.hearth'), limit: 10 })
    await deps.sendMessage(adminChatId, r.rendered)
    deps.log('HEARTH', `${adminChatId} list — ${r.items.length} shown`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, '/hearth list 异常: ' + detail.slice(0, 500))
  }
}

async function runHearthShow(deps: AdminCommandsDeps, adminChatId: string, changeId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, adminChatId)
  if (!hearth) return
  try {
    const r = hearth.showPending(changeId, { hearthStateDir: join(homedir(), '.hearth') })
    await deps.sendMessage(adminChatId, r.rendered)
    deps.log('HEARTH', `${adminChatId} show ${changeId} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, '/hearth show 异常: ' + detail.slice(0, 500))
  }
}

async function runHearthApply(deps: AdminCommandsDeps, msg: InboundMsg, changeId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, msg.chatId)
  if (!hearth) return
  const vault = process.env.HEARTH_VAULT
  if (!vault) {
    await deps.sendMessage(msg.chatId, 'HEARTH_VAULT 未设置')
    return
  }
  try {
    const r = await hearth.applyForOwner(changeId, {
      vaultRoot: vault,
      hearthStateDir: join(homedir(), '.hearth'),
      ownerId: msg.chatId,
      channel: 'wechat',
    })
    await deps.sendMessage(msg.chatId, r.rendered)
    deps.log('HEARTH', `${msg.chatId} apply ${changeId} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(msg.chatId, '/hearth apply 异常: ' + detail.slice(0, 500))
  }
}

async function getHearthOrReply(deps: AdminCommandsDeps, chatId: string): Promise<HearthApi | null> {
  const loaded = await (deps.loadHearthApi ?? loadHearthApi)()
  if (loaded.ok) return loaded.api

  const detail = loaded.error ? `\n详情: ${loaded.error.slice(0, 300)}` : ''
  await deps.sendMessage(chatId, [
    'hearth 未安装或未配置，CC 其他功能不受影响。',
    '',
    '可选配置：',
    '  export HEARTH_HOME=/path/to/hearth',
    '  export HEARTH_MODULE=hearth',
    '  export HEARTH_VAULT=/path/to/vault',
    '',
    '然后重启 CC，再使用 /hearth。' + detail,
  ].join('\n'))
  deps.log('HEARTH', `not available reason=${loaded.reason} checked=${loaded.checked.join(', ')}`)
  return null
}

async function sendHearthHelp(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const vault = process.env.HEARTH_VAULT ?? '(未设置 HEARTH_VAULT)'
  const agent = process.env.HEARTH_AGENT === 'claude' ? 'claude' : 'mock'
  const lines = [
    'hearth (v0.3.1 channel review surface)',
    '',
    'vault: ' + vault,
    'agent: ' + agent,
    '',
    '命令：',
    '  /hearth ingest <text>      把 text 喂给 hearth，生成 pending ChangePlan',
    '  /hearth list               看一下当前 pending 队列',
    '  /hearth show <change_id>   预览某一份 ChangePlan',
    '  /hearth apply <change_id>  apply 到 vault（owner 直发即授权）',
    '  /hearth                    显示这条 help',
  ]
  await deps.sendMessage(adminChatId, lines.join('\n'))
}

// Admin chats with a synthesis in flight — guards against a double-tap firing
// a second (paid) LLM run before the first replies.
const synthesizeInFlight = new Set<string>()

/**
 * Prepare the synthesized overview for a WeChat read-back: strip the machine
 * stamp comment synthesizeOverview prepends (`<!-- … · <iso> -->`) — which
 * would otherwise show as raw text in plain-text WeChat — and surface its
 * timestamp as a friendly "（整理于 …）" line instead.
 */
export function formatOverviewForDisplay(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^<!--\s*([\s\S]*?)\s*-->\s*/)
  if (!m) return trimmed
  const body = trimmed.slice(m[0].length).trim()
  const tsM = m[1]!.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  const when = tsM ? `（整理于 ${new Date(tsM[1]!).toLocaleString()}）\n\n` : ''
  return `${when}${body}`
}

async function runShowOverview(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  // Guarded like the rest of this function: a throw here (e.g. memory.md I/O
  // error) must not escape — the pipeline awaits runShowOverview unguarded,
  // so an escaping rejection would surface as an unhandled rejection. On
  // failure we log and fall through to the existing overview path below,
  // same as any other "curated memory not available" case.
  let curated: string | null = null
  if (deps.readCuratedMemory) {
    try {
      curated = await deps.readCuratedMemory(adminChatId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.log('ADMIN_CMD', `show-overview curated-read failed chat=${adminChatId}: ${detail}`)
    }
  }
  if (curated) { await deps.sendMessage(adminChatId, curated).catch(() => {}); return }
  if (!deps.readOverview) {
    await deps.sendMessage(adminChatId, '记忆查看暂时用不了。').catch(() => {})
    return
  }
  try {
    const raw = (await deps.readOverview(adminChatId))?.trim()
    if (!raw) {
      await deps.sendMessage(adminChatId, '我还没整理过对你的理解。说「整理记忆」我就生成一份。')
      return
    }
    const display = formatOverviewForDisplay(raw)
    await deps.sendMessage(adminChatId, `我目前对你的理解：\n\n${display}`)
    deps.log('ADMIN_CMD', `show-overview chat=${adminChatId} bytes=${display.length}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `读取记忆失败：${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `show-overview failed chat=${adminChatId}: ${detail}`)
  }
}

async function runSynthesize(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  // Whole body is guarded: runSynthesize is dispatched fire-and-forget (the
  // pipeline doesn't await it), so ANY escaping rejection — including the
  // "整理中" ack send — would surface as an unhandled rejection.
  if (!deps.synthesizeMemory && !deps.runMemoryNightlyNow) {
    await deps.sendMessage(adminChatId, '记忆整理暂时用不了。').catch(() => {})
    return
  }
  if (synthesizeInFlight.has(adminChatId)) {
    await deps.sendMessage(adminChatId, '还在整理上一次，稍等一下…').catch(() => {})
    return
  }
  // 每晚整理落地后(Task 6/7),「整理记忆」优先立刻跑一次那套流程,而不是走
  // 下面的旧 cheapEval overview 重新生成。两条路复用同一个 in-flight 判重集合。
  if (deps.runMemoryNightlyNow) {
    synthesizeInFlight.add(adminChatId)
    const release = deps.holdBusy?.('admin-memory-nightly')
    try {
      await deps.sendMessage(adminChatId, '正在整理记忆…').catch(() => {})
      await deps.sendMessage(adminChatId, formatNightlyReply(await deps.runMemoryNightlyNow())).catch(() => {})
    } catch (e) {
      deps.log('ADMIN', `memory nightly failed: ${e instanceof Error ? e.message : String(e)}`)
      await deps.sendMessage(adminChatId, '这次没整理成，记忆保持原样。').catch(() => {})
    } finally {
      synthesizeInFlight.delete(adminChatId)
      release?.()
    }
    return
  }
  const synthesizeMemory = deps.synthesizeMemory
  if (!synthesizeMemory) {
    await deps.sendMessage(adminChatId, '记忆整理暂时用不了。').catch(() => {})
    return
  }
  synthesizeInFlight.add(adminChatId)
  // busy-registry hold (spec 2026-08-11 §2) — runSynthesize is dispatched
  // fire-and-forget (`void runSynthesize(...)` in handle()), outside
  // SessionManager, and can run for minutes (cheapEval over local memory
  // files). Held for the whole call, released in the finally below even on
  // throw.
  let releaseBusy: (() => void) | undefined
  try { releaseBusy = deps.holdBusy?.('admin-synthesize') } catch { releaseBusy = undefined }
  try {
    await deps.sendMessage(adminChatId, '正在重新整理我对你的理解…')
    const r = await synthesizeMemory(adminChatId)
    let lines: string[]
    if (r.written) {
      lines = ['整理完成，我对你的理解已更新。']
      // Reflect BOTH sides — synthesis spans work (项目) and life (微信观察),
      // so show what got folded in, not just the project count.
      const parts: string[] = []
      if (r.projectsFound > 0) parts.push(`${r.projectsFound} 个项目（${r.projectNames.join('、')}）`)
      const life: string[] = []
      if (r.observationsFound > 0) life.push(`${r.observationsFound} 条观察`)
      if (r.milestonesFound > 0) life.push(`${r.milestonesFound} 个里程碑`)
      if (r.memoryNotesFound > 0) life.push(`${r.memoryNotesFound} 篇记忆笔记`)
      if (life.length) parts.push(`生活侧 ${life.join('、')}`)
      if (r.foldersScanned > 0) parts.push(`本机文件 ${r.foldersScanned} 个文件夹`)
      if (parts.length) lines.push(`综合了：${parts.join('；')}`)
    } else {
      lines = ['没找到可整理的记忆（本机项目记忆 + 微信生活观察 + 本机文件 都还是空的）。']
    }
    await deps.sendMessage(adminChatId, lines.join('\n'))
    deps.log('ADMIN_CMD', `synthesize chat=${adminChatId} projects=${r.projectsFound} written=${!!r.written}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `整理失败：${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `synthesize failed chat=${adminChatId}: ${detail}`)
  } finally {
    synthesizeInFlight.delete(adminChatId)
    try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
  }
}

/**
 * Map the machine reason codes delegateToHand can surface into a short
 * human line for WeChat. Unknown reasons pass through (already-readable
 * messages, or codes worth seeing verbatim) so we never hide real errors.
 */
export function friendlyDelegateReason(reason: string): string {
  if (reason === 'paused') return '那台手当前已暂停。'
  if (reason === 'timeout' || /timed? ?out/i.test(reason)) return '那台手超时未响应(任务太久或离线)。'
  if (reason === 'malformed hand response') return '那台手返回了无法识别的结果。'
  if (/^http_401$|unauthorized/i.test(reason)) return '配对密钥不匹配,需要重新配对(hand invite / hand join)。'
  if (/^http_/.test(reason)) return `那台手返回错误(${reason})。`
  // 连接层失败。判定收敛在 lib/net-errors —— 这条分支本来就在,只是照着
  // **Node** 的措辞写的,而这个 daemon 跑在 **Bun** 上,Bun 说的是另一套话,
  // 于是形同虚设:2026-09-02 owner 在微信里收到的正是 Bun 的原文
  // 「Was there a typo in the url or port?」。
  if (isConnectFailure(reason) || /network|abort/i.test(reason)) {
    return '连不上那台手(它可能没开机、掉线了,或 A2A 没在对方能访问的地址上监听)。'
  }
  // 认不出来的原样透传 —— 刻意的:我们自己产出的 reason 本来就是给人看的
  // 中文(如「unknown_peer: claude —— 这台机器可用的是 [openai]」),包一层
  // 「我看不懂的错误」只会把好消息弄糟。真正的问题从来不是这条兜底,是上面
  // 那条连接分支漏了 Bun 的措辞。
  return reason
}

async function runDelegate(deps: AdminCommandsDeps, adminChatId: string, handName: string, task: string): Promise<void> {
  if (!deps.delegateToHand) {
    await deps.sendMessage(adminChatId, '派活功能未启用(没配置 A2A / 没有可派的"手")。').catch(() => {})
    return
  }
  // busy-registry hold (spec 2026-08-11 §2) — runDelegate is dispatched
  // fire-and-forget (`void runDelegate(...)` in handle()), outside
  // SessionManager, and waits on a remote hand's A2A exec (can take a
  // while). Held for the whole call, released in the finally below even
  // on throw.
  let releaseBusy: (() => void) | undefined
  try { releaseBusy = deps.holdBusy?.('admin-delegate') } catch { releaseBusy = undefined }
  try {
    await deps.sendMessage(adminChatId, `派给「${handName}」执行中…`)
    const r = await deps.delegateToHand(handName, task)
    if (r.ok) {
      await deps.sendMessage(adminChatId, `「${handName}」的结果:\n${r.response}`)
    } else if (r.reason === 'unknown_hand') {
      // No hand by that name. If some are registered, list them (doubles as
      // discovery); if none are, guide the operator to pair one.
      await deps.sendMessage(adminChatId, r.knownHands && r.knownHands.length
        ? `没找到叫「${handName}」的手。已注册的:${r.knownHands.join('、')}`
        : '还没配对任何手。在那台机器上跑 wechat-cc hand invite,再在这台 hand join。')
    } else {
      await deps.sendMessage(adminChatId, `派活失败:${friendlyDelegateReason(r.reason)}`)
    }
    deps.log('ADMIN_CMD', `delegate chat=${adminChatId} hand=${handName} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `派活失败:${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `delegate failed chat=${adminChatId} hand=${handName}: ${detail}`)
  } finally {
    try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
  }
}

/**
 * 粘码加手。配完**立刻试一次**:配对成功但连不上,是 owner 今天真撞到的
 * 失败形态 —— 那时他只会在第一次派活时才发现,而错误离根因很远。当场试
 * 一下,把「配上了」和「配上了但连不上」分开说。
 */
async function runHandJoin(deps: AdminCommandsDeps, adminChatId: string, code: string): Promise<void> {
  if (!deps.joinHandByCode) {
    await deps.sendMessage(adminChatId, '加手功能未启用(这台没开 A2A)。').catch(() => {})
    return
  }
  await deps.sendMessage(adminChatId, '正在配对…').catch(() => {})
  let r: Awaited<ReturnType<NonNullable<AdminCommandsDeps['joinHandByCode']>>>
  try { r = await deps.joinHandByCode(code) }
  catch (err) { r = { ok: false, error: err instanceof Error ? err.message : String(err) } }
  if (!r.ok) {
    await deps.sendMessage(adminChatId, `配对失败:${friendlyDelegateReason(r.error)}`).catch(() => {})
    deps.log('ADMIN_CMD', `hand join failed chat=${adminChatId}: ${r.error}`)
    return
  }
  // 地址一定要显出来 —— 粘错一串别人给的码,这是唯一能一眼看见的地方。
  await deps.sendMessage(adminChatId, `已加手「${r.name}」→ ${r.url}\n正在试一下能不能派活…`).catch(() => {})
  deps.log('ADMIN_CMD', `hand joined chat=${adminChatId} id=${r.id} url=${r.url}`)

  if (!deps.delegateToHand) return
  let probe: Awaited<ReturnType<NonNullable<AdminCommandsDeps['delegateToHand']>>>
  try { probe = await deps.delegateToHand(r.id, '只回两个字:收到') }
  catch (err) { probe = { ok: false, reason: err instanceof Error ? err.message : String(err) } }
  await deps.sendMessage(adminChatId, probe.ok
    ? `通了。现在说「让${r.name} 看看…」就派给它。`
    : `配上了,但派活没通:${friendlyDelegateReason(probe.reason)}\n手那台还在的话,检查它的 A2A 是否绑在这台能访问的地址上。`,
  ).catch(() => {})
}

async function sendHealthReport(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const active = deps.pollHandle.running()
  const expired = deps.sessionState.listExpired()

  const lines: string[] = ['daemon 健康']
  lines.push(`启动时间: ${deps.startedAt}`)
  lines.push('')

  lines.push(`活跃 bot (${active.length}):`)
  if (active.length === 0) lines.push('  (无 — 需要 wechat-cc setup)')
  else for (const id of active) lines.push(`  ${id}`)

  if (expired.length > 0) {
    lines.push('')
    lines.push(`过期 bot (${expired.length}):`)
    for (const e of expired) lines.push(`  - ${e.id} (${hoursSince(e.first_seen_expired_at)})`)
    lines.push('')
    lines.push('清理：')
    lines.push(`  "清理 ${expired[0]!.id}"  (单个)`)
    lines.push('  "清理所有过期"            (全部)')
  } else {
    lines.push('')
    lines.push('无过期 bot')
  }

  const result = await deps.sendMessage(adminChatId, lines.join('\n'))
  if (result.error) {
    deps.log('ADMIN_CMD', `/health reply to ${adminChatId} failed: ${result.error}`)
  }
}

async function runCleanup(deps: AdminCommandsDeps, adminChatId: string, target: string): Promise<void> {
  const expired = deps.sessionState.listExpired()
  let victims: ExpiredBot[]

  if (target === 'all-expired' || target === '所有过期') {
    victims = expired
  } else {
    const match = expired.find(e => e.id === target)
    if (!match) {
      await deps.sendMessage(adminChatId, `${target} 不在过期列表里。先发 /health 确认。`)
      return
    }
    victims = [match]
  }

  if (victims.length === 0) {
    await deps.sendMessage(adminChatId, '没有过期 bot 需要清理。')
    return
  }

  const results: string[] = []
  for (const v of victims) {
    try {
      // Await the loop's full unwind before rmSync — otherwise the
      // background poll's still-open long-poll fetch may try to
      // re-read state from the account dir we're about to delete,
      // racing with rmSync. Replaces the fire-and-forget stopAccount.
      //
      // stopAccountAndWait itself swallows the loop's exceptions
      // (logged inside runLoop), so the outer catch below ONLY catches
      // rmSync / sessionState.clear failures — not stop failures.
      await deps.pollHandle.stopAccountAndWait(v.id)
      rmSync(join(deps.stateDir, 'accounts', v.id), { recursive: true, force: true })
      deps.sessionState.clear(v.id)
      results.push(`  ✓ ${v.id}`)
      deps.log('ADMIN_CMD', `cleaned up expired bot ${v.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push(`  ✗ ${v.id}: ${msg}`)
      deps.log('ADMIN_CMD', `cleanup ${v.id} failed: ${msg}`)
    }
  }

  await deps.sendMessage(adminChatId, [
    `清理完成 (${victims.length}):`,
    ...results,
    '',
    '重扫：wechat-cc setup',
  ].join('\n'))
}

async function runReset(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const proj = deps.resolveProject(adminChatId)
  if (!proj) {
    await deps.sendMessage(adminChatId, '本聊天未绑定任何项目，没有可重置的会话。')
    return
  }
  // Release every registered provider's in-memory session for this alias,
  // then wipe the persisted resume-id row so the next dispatch is a clean
  // start. Releasing release() is idempotent (no-op if nothing cached).
  const providers = deps.registry.list()
  for (const p of providers) {
    try {
      // /reset only touches the admin's own session — other chats on the
      // same alias keep their independent sessions intact.
      await deps.sessionManager.release({ alias: proj.alias, providerId: p, chatId: adminChatId })
    } catch (err) {
      deps.log('ADMIN_CMD', `/reset release ${proj.alias}/${p} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  // Matches the release() bucket above — wipe the admin's chat_id rows.
  deps.sessionStore.delete({ alias: proj.alias, chatId: adminChatId })
  deps.log('ADMIN_CMD', `/reset chat=${adminChatId} alias=${proj.alias} providers=${providers.join(',')}`)
  await deps.sendMessage(
    adminChatId,
    `✓ 已重置 AI 会话\n  chat: ${adminChatId}\n  project: ${proj.alias}\n  providers: ${providers.join(', ') || '(无)'}\n\n下一条消息会从干净状态开始。`,
  )
}

async function sendAiHealthReport(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const proj = deps.resolveProject(adminChatId)
  if (!proj) {
    await deps.sendMessage(adminChatId, '本聊天未绑定任何项目，无法查询 AI 会话状态。')
    return
  }
  const providers = deps.registry.list()
  const lines: string[] = ['AI 会话状态', `project: ${proj.alias}`, '']
  if (providers.length === 0) {
    lines.push('(无已注册的 provider — 检查 daemon 启动日志)')
  } else {
    for (const p of providers) {
      // /health ai inspects the admin's own session row.
      const rec = deps.sessionStore.get({ alias: proj.alias, provider: p, chatId: adminChatId })
      if (rec) {
        const age = humanAge(Date.parse(rec.last_used_at))
        lines.push(`  ${p}: 会话 ${rec.session_id.slice(0, 8)}… (${age} 前)`)
      } else {
        lines.push(`  ${p}: 无会话`)
      }
    }
  }
  lines.push('', '重置：/reset  （丢掉所有 provider 的会话，下一条从头开始）')
  await deps.sendMessage(adminChatId, lines.join('\n'))
}

/** "5m ago" style — minutes / hours / days. Returns "<1m" for sub-minute. */
function humanAge(parsedAtMs: number): string {
  if (Number.isNaN(parsedAtMs)) return '?'
  const sec = Math.floor((Date.now() - parsedAtMs) / 1000)
  if (sec < 60) return '<1m'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function hoursSince(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return '?h'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '<1h'
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
