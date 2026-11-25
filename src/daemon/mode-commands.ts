import { CLI_SETUP_IDS } from '../lib/executor-cli-setup'
import { taskHandoffNames } from './task-handoff-names'
import { isTaskHandoffCommand } from '../features/workbench'
/**
 * mode-commands — slash commands that switch a chat's Conversation Mode
 * (RFC 03 §4.1 P2 scope).
 *
 * Recognised in P2:
 *   /cc                    → solo mode, provider=claude
 *   /codex                 → solo mode, provider=codex
 *   /cursor                → solo mode, provider=cursor
 *   /solo                  → revert to daemon default (delete persisted mode)
 *   /mode                  → show current effective mode + registered providers
 *
 * Reserved for later (parsed but rejected with "not yet implemented"):
 *   /both /parallel /chat  → 告诉主人「多模型讨论在桌面上开」(10-21 起微信不再开这两种模式)
 *   /cc + codex            → primary_tool with claude primary (P4)
 *   /codex + cc            → primary_tool with codex primary (P4)
 *
 * Like admin-commands, this handler runs BEFORE the conversation
 * coordinator so the slash command is consumed and never reaches the
 * agent. Reply text goes back to the user via sendMessage. Unlike
 * admin-commands, EVERY user can flip their own chat's mode (no admin
 * gate) — this is per-chat user preference, not a system-wide change.
 */
import { SOCIAL_OFF_LINE, socialUnavailableLine } from './social-state'
import { hhmmInQuiet, parseQuietHours, quietLabel } from '../domain/quiet-hours'
import { parseAvoidTopics, topicLabels, type AvoidTopic } from '../domain/companion-topics'
import type { ConversationCoordinator } from '../app/conversation-coordinator'
import { namesIn, type ProviderRegistry } from '../app/provider-registry'
import type { Mode, ProviderId } from '../domain/conversation'
import type { InboundMsg } from '../domain/prompt-format'
import { botName } from './bot-name'
import { validateNickname, NICKNAME_MAX_LEN } from './nickname'
import { capabilitiesFor } from '../domain/capability-matrix'
import type { AgentConfig } from '../lib/agent-config'
import type { UserTier } from '../domain/user-tier'
import { noAskNotice } from '../domain/enforcement-matrix'
import { providerDenialFor, describeProviderDenial, providerForSlash, PROVIDER_SLASH } from '../domain/provider-policy'
import { isKnownProviderId, PROVIDER_IDS } from '../lib/provider-ids'
import type { WechatCommand } from './commands/registry'

/** /set 读写的这一对话的偏好(chat-prefs 的子集)。 */
type ModeChatPrefs = { split?: boolean; care?: 'off' | 'low' | 'high'; stickers?: boolean; hunt?: boolean; visit?: boolean; avoid?: AvoidTopic[]; quiet?: import('../domain/quiet-hours').QuietWindow }

export interface ModeCommandsDeps {
  /** 主人建的早报 / 周报几点到(设免打扰时撞上了就当场说「会天天跳过」,整合者评审 #509)。没接 ⇒ 不提。 */
  initiativeJobTimes?: () => Array<{ label: string; at: string }>
  coordinator: Pick<ConversationCoordinator, 'getMode' | 'setMode' | 'cancel'>
  registry: Pick<ProviderRegistry, 'has' | 'get' | 'list'>
  /** Default provider id, surfaced by /mode + /solo for status messages. */
  defaultProviderId: ProviderId
  /** Agent config — used to resolve the bot's self-name (override or fallback). */
  agentConfig: AgentConfig
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** Persist a per-chat nickname. Used by /name. */
  setUserName(chatId: string, name: string): Promise<void>
  /** Lookup current nickname for this chat (null if none). Used by /whoami. */
  getUserName(chatId: string): string | null
  /**
   * 只读的全局配置视图(/api list 显示网关地址/全局默认模型/别名,/set 显示
   * 后台评估用哪家)。缺省 ⇒ 这些行不显示。
   */
  readConfig?: () => { openaiBaseUrl?: string; openaiModel?: string; openaiAliases?: Record<string, string>; cheapEvalProvider?: string; trusted_providers?: string[] }
  /** `/api alias ds=DeepSeek` / `/api unalias ds`(model=null 删除)。缺省 ⇒ 别名子命令回「未接线」。 */
  setOpenaiAlias?: (alias: string, model: string | null) => void | Promise<void>
  /** `/set cheap <provider|auto>` 走 config-surface 的 writeConfigKey(管理员)。 */
  setConfig?: (key: string, value: string) => Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
  /** `/set provider <id>` 写完触发 daemon 重启(默认 provider 是开机捕获的)。缺省 ⇒ 回复里让主人手动重启。 */
  requestRestart?: (reason: string) => void
  /** 各 provider 的一句话状态(bootstrap 填:codex「你的 CLI 0.153.4 · 首次使用时探测 / 探测通过」),/mode 显示。 */
  providerNotes?: () => Partial<Record<ProviderId, string>>
  /** `/api list` 的网关模型发现(daemon/openai-models.ts)。缺省 ⇒ 列表只有别名。 */
  openaiModels?: { list(): Promise<{ models: string[]; error?: string; fromCache?: boolean }> }
  /** Per-chat prefs (chat-prefs store). /set reads+writes THIS chat's entry. */
  /** 社交此刻的状态(daemon/social-state.ts)。`/set visit on` 时社交不在 ⇒ 照存,但说清楚现在不会去串门。缺省 ⇒ 老说法。 */
  socialState?: () => import('./social-state').SocialState
  chatPrefs: {
    get(chatId: string): ModeChatPrefs
    set(chatId: string, patch: ModeChatPrefs): ModeChatPrefs
  }
  log: (tag: string, line: string) => void
  /** Returns true when userId belongs to an admin. Used by /help to gate the admin section. */
  isAdmin?: (userId: string) => boolean
  /** Mint a tappable graphical-settings-panel URL (10-min one-active token,
   *  LAN only) — appended to the admin's `/set` overview reply. Absent or
   *  resolving null ⇒ the reply is byte-identical to before this existed. */
  settingsPanelLink?: () => Promise<string | null>
  /**
   * Resolve a chat's access tier. Used ONLY to gate `/agy`: agy's MCP tool
   * access is tier-C (spec 2026-08-17-agy-provider-design.md §3) — its
   * global `~/.gemini/config/mcp_config.json` carries a single long-lived
   * 'trusted' token shared by every conversation agy runs, with no
   * per-session isolation. A guest chat switching a session to agy would
   * therefore get trusted-tier tool access it isn't entitled to, so guest
   * chats are refused outright rather than silently over-privileged.
   */
  resolveTier(chatId: string): UserTier
}

export interface ModeCommands {
  /** 只读:是不是斜杠命令(含 /帮助)。handle 对任何斜杠词都会消费(认识的执行,不认识的回一句)。 */
  probe(msg: InboundMsg): boolean
  /** Returns true iff the message was a slash command and was consumed. */
  handle(msg: InboundMsg): Promise<boolean>
  /** 命令表里的写法:一条一行(mode.<行>),最后一行 mode.unknown 是 /词兜底(第三批 3d)。 */
  commands(): WechatCommand[]
  /** 本文件认的全部斜杠词(小写),从命令行表推出来。测试拿它核 /help 有没有提到每个词。 */
  slashWords(): readonly string[]
}

/** 一个斜杠命令(第三批 3d):认哪几个 /词、带什么样的参数时认、认了怎么办。run 回 false = 不归它,接着试下一行。 */
interface SlashRow {
  id: string
  words: readonly string[]
  match(slashWord: string, tail: string): boolean
  run(msg: InboundMsg, slashWord: string, tail: string): Promise<boolean>
}

// Recognized command tokens; case-insensitive on the leading slash word
// because the user might type `/CC` or `/Codex`. The provider mapping is
// case-sensitive though (canonical lowercase ids).
const COMMAND_REGEX = /^\s*\/([a-z][a-z_-]*)(?:\s+(.+))?\s*$/i

// A3 (spec §A3): the slash-words this file recognises somewhere below (the
// isProviderCommand table + every other bare/argument-taking branch in
// `handle()`). Kept as an explicit list rather than derived at runtime so
// reviewers see it grow in the same diff as a new branch — checklist item
// for "adding a command", paired with the /help + /mode lists below.
// (3d 起:不再手写,由 makeModeCommands 里的 slashRows 推出来 —— 见 knownSlashWords)

// A3: a bare, ASCII-only, 2-16 letter slash command ⇒ almost certainly a
// typo'd or half-remembered command, not the user talking to the bot (real
// sentences carry spaces/punctuation/Chinese). Deliberately narrow: an
// argument, Chinese characters, or a length outside this range fall through
// unchanged below — the user might genuinely be mid-sentence.
const UNKNOWN_SLASH_RE = /^\/[a-zA-Z]{2,16}$/

/** 小型 Levenshtein:只给 /api 打错字时找近似项用,名字都很短。 */
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!; dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}

/** 微信里发 /both /chat 时的回话(主人 10-21 定:多 agent 交给软件)。 */
export const MULTI_MODEL_ON_DESKTOP = '多模型讨论(几家一起回 / 圆桌)现在在桌面上开:桌面「对话」里切换模式。微信这边用 /cc /codex 这些单家模式,或 /cc + codex 让一家主答、另一家当工具。'

export function makeModeCommands(deps: ModeCommandsDeps): ModeCommands {
  // 斜杠词表只有一份(core/provider-policy 的 PROVIDER_SLASH):/cc ⇒ claude、/api ⇒ openai(「主人自己的 API」,
  // 不绑哪家厂商;openai 没注册时下面 registry.has() 那道回「还没接上」)…… 拒绝语报词也读同一张表。
  function isProviderCommand(slashWord: string): ProviderId | null {
    return providerForSlash(slashWord)
  }

  // Mirrors the delegate-mcp wiring in src/daemon/bootstrap/index.ts:322-325.
  // primary_tool mode persists ONLY `primary` on Mode — the peer is whichever
  // provider this primary's session has delegate_<peer> wired for at boot time.
  // So `/cc + cursor` can't actually work: Claude session exposes delegate_codex
  // (not delegate_cursor), and the persisted Mode wouldn't carry the peer either.
  // We surface that asymmetry up-front rather than silently substituting the
  // wired peer behind the operator's back.
  function defaultDelegatePeer(primary: ProviderId): ProviderId | null {
    // Single source of truth per [[architecture-conventions]]: the peer comes
    // from the provider's ProviderCapabilities.defaultPeer, not a hardcoded
    // ternary — so a new provider (openai → claude, …) is covered without
    // editing this function. Values match the prior hardcoded ones
    // (claude→codex, codex→claude, cursor→claude, gemini→claude).
    return capabilitiesFor(primary).defaultPeer ?? null
  }


  function displayName(id: ProviderId): string {
    return deps.registry.get(id)?.opts.displayName || (isKnownProviderId(id) ? namesIn(deps.registry, id).short : id)
  }

  function chinesePunctuation(text: string): string {
    const punctuation: Record<string, string> = { ',': '，', ';': '；', ':': '：' }
    return text.replace(/(?<=\p{Script=Han}[ \t]*)[,;:]|[,;:](?=[ \t]*\p{Script=Han})/gu, mark => punctuation[mark]!)
  }

  function notConnected(id: ProviderId): string {
    const setup = (CLI_SETUP_IDS as readonly string[]).includes(id) ? '到电脑上点一下接入。' : ''
    return `还没接上 ${displayName(id)}。${setup}现在能用：${deps.registry.list().map(displayName).join('、') || '无'}。`
  }

  function describeMode(m: Mode): string {
    switch (m.kind) {
      case 'solo': return `${displayName(m.provider)} 来答${m.model ? `（模型 ${m.model}）` : ''}`
      case 'primary_tool': {
        const peer = defaultDelegatePeer(m.primary)
        return `${displayName(m.primary)} 来答${peer ? `，需要时叫 ${displayName(peer)} 帮忙` : ''}`
      }
      case 'parallel': return '几家一起答'
      case 'chatroom': return '几家一起讨论'
    }
  }

  /** /help 用:六个斜杠词里当前真能用的(已注册)。 */
  function availableSlashes(): string {
    const order: readonly ProviderId[] = PROVIDER_IDS
    const slash = (id: ProviderId) => id === 'claude' ? '/cc' : id === 'openai' ? '/api' : `/${id}`
    const have = order.filter(id => deps.registry.has(id)).map(slash)
    return have.length ? have.join(' ') : '还没接上任何一家'
  }

  /**
   * `/api <名字>` 的核对:别名与网关列表里都找不到就是打错了。
   *  ok        → 网关认的拼法(大小写按网关归一)
   *  unknown   → 不在网关上;suggestions 是近似项(编辑距离 ≤ 2 或同前缀),最多 3 个
   *  unverified→ 网关列表拿不到(没接线 / 报错),调用方原样透传并说明
   */
  async function resolveOpenaiModel(name: string): Promise<{ kind: 'ok'; model: string } | { kind: 'unknown'; suggestions: string[] } | { kind: 'unverified' }> {
    if (!deps.openaiModels) return { kind: 'unverified' }
    let listed: string[]
    try {
      const r = await deps.openaiModels.list()
      if (r.error) return { kind: 'unverified' }
      listed = r.models
    } catch { return { kind: 'unverified' } }
    const aliases = deps.readConfig?.().openaiAliases ?? {}
    const lower = name.toLowerCase()
    const exact = listed.find(m => m === name) ?? listed.find(m => m.toLowerCase() === lower)
    if (exact) return { kind: 'ok', model: exact }
    const aliasCI = Object.keys(aliases).find(a => a.toLowerCase() === lower)
    if (aliasCI) return { kind: 'ok', model: aliases[aliasCI]! }
    const candidates = [...new Set([...Object.keys(aliases), ...listed])]
    const near = candidates
      .map(c => ({ c, d: editDistance(lower, c.toLowerCase()) }))
      .filter(x => x.d <= 2 || (lower.length >= 3 && x.c.toLowerCase().startsWith(lower.slice(0, 3))))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(x => x.c)
    return { kind: 'unknown', suggestions: near }
  }

  /** `/api list`:本对话当前 · 全局默认 · 别名 · 网关现有(用户主动触发才拨)。 */
  async function renderApiList(chatId: string): Promise<string> {
    const cfg = deps.readConfig?.() ?? {}
    const cur = deps.coordinator.getMode(chatId)
    const pinned = cur.kind === 'solo' && cur.provider === 'openai' ? cur.model : undefined
    const lines: string[] = []
    lines.push(`/api 模型${cfg.openaiBaseUrl ? `（网关 ${cfg.openaiBaseUrl}）` : ''}`)
    if (!deps.registry.has('openai')) {
      lines.push('还没接上自定义 AI 服务。把 WECHAT_OPENAI_API_KEY 写进 daemon.env，再填好服务地址 openaiBaseUrl 和模型名 openaiModel，然后重启 CC。')
    }
    lines.push(`本对话当前：${pinned ?? (cfg.openaiModel ? `${cfg.openaiModel}（全局默认）` : '未设置')}${pinned && cfg.openaiModel ? `（全局默认 ${cfg.openaiModel}）` : ''}`)
    const aliases = cfg.openaiAliases ?? {}
    const aliasKeys = Object.keys(aliases).sort()
    lines.push(`别名：${aliasKeys.length ? aliasKeys.map(a => `${a} → ${aliases[a]}`).join(' · ') : '无（发 /api alias ds=DeepSeek 起个短名）'}`)
    if (deps.openaiModels) {
      const r = await deps.openaiModels.list()
      if (r.error) lines.push(`网关列表拿不到：${r.error}`)
      else {
        const shown = r.models.slice(0, 40)
        lines.push(`网关上有（${r.models.length}${r.fromCache ? '，缓存' : ''}）：${shown.join('、')}${r.models.length > shown.length ? ' …' : ''}`)
      }
    }
    lines.push('用法：/api <别名或模型名>（只对本对话） · /api alias ds=DeepSeek · /api unalias ds · /api 回到全局默认')
    return lines.join('\n')
  }

  async function reply(chatId: string, text: string): Promise<void> {
    const r = await deps.sendMessage(chatId, text)
    if (r.error) {
      deps.log('MODE_CMD', `reply to ${chatId} failed: ${r.error}`)
    }
  }

  async function handleHelp(msg: InboundMsg, admin: boolean): Promise<boolean> {
    // /help 分层 (spec §5): gated by resolveTier === 'guest', NOT isAdmin.
    // isAdmin's allowFrom fallback can misjudge an old install's actual
    // owner (falls back to allowFrom membership before admins[] has ever
    // been backfilled), which would incorrectly hand THAT owner the guest
    // help text; resolveTier's own fallback ladder (user-tier.ts) treats
    // that same owner correctly, and the owner returns to full /help the
    // moment `hearth doctor` backfills admins[]. Guests only see the slice
    // of /help that's actually usable/meaningful at their tier: the
    // opening blurb, identity (/whoami /name), /set split, and file
    // send/receive — provider switching, /set care, and 陪伴/配对 are
    // either refused outright at guest tier or meaningless to a chat that
    // was never allowlisted for them.
    const isGuest = deps.resolveTier(msg.chatId) === 'guest'
    // 微信不渲染 Markdown(终端那边的回复发微信前也会去掉),小标题用「【】」,不用 **粗体**。
    const lines = isGuest
      ? [
          '这里是微信，直接跟我说话就行。常用的命令：',
          '',
          '【身份】',
          '/whoami —— 看你的身份和现在是谁在答',
          '/name <昵称> —— 设置或改昵称',
          '',
          '【设置】',
          '/set split on|off —— 回复像真人一样分几条发（也可以说「拆分 开」「拆分 关」）',
          '',
          '【文件】',
          '拖图片/文件给我即可',
          '',
          '或者直接提问、丢代码、让我跑命令。',
        ]
      : [
          '这里是微信，直接跟我说话就行。常用的命令：',
          '',
          '【模式切换】',
          // Provider checklist: keep this list in sync with /mode's list below (~:434).
          `/cc /codex /cursor /api /gemini /agy /grok —— 这个对话换成某一家来答（现在能用：${availableSlashes()}）。/api 是你配的 OpenAI 兼容后端（DeepSeek、Kimi 等）。`,
          '/gemini 是 API key 版（已弃用，留给已经配了 GEMINI_API_KEY 的人）；新接入请用 /agy。',
          '/agy 和 /cursor 用的是订阅 CLI：/agy 所有对话共用一把钥匙；/cursor 按对话分权限，但它在工作区里改文件不经过权限卡。访客都不能用这两个。',
          '/api list —— 看网关上有哪些模型；/api <别名|模型> 换模型（只对这个对话）；/api alias ds=DeepSeek 起个短名',
          '/cc + codex —— Claude 来答，需要时叫 Codex 帮忙',
          '几个模型一起讨论（并行 / 圆桌）在桌面上开',
          '/solo 回到默认 · /stop 退出 · /mode 看现在是谁在答',
          '/set —— 这个对话的偏好（拆分回复、主动关心、表情包、每日打猎）；/set cheap 后台判断用哪家、/set providers 别人能用哪几家（管理员）',
          '改配置直接说就行，比如「换成 gemini flash」「把知识内核打开」（管理员）',
          '',
          '【身份】',
          '/whoami —— 看你的身份和现在是谁在答',
          '/name <昵称> —— 设置或改昵称',
          '',
          '【项目和陪伴】',
          '直接说「切到 <项目>」「开启陪伴」「别烦我」就行',
          '',
          '【文件】',
          '拖图片/文件给我即可',
          '',
          '或者直接提问、丢代码、让我跑命令。',
        ]
    // Guests can never be admin (a guest chat isn't allowlisted, let alone
    // in admins[]) — `!isGuest` here is defense-in-depth against an
    // identity-resolution mismatch between isAdmin(userId) and
    // resolveTier(chatId), not an expected real-world combination.
    if (admin && !isGuest) {
      lines.push(
        '',
        '【管理员命令】',
        '/health · /health ai —— 看 CC 和模型是否正常',
        '/reset（/重置）—— 重置这个对话',
        '/botname [名字] —— 设置 / 查看 CC 在微信里显示的名字',
        '/hearth help —— 整理知识库（hearth 子命令）',
        '清理 <账号编号> / 清理 all-expired —— 清理过期的微信账号连接',
        '整理记忆 / 看记忆 —— 重新整理 / 查看 CC 对你的理解',
        '让<名字>执行 <任务> —— 派活给配对过的另一台电脑',
        '「终端」「日报」「看 码」「@码 话」—— 终端里的会话（Claude Code / Codex / Cursor）：列出会话 / 今天的情况 / 看最近的对话 / 接着说一句',
        '「给我写封信」—— CC 给你写一封信，排成信纸寄到微信',
      )
    }
    await reply(msg.chatId, lines.join('\n'))
    deps.log('MODE_CMD', `chat=${msg.chatId} → /help (admin=${admin}, tier=${isGuest ? 'guest' : 'non-guest'})`)
    return true
  }

  // 斜杠命令一条一行(第三批 3d):每行认哪几个 /词、什么时候认(有的要求不带参数)、认了怎么办。
  // run 是原来 handle 里那一段原样搬过来的;落出那一段(没 return)就回 false,接着试下一行 —— 跟以前往下走一样。
  // KNOWN_SLASH_COMMANDS 从这张表推出来,/help 有没有提到每个词由测试管(不自动生成,/help 是按组写给人看的)。
  const slashRows: SlashRow[] = [
  // /cc, /codex
    { id: 'provider', words: Object.values(PROVIDER_SLASH), match: (w) => !!isProviderCommand(w), run: async (msg, slashWord, tail) => {
      const providerId = isProviderCommand(slashWord)!
      // agy tier-C guest gate — checked before ANY setMode (bare, `+peer`,
      // or the model-pin tail below) since its whole failure mode is
      // over-privileged tool access, not a specific sub-command. See
      // ModeCommandsDeps.resolveTier's doc comment.
      {
        // core/provider-policy.ts:共享钥匙的 provider(目前只剩 agy —— cursor
        // 2026-09-18 改走 ACP 后按对话分权限,不再共享钥匙)拒 guest;
        // 管理员的 trusted_providers 允许表拒非管理员。coordinator 分发时再
        // 判一次(防 set-mode 绕过 / 事后降级)。
        const denial = providerDenialFor(providerId, deps.resolveTier(msg.chatId), deps.readConfig?.().trusted_providers)
        if (denial) {
          const text = denial.kind === 'not_in_trusted_list'
            ? `管理员没把 /${slashWord.toLowerCase()} 开放给别人（非管理员）。现在能用：${denial.allowed.map(displayName).join('、') || '无'}。`
            : denial.kind === 'shared_token_guest'
              ? `访客不能用 /${slashWord.toLowerCase()}：所有对话共用一把钥匙，没法给访客单独设权限。`
              : describeProviderDenial(denial, slashWord.toLowerCase())
          await reply(msg.chatId, text)
          return true
        }
      }
      if (tail === '') {
        if (!deps.registry.has(providerId)) {
          await reply(msg.chatId, notConnected(providerId))
          return true
        }
        deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: providerId })
        const dn = namesIn(deps.registry, providerId).short
        const notice = noAskNotice(providerId, deps.resolveTier(msg.chatId))
        await reply(msg.chatId, `这个对话从下一条消息开始只由 ${dn} 来答。${notice ? `\n${chinesePunctuation(notice)}` : ''}`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → solo+${providerId}`)
        return true
      }
      // /cc + codex / /codex + cc — primary_tool mode (RFC 03 P4)
      const peerMatch = /^\+\s*([a-z][a-z_-]*)\s*$/i.exec(tail)
      if (peerMatch) {
        const peerSlash = peerMatch[1]!
        const peerProviderId = isProviderCommand(peerSlash)
        if (!peerProviderId) {
          await reply(msg.chatId, `没认出「${peerSlash}」是哪家。可以试试 cc、codex、cursor 或 gemini。`)
          return true
        }
        if (peerProviderId === providerId) {
          await reply(msg.chatId, `两边不能是同一家（你写的是 /${slashWord} + ${peerSlash}）。`)
          return true
        }
        // B2(spec §4):主提供方必须能委派出去,否则确认消息许诺的
        // delegate 工具在其会话里根本不存在(gemini 硬编码
        // delegateAvailable:false,cursor 无 delegate stdio 通道)。
        // Surface, don't paper over(RFC-05 §5)。
        if (!capabilitiesFor(providerId).supportsDelegation) {
          await reply(msg.chatId, `${displayName(providerId)} 不能当主答再叫别家帮忙，这个对话照旧。`)
          return true
        }
        const wiredPeer = defaultDelegatePeer(providerId)
        if (wiredPeer && peerProviderId !== wiredPeer) {
          const wiredSlash = wiredPeer === 'claude' ? 'cc' : wiredPeer
          await reply(
            msg.chatId,
            `${displayName(providerId)} 主答时只能请 ${displayName(wiredPeer)} 帮忙，不能请 ${displayName(peerProviderId)}。可以发「/${slashWord} + ${wiredSlash}」。`,
          )
          return true
        }
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'primary_tool', primary: providerId })
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          const missing = /^unknown primary provider: (.+)$/.exec(detail)?.[1]
            ?? /^mode 'primary_tool' requires both providers .+; missing: (.+)$/.exec(detail)?.[1]
          const reason = missing ? `还没接上 ${missing.split(', ').map(displayName).join('、')}。` : detail
          await reply(msg.chatId, `/${slashWord} + ${peerSlash} 启用失败：${reason}`)
          return true
        }
        const primaryDn = namesIn(deps.registry, providerId).short
        const peerDn = namesIn(deps.registry, peerProviderId).short
        await reply(
          msg.chatId,
          `已切换：${primaryDn} 来答，需要时叫 ${peerDn} 帮忙。${peerDn} 每次只看这次交给它的问题。`,
        )
        deps.log('MODE_CMD', `chat=${msg.chatId} → primary_tool primary=${providerId} peer=${peerProviderId}`)
        return true
      }
      // /api <model> / /agy <model> — for openai and agy ONLY, a
      // non-"+peer" tail is interpreted as a model id: switch this chat to
      // solo+<provider> AND pin the model in one command (e.g. `/api
      // DeepSeek`, `/agy gemini-3.7-flash-high`). Deliberately NOT
      // extended to claude/codex/cursor/gemini — their tail keeps meaning
      // "unsupported argument" below, unchanged.
      // /api list · /api alias ds=DeepSeek · /api unalias ds — the openai
      // provider fronts a whole gateway of models the owner can't be expected
      // to memorise (their key sheet changes weekly); ask the gateway, and let
      // them name the ones they use.
      if (providerId === 'openai') {
        const sub = /^(list|alias|unalias)(?:\s+(.*))?$/i.exec(tail)
        if (sub) {
          const verb = sub[1]!.toLowerCase()
          const rest = sub[2]?.trim() ?? ''
          if (verb === 'list') {
            await reply(msg.chatId, await renderApiList(msg.chatId))
            return true
          }
          // 别名是全局配置(每个对话的 /api <短名> 都按它解析):和 /set provider 一样仅管理员可改(2026-10-10 评审)。
          if (!(deps.isAdmin?.(msg.userId ?? msg.chatId) ?? false)) { await reply(msg.chatId, '/api alias / unalias 是全局设置,仅管理员可改。/api list 和 /api <模型名> 照常可用。'); return true }
          if (!deps.setOpenaiAlias) { await reply(msg.chatId, '别名功能未接线。'); return true }
          if (verb === 'unalias') {
            const aliases = deps.readConfig?.().openaiAliases ?? {}
            if (!rest || !(rest in aliases)) { await reply(msg.chatId, `没有叫 \`${rest || '(空)'}\` 的别名。现有:${Object.keys(aliases).join(', ') || '无'}`); return true }
            await deps.setOpenaiAlias(rest, null)
            await reply(msg.chatId, `别名 \`${rest}\` 已删。`)
            deps.log('MODE_CMD', `chat=${msg.chatId} /api unalias ${rest}`)
            return true
          }
          // alias  a=b | a = b | a b
          const am = /^([A-Za-z0-9._-]{1,32})\s*(?:=|\s)\s*([A-Za-z0-9._/-]+)$/.exec(rest)
          if (!am) { await reply(msg.chatId, '用法:/api alias <短名>=<网关模型名>,例如 /api alias ds=DeepSeek'); return true }
          const [, alias, target] = am as unknown as [string, string, string]
          if (/^(list|alias|unalias)$/i.test(alias)) { await reply(msg.chatId, `\`${alias}\` 是子命令,不能当别名。`); return true }
          await deps.setOpenaiAlias(alias, target)
          await reply(msg.chatId, `别名 \`${alias}\` → \`${target}\`。以后 /api ${alias} 就行。`)
          deps.log('MODE_CMD', `chat=${msg.chatId} /api alias ${alias}=${target}`)
          return true
        }
      }
      if (providerId === 'openai' || providerId === 'agy') {
        // Liberal on charset (letters/digits/./_/-//), just no whitespace —
        // real model ids vary wildly across OpenAI-compatible backends
        // (DeepSeek/Kimi/Qwen/OpenRouter/…) and some are bare names with no
        // version digit (e.g. `Kimi`, `DeepSeek`), unlike the digit-required
        // guard on /v1/model (claude/codex/cursor ids always carry a
        // version digit; these don't).
        const modelRe = /^[A-Za-z0-9._/-]+$/
        if (!modelRe.test(tail)) {
          await reply(msg.chatId, `无效的模型名 \`${tail}\`（只支持字母/数字/. _ / - /，不能有空格）。`)
          return true
        }
        if (!deps.registry.has(providerId)) {
          await reply(msg.chatId, notConnected(providerId))
          return true
        }
        // 别名先解(只对 openai):ds → DeepSeek。解不到再问网关:名字在网关列表里才切,
        // 不在就拒绝并给近似项 —— 2026-09-10 主人手滑 `/api jimi`,原样透传把对话钉到了
        // 一个不存在的模型,要到下一条消息报错才知道。大小写不同(Kimi vs KIMI)按网关的
        // 拼法归一。网关列表拿不到(没接线 / 超时)时才退回原样透传,并在回复里说明没核对。
        const aliased = providerId === 'openai' ? deps.readConfig?.().openaiAliases?.[tail] : undefined
        let model = aliased ?? tail
        let unverified = false
        if (providerId === 'openai' && !aliased) {
          const r = await resolveOpenaiModel(tail)
          if (r.kind === 'unknown') {
            await reply(msg.chatId, `网关上没有 \`${tail}\`${r.suggestions.length ? `,你是不是想说:${r.suggestions.map(s => `\`${s}\``).join(' / ')}` : ''}。看全部:/api list`)
            return true
          }
          if (r.kind === 'ok') model = r.model
          else unverified = true
        }
        // 按对话钉(Mode.solo.model),不再改全局 agent-config —— 这个群
        // 钉 DeepSeek 不该把别的群也换了。全局默认走 /set / 设置面板。
        deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: providerId, model })
        const dn = namesIn(deps.registry, providerId).short
        const shown = aliased ? `${model}（别名 ${tail}）` : model !== tail ? `${model}（按网关拼法，你输的是 ${tail}）` : model
        const notice = noAskNotice(providerId, deps.resolveTier(msg.chatId))
        await reply(msg.chatId, `这个对话从下一条消息开始只由 ${dn} 来答，模型用 ${shown}（只对这个对话）。${unverified ? '（网关列表拿不到，没核对这个名字。下条消息报错就换一个。）' : ''}${notice ? `\n${chinesePunctuation(notice)}` : ''}`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → solo+${providerId} model=${model}`)
        return true
      }
      await reply(msg.chatId, `\`/${slashWord}\` 不支持参数 \`${tail}\`。试试 \`/${slashWord}\`、\`/${slashWord} + ${providerId === 'claude' ? 'codex' : 'cc'}\`、\`/solo\` 或 \`/mode\`。`)
      return true
      return false
    } },
  // /set — per-chat preferences (the settings layer's dials: split, care).
    { id: 'set', words: ['set'], match: (w) => w.toLowerCase() === 'set', run: async (msg, slashWord, tail) => {
      const SET_USAGE = [
        '不认识这个设置。可以这样改：',
        '· /set split on|off —— 拆分回复（也可以说「拆分 开」「拆分 关」）',
        '· /set care off|low|high —— 主动关心的频率（也可以说「关心 关」「关心 低」「关心 高」）',
        '· /set stickers on|off —— 表情包（也可以说「表情 开」「表情 关」）',
        '· /set hunt on|off —— 每日打猎（也可以说「打猎 开」「打猎 关」）',
        '· /set visit on|off —— 每日串门（也可以说「串门 开」「串门 关」）',
        '· /set avoid <话题> —— CC 不主动提的话题。可选健康、家人、钱、工作、感情、外貌。多个话题用顿号隔开，比如「/set 别聊 健康、家人」。发「/set 别聊 无」清空。',
        '· /set quiet 23:00-8:00|off —— 免打扰（也可用 /set 免打扰）。这段时间 CC 不主动找你，早报和周报会跳过。提醒和你自己建的定时照常。',
        '· /set cheap auto|claude|agy|openai|… —— 选 CC 在后台帮你做判断时用哪家（管理员）',
        '· /set providers claude,openai|all —— 选别人（非管理员）能用哪几家（管理员）',
        '· /set provider cc|agy|api|… —— 选默认由谁来答（管理员），换完要重启 CC',
      ].join('\n')
      const p = deps.chatPrefs.get(msg.chatId)
      if (tail === '') {
        const splitState = p.split === false ? 'off' : 'on'
        const careState = p.care ?? '未设置'
        const stickersState = p.stickers === undefined ? '未设置' : (p.stickers ? 'on' : 'off')
        const huntState = p.hunt === undefined ? '未设置（默认关）' : (p.hunt ? 'on' : 'off')
        const visitState = p.visit === undefined ? '未设置' : (p.visit ? 'on' : 'off')
        // Concise overview (owner feedback 2026-08-25: 回复应该更简洁,具体
        // 修改到页面里) — values only; the panel link is where changes
        // happen. The verbose per-key usage only appears when NO panel
        // link is available (non-admin, no LAN, panel unwired).
        let panelLine = ''
        if (deps.isAdmin?.(msg.userId ?? msg.chatId) && deps.settingsPanelLink) {
          try {
            const url = await deps.settingsPanelLink()
            if (url) panelLine = `\n\n点开修改（10 分钟内有效）：\n${url}`
          } catch { /* fall through to usage lines */ }
        }
        const adminHere = deps.isAdmin?.(msg.userId ?? msg.chatId) ?? false
        const cfg = adminHere ? deps.readConfig?.() : undefined
        const global = cfg ? [
          '',
          `· 默认由谁来答（所有对话）：${displayName(deps.defaultProviderId)}`,
          `· 后台判断用哪家（所有对话）：${cfg.cheapEvalProvider ? displayName(cfg.cheapEvalProvider) : '自动选'}`,
          `· 别人（非管理员）能用哪几家（所有对话）：${cfg.trusted_providers ? cfg.trusted_providers.map(displayName).join('、') || '无' : '全部'}`,
        ].join('\n') : ''
        const avoidState = p.avoid?.length ? topicLabels(p.avoid) : '无'
        const values = `本对话设置：\n· 拆分回复：${splitState}\n· 主动关心：${careState}\n· 表情包：${stickersState}\n· 每日打猎：${huntState}\n· 每日串门：${visitState}\n· 别主动聊：${avoidState}\n· 免打扰：${quietLabel(p.quiet)}${global}`
        const usage = panelLine ? '' : '\n\n改法：/set split|care|stickers|hunt|visit <值>（例如「拆分 开」或「关心 低」），还可以发「/set 别聊 健康、家人」。「/set 别聊 无」可清空。'
        await reply(msg.chatId, values + panelLine + usage)
        return true
      }
      const m2 = /^(split|拆分|care|关心|stickers|表情|hunt|打猎|visit|串门|avoid|别聊|quiet|免打扰|cheap|providers|provider|默认)\s+(\S+)$/i.exec(tail)
      if (!m2) {
        await reply(msg.chatId, SET_USAGE)
        return true
      }
      const key = m2[1]!.toLowerCase()
      const rawValue = m2[2]!

      // /set cheap — global (agent-config), admin only: which provider runs
      // the background one-shot evals. Not a chat pref; lives here because
      // /set is where the owner already goes to「调档位」.
      // /set provider agy — 全局默认 provider(管理员)。开机捕获的,写完自己重启。
      if (key === 'provider' || key === '默认') {
        if (!(deps.isAdmin?.(msg.userId ?? msg.chatId) ?? false)) { await reply(msg.chatId, '默认由谁来答是所有对话共用的设置，仅管理员可改。'); return true }
        if (!deps.setConfig) { await reply(msg.chatId, '现在还不能在微信里改这个设置。'); return true }
        const target = rawValue.toLowerCase() === 'cc' ? 'claude' : rawValue.toLowerCase() === 'api' ? 'openai' : rawValue.toLowerCase()
        if (!deps.registry.has(target)) { await reply(msg.chatId, notConnected(target)); return true }
        if (target === deps.defaultProviderId) { await reply(msg.chatId, `默认已经由 ${displayName(target)} 来答了。`); return true }
        const r = await deps.setConfig('provider', target)
        if (!r.ok) { await reply(msg.chatId, `没改成：${chinesePunctuation(r.detail ?? r.error)}`); return true }
        const dn = namesIn(deps.registry, target).short
        if (deps.requestRestart) {
          await reply(msg.chatId, `默认改由 ${dn} 来答。CC 会重启一下（十几秒），回来就生效。只想换这个对话，可以发 /cc、/api 或 /agy。`)
          deps.log('MODE_CMD', `chat=${msg.chatId} /set provider=${target} → restart`)
          deps.requestRestart('provider-change')
        } else {
          await reply(msg.chatId, `已保存，默认改由 ${dn} 来答。要重启 CC 才生效。`)
        }
        return true
      }

      // /set providers claude,openai | all — 非管理员对话可用的 provider(全局,管理员)
      if (key === 'providers') {
        if (!(deps.isAdmin?.(msg.userId ?? msg.chatId) ?? false)) { await reply(msg.chatId, '别人能用哪几家是所有对话共用的设置，仅管理员可改。'); return true }
        if (!deps.setConfig) { await reply(msg.chatId, '现在还不能在微信里改这个设置。'); return true }
        const r = await deps.setConfig('trusted_providers', rawValue)
        if (!r.ok) {
          const detail = r.error === 'invalid_value'
            ? '用英文逗号隔开各家的名字，比如「/set providers claude,openai」。要开放全部，发「/set providers all」。'
            : chinesePunctuation(r.detail ?? r.error)
          await reply(msg.chatId, `没改成：${detail}`)
          return true
        }
        const now = deps.readConfig?.().trusted_providers
        await reply(msg.chatId, now
          ? `别人（非管理员）现在只能用：${now.map(displayName).join('、') || '无'}。马上生效。访客仍不能用 /agy。`
          : '别人（非管理员）可以用所有已接上的服务。访客仍不能用 /agy。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set providers=${rawValue}`)
        return true
      }

      if (key === 'cheap') {
        if (!(deps.isAdmin?.(msg.userId ?? msg.chatId) ?? false)) { await reply(msg.chatId, '后台判断用哪家是所有对话共用的设置，仅管理员可改。'); return true }
        if (!deps.setConfig) { await reply(msg.chatId, '现在还不能在微信里改这个设置。'); return true }
        const r = await deps.setConfig('cheap_eval_provider', rawValue.toLowerCase())
        if (!r.ok) { await reply(msg.chatId, `没改成：${chinesePunctuation(r.detail ?? r.error)}`); return true }
        await reply(msg.chatId, rawValue.toLowerCase() === 'auto'
          ? `后台判断改回自动选。CC 会先试 API、Gemini（账号连接）、Claude、Codex、Gemini（密钥连接），按这个顺序选第一家接得上的。下次判断就生效。`
          : `后台判断改用 ${displayName(rawValue.toLowerCase())}（比如整理记忆、主持讨论、回顾之前做过的事）。下次判断就生效，不用重启。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} /set cheap=${rawValue.toLowerCase()}`)
        return true
      }

      if (key === 'split' || key === '拆分') {
        if (!/^(on|off|开|关)$/i.test(rawValue)) {
          await reply(msg.chatId, SET_USAGE)
          return true
        }
        const on = /^(on|开)$/i.test(rawValue)
        deps.chatPrefs.set(msg.chatId, { split: on })
        await reply(msg.chatId, on
          ? '拆分回复已开启——回复会像真人一样分几条发。'
          : '拆分回复已关闭——每次回复只发一条。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set split=${on}`)
        return true
      }

      if (key === 'stickers' || key === '表情') {
        if (!/^(on|off|开|关)$/i.test(rawValue)) {
          await reply(msg.chatId, SET_USAGE)
          return true
        }
        const on = /^(on|开)$/i.test(rawValue)
        deps.chatPrefs.set(msg.chatId, { stickers: on })
        await reply(msg.chatId, on
          ? '表情包已开启。'
          : '表情包已关闭。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set stickers=${on}`)
        return true
      }

      if (key === 'hunt' || key === '打猎') {
        if (!/^(on|off|开|关)$/i.test(rawValue)) {
          await reply(msg.chatId, SET_USAGE)
          return true
        }
        const on = /^(on|开)$/i.test(rawValue)
        deps.chatPrefs.set(msg.chatId, { hunt: on })
        await reply(msg.chatId, on
          ? '每日打猎已开启。'
          : '每日打猎已关闭。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set hunt=${on}`)
        return true
      }

      if (key === 'quiet' || key === '免打扰') {
        const r = parseQuietHours(rawValue)
        if (!r.ok) { await reply(msg.chatId, r.error); return true }
        deps.chatPrefs.set(msg.chatId, { quiet: r.window ?? undefined })
        // 跟 SpeechPolicy 的判定对得上(第三批 3a):CC 自己挑内容的推后 / 跳过(早报、周报到点赶上就当天跳过),
        // 主人点名要的(提醒、自己建的定时)和等你拍板的照常。撞上的早报 / 周报当场说,别让主人过几天才从列表里发现。
        const hit = r.window ? (deps.initiativeJobTimes?.() ?? []).filter(j => hhmmInQuiet(j.at, r.window!)) : []
        const clash = hit.length ? `\n注意:你的${hit.map(j => `${j.label}(${j.at})`).join('、')}落在这段里,到点会跳过,不会晚点补。想让它照常来,换个时间,或者改免打扰。` : ''
        await reply(msg.chatId, r.window ? `记下了:每天 ${quietLabel(r.window)} 我不主动找你(问候、打猎、串门、信、早报、周报都等到之后或当天跳过)。你设的提醒、你自己建的定时、等你批准的和一起做的通知照常。${clash}` : '免打扰关了。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set quiet=${r.window ? quietLabel(r.window) : 'off'}`)
        return true
      }

      if (key === 'avoid' || key === '别聊') {
        const r = parseAvoidTopics(rawValue)
        if (!r.ok) { await reply(msg.chatId, r.error); return true }
        deps.chatPrefs.set(msg.chatId, { avoid: r.topics })
        await reply(msg.chatId, r.topics.length ? `记下了:我不主动提${topicLabels(r.topics)}。你自己聊起时照常。` : '清空了:什么话题我都可以主动聊。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set avoid=${r.topics.join(',') || '-'}`)
        return true
      }

      if (key === 'visit' || key === '串门') {
        if (!/^(on|off|开|关)$/i.test(rawValue)) {
          await reply(msg.chatId, SET_USAGE)
          return true
        }
        const on = /^(on|开)$/i.test(rawValue)
        deps.chatPrefs.set(msg.chatId, { visit: on })
        // 社交不在时照存(主人可能是先设好、再去开社交),但别说成「已开启」就完了 —— 那等于说它会去串门,其实不会
        const social = on ? deps.socialState?.() : undefined
        await reply(msg.chatId, !on ? '每日串门已关闭。'
          : social === 'off' ? `记下了:每日串门开。不过${SOCIAL_OFF_LINE.replace(/。$/, '')},开了社交才会去串门。`
          : social === 'degraded' || social === 'pending' ? `记下了:每日串门开。不过${socialUnavailableLine(social)}`
          : '每日串门已开启。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set visit=${on}`)
        return true
      }

      // care | 关心 — 3-level dial (off/low/high). Deliberately NOT
      // on/off like split: "on"/"开" don't map to a level, so they fall
      // through to the usage error below.
      const CARE_VALUES: Record<string, 'off' | 'low' | 'high'> = {
        off: 'off', '关': 'off',
        low: 'low', '低': 'low',
        high: 'high', '高': 'high',
      }
      const careVal = CARE_VALUES[rawValue.toLowerCase()]
      if (!careVal) {
        await reply(msg.chatId, SET_USAGE)
        return true
      }
      deps.chatPrefs.set(msg.chatId, { care: careVal })
      const careConfirm = careVal === 'high'
        ? '主动关心已设为 high——会更主动地问候和关心。'
        : careVal === 'low'
          ? '主动关心已设为 low——偶尔主动问候。'
          : '主动关心已设为 off——不会主动找你。'
      await reply(msg.chatId, careConfirm)
      deps.log('MODE_CMD', `chat=${msg.chatId} /set care=${careVal}`)
      return true
      return false
    } },
  // /solo — revert to daemon default
    { id: 'solo', words: ['solo'], match: (w, tail) => w.toLowerCase() === 'solo' && tail === '', run: async (msg, slashWord, tail) => {
      // Setting the mode to the default IS the revert: persists default
      // explicitly so future daemon-config changes don't silently shift
      // the user's chat. (Alternative would be conversationStore.delete
      // but that exposes the daemon-default at a layer above the user.)
      deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: deps.defaultProviderId })
      await reply(msg.chatId, `这个对话回到默认，由 ${displayName(deps.defaultProviderId)} 来答。`)
      deps.log('MODE_CMD', `chat=${msg.chatId} → reset to default ${deps.defaultProviderId}`)
      return true
      return false
    } },
  // /mode — status
    { id: 'mode', words: ['mode'], match: (w, tail) => w.toLowerCase() === 'mode' && tail === '', run: async (msg, slashWord, tail) => {
      const cur = deps.coordinator.getMode(msg.chatId)
      const registered = deps.registry.list()
      const allowed = deps.readConfig?.().trusted_providers
      const lines = [
        `现在：${describeMode(cur)}`,
        `能用的：${registered.map(displayName).join('、') || '无'}`,
        `默认：${displayName(deps.defaultProviderId)}`,
        ...(registered.includes('agy')
          ? ['/agy 用的是订阅 CLI：所有对话共用一把钥匙，没法按对话分权限；访客不能用。'] : []),
        ...(allowed ? [`别人（非管理员）能用的：${allowed.map(displayName).join('、') || '无'}（管理员设的）`] : []),
        ...Object.entries(deps.providerNotes?.() ?? {}).map(([id, note]) =>
          `${displayName(id)}：${note && chinesePunctuation(note)}`),
        `换谁来答：${PROVIDER_IDS.map(id => `/${PROVIDER_SLASH[id]}`).join(' ')} /cc + codex /codex + cc　回到默认 /solo · 退出 /stop（几家一起讨论在桌面上开）`,
      ]
      await reply(msg.chatId, lines.join('\n'))
      return true
      return false
    } },
  // /both /parallel /chat:多模型讨论(并行 / 圆桌)不在微信里开 —— 主人 10-21 定:微信是聊天和简单做事,多 agent 交给软件。
  // 已经处在这两种模式里的对话照常;桌面的对话模式里照旧能选(set-mode 路由,协调器自己也守着 agy 不能加入)。
    { id: 'multi', words: ['both', 'parallel', 'chat'], match: (w) => ['both', 'parallel', 'chat'].includes(w.toLowerCase()), run: async (msg, slashWord, tail) => {
      await reply(msg.chatId, MULTI_MODEL_ON_DESKTOP)
      deps.log('MODE_CMD', `chat=${msg.chatId} /${slashWord.toLowerCase()} → told to use the desktop`)
      return true
      return false
    } },
  // /stop — exit chatroom (or any non-default mode), revert to default solo.
  // RFC 03 review #11: also signals any in-flight chatroom loop to
  // preempt at its next turn boundary (mid-turn cancel isn't
  // supported — neither SDK exposes a uniform AbortSignal).
    { id: 'stop', words: ['stop'], match: (w, tail) => w.toLowerCase() === 'stop' && tail === '', run: async (msg, slashWord, tail) => {
      const wasInFlight = deps.coordinator.cancel(msg.chatId)
      deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: deps.defaultProviderId })
      // Generic copy: coordinator.cancel() now also fires for solo/parallel
      // handle-cancels (post-cancel-review CRITICAL 1), not just chatroom's
      // preempt loop — a chatroom-specific message here would mislead solo
      // users into thinking they were in chatroom mode.
      const suffix = wasInFlight ? '正在回的那一轮已经叫它停了，可能还会收到一点已经在路上的话。' : ''
      await reply(msg.chatId, `已退出，回到默认，由 ${displayName(deps.defaultProviderId)} 来答。${suffix}`)
      deps.log('MODE_CMD', `chat=${msg.chatId} → /stop reset to default${wasInFlight ? ' + cancel in-flight' : ''}`)
      return true
      return false
    } },
  // /whoami — dump current identity + mode info
    { id: 'whoami', words: ['whoami'], match: (w, tail) => w.toLowerCase() === 'whoami' && tail === '', run: async (msg, slashWord, tail) => {
      const nick = deps.getUserName(msg.chatId)
      if (!nick) {
        await reply(msg.chatId, '你还没告诉我怎么称呼你。先发 `/name <昵称>` 设置一下。')
        return true
      }
      const trunc = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…` : s
      const cur = deps.coordinator.getMode(msg.chatId)
      const botNameStr = botName(cur, deps.agentConfig)
      const wxLine = msg.userName
        ? `WeChat: ${msg.userName} (${trunc(msg.userId, 12)})`
        : `WeChat: ${trunc(msg.userId, 12)}`
      const lines = [
        `你: ${nick}`,
        `   ${wxLine}`,
        `bot account: ${trunc(msg.accountId, 12)}`,
        `   当前回应: ${botNameStr} (${describeMode(cur)})`,
        `chat: ${trunc(msg.chatId, 12)}`,
      ]
      await reply(msg.chatId, lines.join('\n'))
      return true
      return false
    } },
  // /name <nick> — user renames themselves in this chat
    { id: 'name', words: ['name'], match: (w) => w.toLowerCase() === 'name', run: async (msg, slashWord, tail) => {
      if (!tail) {
        await reply(msg.chatId, '用法：/name <昵称>。例：/name 丸子')
        return true
      }
      // Validate before persisting — same constraint onboarding + /botname
      // apply. Without this, any chat user could store an unbounded / hostile
      // nickname that later gets interpolated into prompts.
      const nickErr = validateNickname(tail)
      if (nickErr === 'too_long') {
        await reply(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。`)
        return true
      }
      if (nickErr === 'bad_charset') {
        await reply(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。')
        return true
      }
      await deps.setUserName(msg.chatId, tail)
      await reply(msg.chatId, `好的，以后叫你 ${tail}。`)
      deps.log('MODE_CMD', `chat=${msg.chatId} → setUserName "${tail}"`)
      return true
      return false
    } },
  // /help — user-facing command reference (/帮助 alias handled above COMMAND_REGEX)
    { id: 'help', words: ['help'], match: (w, tail) => w.toLowerCase() === 'help' && tail === '', run: async (msg, slashWord, tail) => {
      return handleHelp(msg, deps.isAdmin?.(msg.userId) ?? false)
      return false
    } },
  ]
  /** 本文件认的全部斜杠词,从上面这张表推出来(以前是手写的 KNOWN_SLASH_COMMANDS)。 */
  const knownSlashWords = new Set(slashRows.flatMap(r => r.words.map(w => w.toLowerCase())))

  // A3 (spec §A3): unknown pure-slash command — a typo'd/half-remembered
  // command word, not conversation. Reply with a pointer to /help and
  // consume, instead of silently handing it to the LLM as prose (the F4
  // bug: `/health` typo'd as `/helth` used to become an odd LLM reply).
  // Runs LAST, after every known row (including admin-commands slash words
  // like /health — those sit earlier in the command table, so by the time an
  // unrecognised word reaches here nothing upstream claimed it).
  async function handleUnknown(msg: InboundMsg, slashWord: string): Promise<boolean> {
    const trimmedText = msg.text.trim()
    if (!UNKNOWN_SLASH_RE.test(trimmedText) || knownSlashWords.has(slashWord.toLowerCase())) return false
    await reply(msg.chatId, `不认识 ${trimmedText}。看全部命令发 /help。`)
    deps.log('MODE_CMD', `chat=${msg.chatId} → unknown slash command ${trimmedText}`)
    return true
  }

  return {
    probe(msg) { return msg.text.trim() === '/帮助' || COMMAND_REGEX.test(msg.text) },
    async handle(msg) {
      // /帮助 — Chinese alias for /help. Must be checked before COMMAND_REGEX
      // since the regex only matches ASCII slash-words.
      if (msg.text.trim() === '/帮助') {
        return handleHelp(msg, deps.isAdmin?.(msg.userId) ?? false)
      }

      const m = COMMAND_REGEX.exec(msg.text)
      if (!m) return false
      const slashWord = m[1]!
      const tail = m[2]?.trim() ?? ''

      for (const row of slashRows) {
        if (row.match(slashWord, tail) && await row.run(msg, slashWord, tail)) return true
      }

      // 不认识的纯斜杠词 ⇒ 回一句指向 /help(handleUnknown,A3)
      if (await handleUnknown(msg, slashWord)) return true

      // Not a mode command — let other handlers (admin-commands, onboarding,
      // coordinator) take it.
      return false
    },
    slashWords: () => [...knownSlashWords],
    commands() {
      // 命令表里一行一条(第三批 3d):mode.<行> 各认自己的 /词;mode.unknown 是认任何 /词的兜底(slashCatchAll),
      // 只做「不认识」那一句 —— 前面的行已经在表里试过了,兜底不再重试一遍。/帮助 是 help 那行的中文写法。
      const parse = (m: InboundMsg): { slashWord: string; tail: string } | null => {
        const x = COMMAND_REGEX.exec(m.text)
        return x ? { slashWord: x[1]!, tail: x[2]?.trim() ?? '' } : null
      }
      const isHelpAlias = (row: SlashRow, m: InboundMsg) => row.id === 'help' && m.text.trim() === '/帮助'
      return [
        ...slashRows.map((row): WechatCommand => ({
          id: `mode.${row.id}`,
          group: 'mode',
          probe: (m) => { if (isHelpAlias(row, m)) return true; const p = parse(m); return !!p && row.match(p.slashWord, p.tail) },
          handle: async (m) => {
            if (isHelpAlias(row, m)) return handleHelp(m, deps.isAdmin?.(m.userId) ?? false)
            const p = parse(m)
            return !!p && row.match(p.slashWord, p.tail) && row.run(m, p.slashWord, p.tail)
          },
        })),
        {
          id: 'mode.unknown',
          group: 'mode',
          slashCatchAll: true,
          probe: (m) => COMMAND_REGEX.test(m.text) && !isTaskHandoffCommand(m.text, taskHandoffNames(deps.registry, deps.readConfig?.())),
          handle: async (m) => { const p = parse(m); return !!p && handleUnknown(m, p.slashWord) },
        },
      ]
    },
  }
}
