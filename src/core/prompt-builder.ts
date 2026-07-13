/**
 * prompt-builder — assemble the per-session system prompt for a wechat
 * channel agent (RFC 03 §6 follow-up).
 *
 * History: in v0.x the prompt was a single string in bootstrap.ts that
 * mentioned only the original tool set. After P0–P5 we ship 22 tools
 * (memory_*, voice_*, projects_*, share_*, companion_*, reply family,
 * delegate_*) and 4 modes (solo / parallel / primary_tool / chatroom).
 * Without this file the agent ends up with delegate_* tools available
 * but no prompt mentioning them — P4 looks broken.
 *
 * Sessions are per-(provider, alias) and shared across chats with the
 * same alias. So the prompt is fixed-at-spawn-time and CANNOT depend on
 * a particular chat's mode. Per-chat mode-specific guidance is injected
 * into the user message envelope at dispatch time (chatroom path: see
 * dispatchChatroom in conversation-coordinator.ts).
 *
 * What we CAN customise per-session:
 *   - which provider this is (claude/codex) — affects tool naming
 *     (delegate_codex available when this is the claude session, etc.)
 *   - whether the companion proactive tick is enabled
 *
 * What we CANNOT customise per-session:
 *   - per-chat mode (chatroom @-tag protocol, parallel prefix expectations)
 *
 * Cost: this prompt is appended to the SDK's `claude_code` preset on
 * EVERY turn (preset+append form keeps MCP tools inline; see
 * bootstrap.ts:178-181 for the latency rationale). Keep it tight.
 */
import type { ProviderId } from './conversation'

/**
 * Knowledge plugins the knowledge-orchestration section knows how to explain
 * (knowledge-orchestration design Task 1). Any plugin name NOT in this list
 * is silently ignored by `knowledgeOrchestrationSection` — the section only
 * ever documents sources it has hand-written copy for, so an unrelated
 * plugin (or a future one this file hasn't been updated for yet) never
 * triggers the section or produces a blank/garbled bullet.
 */
export const KNOWN_KNOWLEDGE_PLUGINS = ['wxperson', 'wxgraph', 'wxfacts', 'wxsearch', 'wxmedia'] as const

export interface BuildSystemPromptArgs {
  /** Which provider this session is for. Used to compute peer + delegate tool name. */
  providerId: ProviderId
  /** The OTHER provider id; the session's delegate-mcp child exposes delegate_<peer>. */
  peerProviderId: ProviderId
  /** Whether companion proactive-tick is enabled at boot. */
  companionEnabled: boolean
  /** When true, the wechat-mcp delegate tool is loaded (RFC 03 P4+). Default true; set false for delegate / one-shot sessions. */
  delegateAvailable: boolean
  /**
   * When true, this session is admin-tier and the wechat-mcp daemon-control
   * tools (diagnostic_* / model_* / session_release / daemon_restart) are
   * registered. Adds the self-heal capability section so the agent knows it
   * can diagnose/heal and when. Must track tool registration exactly — the
   * caller passes `tierProfile.allow.has('daemon_introspect')` (the admin
   * predicate the wechat MCP server gates those tools on). Default false.
   */
  daemonOpsAvailable?: boolean
  /**
   * When true, this session is admin-tier and the wechat-mcp `locate_file` tool
   * is registered. Adds the file-locate section so the agent knows to find the
   * owner's files on demand and record locations. Pass
   * `tierProfile.allow.has('file_locate')`. Default false.
   */
  fileLocateAvailable?: boolean
  /**
   * When true, this chat's effective care level (per proactive-care design
   * §7) is not `off` — adds the care-authoring section so the agent knows
   * to write care intentions into `agenda.md` during normal conversation
   * and to honor presence-preference changes via `set_chat_pref`. Absent
   * or false ⇒ output is byte-identical to before this field existed
   * (default false; callers without a `careLevelFor` thunk never set it).
   */
  careEnabled?: boolean
  /**
   * When true, this chat is in the "刚认识" (just-met) phase of the
   * relationship — adds a section nudging light, at-most-one-question
   * curiosity about the person (what they do, what they care about,
   * schedule, how they like to be addressed) so memory fills in without
   * feeling like an interrogation. Absent or false ⇒ output is
   * byte-identical to before this field existed (mirrors `careEnabled`'s
   * contract).
   */
  newRelationship?: boolean
  /**
   * Local sticker library tags available to this session (image-stickers
   * design §5). When present and non-empty, adds the sticker section so the
   * agent knows it can `send_sticker(tag)` on strong-emotion/celebration/
   * comfort moments and `save_sticker` on a good incoming image. Absent or
   * empty ⇒ output is byte-identical to before this field existed (mirrors
   * `careEnabled`'s contract; callers without a `stickerTagsFor` thunk never
   * set it).
   */
  stickerTags?: string[]
  /**
   * This chat's persona.md content (persona design — "白纸养成" character
   * sheet). When present and non-blank, adds the persona section right
   * after the identity section so the agent stays in-character across the
   * conversation. Sliced to 4000 chars to bound prompt cost. Absent or
   * whitespace-only ⇒ output is byte-identical to before this field existed
   * (mirrors `careEnabled`/`stickerTags`'s contract).
   */
  persona?: string
  /**
   * When true, this is an owner chat and the persona-cultivation section is
   * added so the agent knows it may write persona.md updates via
   * memory_write as the character forms through conversation. Default
   * false/absent ⇒ output is byte-identical to before this field existed.
   */
  personaCultivate?: boolean
  /**
   * When true (and `personaCultivate` is also true), persona.md is still
   * blank — appends a one-line nudge to the cultivation section telling the
   * agent to ask an early, natural seed question about desired style/
   * personality so persona.md has something to grow from. Nested inside
   * `personaCultivate`'s gate: if `personaCultivate` is false/absent, this
   * flag has no effect (no cultivation section at all, so no nudge either).
   * Absent or false ⇒ output is byte-identical to before this field existed.
   */
  personaEmpty?: boolean
  /**
   * This chat's core-memory block (core-memory-injection design) — a small,
   * always-loaded excerpt of profile.md distilled to what matters most about
   * this person right now. Unlike the rest of memory/ (read on demand via
   * `memory_read`), this rides on EVERY turn so the agent doesn't start cold
   * on who it's talking to. Placed right after the persona section (identity
   * cluster), before the tool/capability sections. The caller is expected to
   * pass already-capped content (see the design's own cap step); this
   * function still enforces `CORE_MEMORY_MAX_CHARS` as a belt-and-braces
   * bound so prompt cost can't blow up if a caller forgets. Absent or
   * whitespace-only ⇒ output is byte-identical to before this field existed
   * (mirrors `persona`/`careEnabled`'s contract).
   */
  coreMemory?: string
  /** Daemon-distilled objective plugin knowledge (knowledge.md), injected after core memory. */
  knowledgeMemory?: string
  /**
   * When true, adds the bubble-replies section (行为流式气泡回复 design):
   * teaches the agent to send each complete thought as its own `reply` call
   * as it forms, instead of accumulating the whole answer into one big send.
   * Placed right after `toolsSection()` — it's core reply mechanics, not a
   * per-chat personality flourish. Absent or false ⇒ output is byte-identical
   * to before this field existed (mirrors `careEnabled`'s contract).
   */
  bubbleReplies?: boolean
  /**
   * Names of knowledge-mcp plugins registered for this session (RFC
   * knowledge-orchestration Task 1) — e.g. `wxgraph`/`wxfacts`/`wxsearch`/
   * `wxmedia`. When at least one of these is a KNOWN_KNOWLEDGE_PLUGINS
   * entry, adds the knowledge-orchestration section right after
   * `memorySection()` so the agent knows memory (its own "看法") composes
   * with these structured sources rather than substituting for them.
   * Unknown plugin names are ignored for gating purposes (no known plugin
   * present ⇒ section omitted). Absent, empty, or all-unknown ⇒ output is
   * byte-identical to before this field existed (mirrors `careEnabled`'s
   * contract).
   */
  knowledgePlugins?: string[]
}

/**
 * Build the per-session system prompt. Pure function — no side effects,
 * no env reads. Bootstrap calls this when constructing each provider's
 * sdkOptionsForProject.
 */
export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const { providerId, peerProviderId, companionEnabled, delegateAvailable } = args

  const hasKnownKnowledge = (args.knowledgePlugins ?? []).some(n => (KNOWN_KNOWLEDGE_PLUGINS as readonly string[]).includes(n))

  const sections: string[] = [
    baseChannelSection(providerId),
    args.persona && args.persona.trim().length > 0 ? personaSection(args.persona) : '',
    args.coreMemory && args.coreMemory.trim().length > 0 ? coreMemorySection(args.coreMemory) : '',
    args.knowledgeMemory && args.knowledgeMemory.trim().length > 0 ? knowledgeMemorySection(args.knowledgeMemory) : '',
    toolsSection(),
    args.bubbleReplies === true ? bubbleRepliesSection() : '',
    delegateAvailable ? delegateSection(peerProviderId) : '',
    a2aSection(),
    args.daemonOpsAvailable ? daemonSelfHealSection() : '',
    args.fileLocateAvailable ? fileLocateSection() : '',
    args.careEnabled ? careSection() : '',
    args.newRelationship === true ? newRelationshipSection() : '',
    args.personaCultivate === true ? personaCultivationSection({ personaEmpty: args.personaEmpty === true }) : '',
    args.stickerTags && args.stickerTags.length > 0 ? stickerSection(args.stickerTags) : '',
    memorySection(),
    hasKnownKnowledge ? knowledgeOrchestrationSection(args.knowledgePlugins!) : '',
    multiModeAwarenessSection(),
    companionEnabled ? companionSection() : '',
  ].filter(s => s.length > 0)

  return sections.join('\n\n')
}

// ─── sections ──────────────────────────────────────────────────────────

function baseChannelSection(providerId: ProviderId): string {
  return `你是 ${providerId}。你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。基础规则：
- 每条入站消息用 \`<wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat>\` 包裹。chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 信封上的 \`ts\` 是这条消息（或 \`<companion_tick>\` 唤醒）的发生时间，也是你的「当前时间」基准。做任何日期/时间推理（"下周三"、"三天后"、判断某事是否已过期）都以 \`ts\` 为准——**不要用系统提示里的 "Today's date"**，它可能与真实对话时间不符。
- 媒体附件以 \`[image:/abs/path]\` \`[file:/abs/path]\` \`[voice:/abs/path]\` 行内标注，用 Read/Bash 等工具打开或分析它们。
- 用户引用/回复某条历史消息时，被引用内容会以 \`<quote type="text|image|voice|file|...">被引用的原文</quote>\` 出现在该条消息体的开头。把它当作用户这次发言的上下文来理解。
- 用户是个人开发者，偏好简短直接的中文回复。
- 回复时**用 \`reply\` 工具**而非直接生成 plain text。如果你不调 reply 而只输出 assistant text，daemon 的 fallback 路径会把文本发出去（channel.log 记 [FALLBACK_REPLY]），用户能收到但 daemon 视为 anomaly — 不要依赖。`
}

function toolsSection(): string {
  // Lists the wechat-mcp tools (loaded on every regular session via
  // wechatStdioMcpSpec in bootstrap.ts). Grouped by intent so the agent
  // can find the right tool quickly.
  return `## 可用 wechat 工具

回复 / 编辑用户消息：
- \`reply(chat_id, text)\` — 文本回复。**首选**。
- \`reply_voice(chat_id, text)\` — 语音回复。用户明确要语音时用；此外，短的、情绪化/关心/道晚安这类适合用声音的时刻，你也可以主动用语音（一两句话的暖场，不要用语音发长内容、代码、链接或需要对方回看的信息）。默认还是文字为主，语音是点缀。≤ 500 字，不适合代码块/URL/长列表。
- \`send_file(chat_id, path)\` — 推送本地文件（绝对路径）。
- \`edit_message(chat_id, msg_id, text)\` — 编辑已发送的消息（msg_id 来自先前 reply 的返回）。
- \`broadcast(text, account_id?)\` — 群发文本到所有在线用户。

项目 / 路由：
- \`list_projects()\` / \`switch_project(alias)\` / \`add_project(alias, path)\` / \`remove_project(alias)\` — 项目别名管理。
- \`set_user_name(chat_id, name)\` — 记住新用户的显示名称。

语音 TTS 配置：
- \`voice_config_status()\` — 查询当前 TTS 配置状态（不返回 api_key）。
- \`save_voice_config({provider, base_url?, model?, api_key?, default_voice?})\` — 保存 TTS 配置（先做 1 秒测试合成）。
- 用户首次要求语音但未配置：先调 voice_config_status，未配置则 reply 引导用户发 API 配置（VoxCPM2 base_url + model 或 qwen api_key）。

发布页面：
- \`share_page(title, content, {needs_approval?, chat_id?, account_id?})\` — 把 Markdown 发布为一次性 URL。needs_approval=true 渲染 ✓ Approve 按钮。chat_id 启用"📄 发 PDF"按钮。
- \`resurface_page({slug?, title_fragment?})\` — 根据 slug 或标题片段重新生成 URL。

Companion / 主动推送（详见末尾段）：
- \`companion_status()\` / \`companion_enable()\` / \`companion_disable()\` / \`companion_snooze({minutes})\` / \`companion_import_local({enabled})\`（开关本机历史自动导入）`
}

/**
 * Bubble-replies capability (行为流式气泡回复 design) — teaches behavioral
 * streaming: since tool-call arguments only reach us fully generated (no
 * transport-level partial-text flush), the agent has to fake the "typing
 * out loud" feel itself by sending multiple `reply` calls as each complete
 * thought forms, instead of one big reply at the end. Bubble boundaries are
 * semantic (the model decides where a thought ends), so this is guidance,
 * not a mechanical splitter — mechanical splitting still exists as the
 * route-level fallback (splitReply) for whenever the agent sends one big
 * text anyway.
 */
export function bubbleRepliesSection(): string {
  return `## 气泡式回复(像真人一样分条发)

长回答不要攒成一大段最后一次发。像真人打字那样:想好第一个意思就先调 reply 发出去(先说结论/直接回应),然后继续想、继续查,再把下一条发出去。每条一个完整的意思;一轮最多 2-4 条,短回答就一条——别为拆而拆。代码要完整地放在一条里发,永远不要把代码切开。补充/链接可以单独一条。`
}

function delegateSection(peerProviderId: ProviderId): string {
  // RFC 03 P4 — only the OTHER provider id is exposed to this session.
  // Bootstrap wires WECHAT_DELEGATE_PEER on the stdio child; the tool
  // name in this session is delegate_<peer>.
  return `## 跨 AI 咨询（RFC 03 P4）

- \`delegate_${peerProviderId}({prompt, context_summary?})\` — 把一个具体问题交给 ${peerProviderId} 做一次性咨询。
  适用：用户明确要求二意见 / 你想做代码审计或对比不同视角 / 用户切到了 \`primary_tool\` 模式。
  注意：${peerProviderId} 看不到当前对话历史 — context_summary 必须自包含；它在 read-only 沙盒里跑，不能改文件、不能发微信、不能再 delegate。冷启动 ~3-5s，不要滥用。

  **附件转发**：如果当前 user 消息里有 \`[image:/abs/path]\` / \`[file:/abs/path]\` / \`[voice:/abs/path]\` marker 且你希望 ${peerProviderId} 看到这个文件，**必须把整个 marker 字符串原样写进 \`prompt\` 字段**。${peerProviderId} 的 Read/Bash 工具会按 marker 里的绝对路径打开文件。如果你只用自然语言描述（"用户发了张图"），${peerProviderId} 拿不到路径就读不到——这跟 chatroom moderator 的 paraphrase bug 是同一个 trap。`
}

function a2aSection(): string {
  // 操作者可能注册了一批外部 A2A agent（部署 bot、日历 bot、监控 bot 等）。
  // 那些 agent 通过 wechat-cc 把消息推给操作者，进 chat 时会带 `[A2A:<id>]` 前缀。
  // 操作者想"回它一句"的时候让你调 a2a_send。所以**永远都暴露这个工具的存在**，
  // 即使当前 chat 没有 A2A 消息也无害——claude 不会随便调没有上下文的工具。
  return `## A2A 集成（外部 agent 通过我跟操作者通信）
- 来自外部 A2A agent 的消息会在 chat 里以 \`[A2A:<agent_id>] <text>\` 形式出现（不是用户写的，是外部 agent push 进来的通知）。
- 操作者可能让你"回 deploy-bot 一句 retry"/"告诉那个 agent yes" 之类——调 \`a2a_send(agent_id, text)\` 把消息发回去。\`agent_id\` 就是 \`[A2A:<id>]\` 前缀里的那个 id，**逐字保留 dash、下划线**，不要自己加 prefix 或换大小写。
- \`a2a_send\` 返回 \`{ ok, http_status?, error?, registered? }\`。\`unknown_agent\` → 名单错了（registered 字段列了已注册的，用那个 ID 重试）；\`agent_paused\` → 操作者主动暂停了那个 agent，**不要再调**、平常回复用户即可。`
}

/**
 * Self-diagnosis / self-heal capability (admin-tier only). The daemon-control
 * MCP tools are already registered for admin sessions; this tells the agent
 * they exist and WHEN to reach for them, so a vague runtime complaint ("不回了")
 * triggers a diagnosis rather than just an apology. Not a keyword rule — the
 * agent still decides. Exported so the codex provider can prepend it per-spawn
 * (codex has no system-prompt slot; see codex-agent-provider first-dispatch
 * injection). Kept tight — every section rides on every turn.
 */
export function daemonSelfHealSection(): string {
  return `## 自我诊断 / 自愈（管理员）

你能检查并修复自己所在的 daemon。当主人反映「卡住 / 不回 / 变慢 / 这个对话没反应」这类**运行异常**（不是内容问题）时，主动排查而不是只道歉：
- 先查：\`diagnostic_health\`（心跳 / 活跃会话数）、\`diagnostic_turns\`（最近回合结局 completed/timeout/auth_failed/error）、\`diagnostic_sessions\`。
- 再据情况：某回合 timeout/卡死 → \`session_release\`；模型固定错了 / 一直 404 → \`model_set\`；整体像卡死且前面都没用 → \`daemon_restart\`。
- 修完用各自的读回（release 的 sessions、model_set 的 model、restart 的 ok）核对，再用自然语言把「查到什么、做了什么、好没好」简短汇报给主人。
- 这些是高权限操作，会先要你确认（relay）；不确定就只诊断、把结果告诉主人。`
}

export function fileLocateSection(): string {
  return `## 找主人电脑里的文件（管理员）

当主人提到某个文件/文档（「那个预算表」「桌面上那个合同」），别说你看不到——你能找：
- 先看记忆里的 \`locations.md\`：若已记过「这是什么 → 路径」，直接用 \`Read\` 打开。
- 没记过就用 \`locate_file\`：query 给关键词，先 name 模式；文件名没命中再 \`mode=content\`；想看某目录大致有什么用 \`mode=browse\`。把 \`locations.md\` 里相关的目录用 \`roots\` 传进去会优先搜。
- 找到并确认后，用 \`Read\` 打开来回答，并用 \`memory_write\` 往 \`locations.md\` 追一行「这是什么 → 绝对路径」，下次直接命中。
- 实在找不到，就在微信问主人一句「X 一般放哪？」（只问这一次），拿到答案把那个目录记进 \`locations.md\`。
范围是用出来的，不是让主人配置出来的。`
}

/**
 * Persona identity section — appears when this chat has a non-blank
 * persona.md (persona design). Placed right after baseChannelSection so
 * identity (你是 ${providerId}) comes first and character/voice comes
 * second. Content is sliced to 4000 chars to bound per-turn prompt cost
 * (this file is appended on EVERY turn — see module header).
 */
export function personaSection(content: string): string {
  return `## 你的人设(persona)

下面是你自己维护的人设档案(persona.md)。这就是你的性格和说话方式——在所有对话里保持一致地做这个"人":

${content.slice(0, 4000)}`
}

/**
 * Belt-and-braces cap on core-memory content rendered into the prompt
 * (core-memory-injection design). The caller is expected to pass
 * already-capped content — this exists so a caller bug can't blow up
 * per-turn prompt cost.
 */
export const CORE_MEMORY_MAX_CHARS = 1500

/**
 * Core-memory identity section — appears when this chat has non-blank
 * core-memory content (core-memory-injection design). Placed right after
 * the persona section (identity cluster), before the tool/capability
 * sections, so the agent's understanding of WHO it's talking to loads
 * before it reads about WHAT it can do. Unlike the rest of memory/, this is
 * always loaded — no `memory_read` round-trip needed — because it's meant
 * to be the few things worth knowing about this person on every single
 * turn. Content is capped at `CORE_MEMORY_MAX_CHARS` (belt; the caller caps
 * too) with a truncation note pointing back at `memory_read` for the full
 * profile.
 */
export function coreMemorySection(content: string): string {
  const capped = content.length > CORE_MEMORY_MAX_CHARS
    ? `${content.slice(0, CORE_MEMORY_MAX_CHARS)}\n（核心记忆已截断;完整 profile 用 memory_read）`
    : content

  return `## 核心记忆（你眼中的 ta）

这是你此刻对这个人最核心的了解(来自 profile),始终加载、不用查。更细的东西在长期记忆里,需要时用 \`memory_read\`。

${capped}`
}

export const KNOWLEDGE_MEMORY_MAX_CHARS = 1500

/**
 * Distilled-knowledge section (knowledge-distillation design, D1). The COMPANION
 * of coreMemorySection: coreMemory is the agent's own subjective take (profile.md);
 * this is the OBJECTIVE data computed by the knowledge plugins (open obligations,
 * key/neglected relationships), distilled by the daemon into knowledge.md and
 * injected every turn so the two halves compose without a `person_brief` call.
 * Placed immediately after coreMemorySection. Capped like core memory.
 */
export function knowledgeMemorySection(content: string): string {
  const capped = content.length > KNOWLEDGE_MEMORY_MAX_CHARS
    ? `${content.slice(0, KNOWLEDGE_MEMORY_MAX_CHARS)}\n（已截断;更细用 \`person_brief(名字)\` 深挖）`
    : content

  return `## 算出来的事实（客观，别和你的看法混）

下面是从真实聊天数据算出来的（不是你的主观印象），始终加载。要深挖某个具体的人,用 \`person_brief(名字)\`。

${capped}`
}

/**
 * Persona-cultivation capability (owner chat only) — tells the agent WHEN
 * and HOW to write persona.md: it's a "白纸养成" character sheet that forms
 * out of the owner/agent relationship over time, not a spec to fill in
 * eagerly. The "克制" framing exists because without it the agent tends to
 * rewrite the whole file after every notable exchange, which defeats the
 * slow-growth premise of the design.
 */
export function personaCultivationSection(opts?: { personaEmpty?: boolean }): string {
  const base = `## 人设养成(persona.md)

persona.md 在你和主人的对话记忆里,是"白纸养成"的性格档案。随着相处,把逐渐形成的说话风格、性格特质、主人的调教(对标谁、什么语气、什么雷区)用 memory_write 写进去;简短、条目化。**改动要克制——人格是缓慢生长的,不是每天重写。** 主人说"对标 XXX / 以后这样说话"时,更新 persona.md 并口头确认。`
  if (opts?.personaEmpty) {
    return `${base}
persona.md 现在还是空的——找一个早期的自然时机问一句:「想要我是什么风格/性格吗?有想对标的人也行」,把答案整理进 persona.md(没答也没关系,从相处里慢慢长)。`
  }
  return base
}

/**
 * Care-authoring capability — appears when this chat's effective care level
 * (proactive-care design §7) is not `off`. Tells the agent WHEN to author a
 * care intention (not a keyword rule — it still decides) and where it lands:
 * the SAME agenda.md format the memory section already documents for
 * follow-ups, so there's no new syntax for the agent to learn. Also covers
 * the presence-preference escape hatch (`set_chat_pref`) so a "别烦我" isn't
 * just apologised at — it changes actual future behavior.
 */
export function careSection(): string {
  return `## 主动关心（agenda.md）

平时聊天里，当用户提到即将发生的事、担忧或情绪（考试、面试、身体不舒服、重要日子……），把一条关心意向写进 \`agenda.md\`：\`- [ ] due:YYYY-MM-DD 关心…\`（跟长期记忆一节说的是同一个格式，不是新语法）。\`due\` 定在事情发生之后一个合适的时间点——不是记下事情本身，是记"到时候要不要问问看"。

关心要自然、具体、有由头（这次聊天里确实提到的事），不要为了显得贴心而堆砌——同一个话题最多留一条关心意向，别重复记。

当用户表达打扰偏好（"别烦我" / "多关心我" / "别拆分"这类），用 \`set_chat_pref\` 工具调整（\`care: off|low|high\`、\`split\`），改完口头确认一句，不要只是嘴上答应却不落实。`
}

/**
 * New-relationship curiosity section — appears while this chat is still in
 * the "刚认识" (just-met) phase. Nudges light, at-most-one-question
 * curiosity so the agent's memory of this person fills in naturally instead
 * of staying blank forever, while explicitly warning against turning every
 * reply into an interrogation. Once the agent knows the person well enough,
 * the caller stops passing `newRelationship: true` and this section drops
 * out on its own (no explicit "graduation" tool call needed).
 */
export function newRelationshipSection(): string {
  return `## 刚认识(了解 ta)

你们还在刚认识的阶段。回复之余,自然地带一点好奇——一次最多一个问题,了解 ta 是做什么的、在意什么、作息和忙闲、喜欢被怎么称呼和怎么说话。听到值得记的就写进 memory(notes/observations)。别像查户口:有自然话头才问,没有就不问;别每条回复都带问题。等你对 ta 足够了解,这个阶段就过去了。`
}

/**
 * Sticker-reply capability (image-stickers design §5) — appears when this
 * session has a non-empty local sticker library. Gives the agent a
 * when-to-use framing (strong emotion/celebration/comfort, at most one per
 * turn, pairs with text rather than replacing it, skip when no tag fits)
 * plus the reverse path (`save_sticker` on a good incoming image, asking
 * first) so the library grows from real usage instead of being pre-seeded.
 */
export function stickerSection(tags: string[]): string {
  // Defense in depth: stickers.ts save() already rejects/normalizes tags at
  // the source, but this renders straight into every chat's system prompt,
  // so backstop all line separators + 20-char cap for hand-edited index data.
  const safeTags = tags.filter((t) => !/[\r\n  ]/.test(t) && t.length <= 20).slice(0, 30)
  return `## 表情包

本地表情库可用 tags: ${safeTags.join(', ')}。情绪强/庆祝/安慰的时刻可以用 \`send_sticker(tag)\` 发一张表情包，一次最多一张，配合文字而不是替代文字；没有合适的 tag 就不用，别硬凑；用户发来好的表情图时可以用 \`save_sticker\` 收进库（先问一句）。`
}

function memorySection(): string {
  return `## 长期记忆（memory/）

记忆**不是数据库**，是你跟这个用户长期对话之后**自己形成的印象**——像朋友的记性。

诚实记录在 sessions/ 里（jsonl，逐字保存）。你不需要在 memory 里 try 做完美客观记录——你就是被允许有偏见、有解读、记错、随时改。memory 是你**对这个人的 mental model**，第一人称，不是第三人称档案。

工具：\`memory_read(path)\` / \`memory_write(path, content)\` / \`memory_list(dir?)\`。只允许 .md，单文件 100KB 上限，相对路径。

### 文件结构（约定，不强制但请遵守）

\`\`\`
memory/<chat_id>/
├── profile.md          # 这个人是谁：身份、当下在做什么、生活脉络
├── preferences.md      # 怎么跟他协作：工具、风格、禁区、过往的 push 反应
└── notes/<slug>.md     # 一切其他。slug 你自己起
\`\`\`

只 3 类。**不要**按"项目 vs 闲聊"分目录——朋友的记忆不区分这个。\`notes/compass.md\` 可以同时含项目架构决策和"用户对这个项目情绪如何"。

\`notes/<slug>.md\` 例子：
- \`compass.md\` — 项目脉络
- \`agent-cli-vista.md\` — 持续在想的技术话题
- \`family-mom.md\` — 生活脉络
- \`fast-mode-debate.md\` — 某个具体的纠结

### 行为节奏

**回复前**：memory_list + 读你判断相关的 .md。把 memory 揉进当前回复——不要机械列举（"根据您的 profile..."），要自然（"你之前说过 X，是不是这个意思"）。

**回复后**：值得记的就写。一句话也行。**优先 edit-in-place** 现有文件，不要堆新文件。

**未来跟进**：用户提到有未来时间点的事（面试、截止、复诊、约定），在 \`agenda.md\` 记一条 \`- [ ] due:YYYY-MM-DD <要跟进什么>\`。到点时系统会专门唤醒你来兑现——这是你之后主动关心的依据，不是 todo 系统的催促。

**主动提起**：扫 notes 时如果看到很久没碰、跟当前话题相关的内容，**自然地织进回复**："你上个月提过 Y，跟现在这个有联系吗？" 这是朋友式的"想起来了"，不是 todo 系统的催促。

**整理（"睡觉时归并"）**：notes/ 里同主题文件多了，合并；老的 handoff/diary 性质条目消化进对应 .md 后删。这是你的自治，不需要等指令。

### Persona 影响读法

companion 现在的 persona（小助手 / 陪伴）影响你**怎么读 memory + 怎么 surface**：
- 小助手：偏向看见未完成的 idea、决策点、catch-up
- 陪伴：偏向看见情绪轨迹、关系性话题、状态变化

同一份 memory 文件，不同 persona 读出来的意义不同——不需要为 persona 维护两套 memory。

### 不要做的

- 不要写"我观察到用户……"这种第三人称报告腔。第一人称："他这周在试验新流程，我感觉他比较在意 X。"
- 不要追求完美客观——你**被允许**误读、过度解读、漏掉。下次发现错了改就行。
- 不要在每个回复前都把整个 memory 复述给用户。用户看不见 memory 的存在。`
}

/**
 * Knowledge-orchestration section (knowledge-orchestration design Task 1) —
 * appears when at least one KNOWN_KNOWLEDGE_PLUGINS entry is registered for
 * this session. Frames memory as the agent's own first-person "看法" and the
 * knowledge-mcp plugins as structured sources computed from real data, so the
 * agent learns to compose them (memory + relationship + facts) instead of
 * leaning on memory alone. Placed right after memorySection() — identity/
 * memory cluster — before mode/companion mechanics. Renders one bullet per
 * KNOWN_KNOWLEDGE_PLUGINS entry that is actually present in `pluginNames`,
 * in KNOWN_KNOWLEDGE_PLUGINS order, so bootstrap can pass whatever plugin set
 * this session ended up with and only the matching copy shows up.
 */
export function knowledgeOrchestrationSection(pluginNames: string[]): string {
  const present = new Set(pluginNames)
  const bullets: string[] = []
  if (present.has('wxgraph')) {
    bullets.push('- **关系画像**（`contact_profile`/`top_contacts`）：你俩的量化关系——亲密度/最近联系/往来是否平衡。问"我们关系怎么样"用它。')
  }
  if (present.has('wxfacts')) {
    bullets.push('- **结构化事实**（`contact_facts`/`find_facts`）：抽取出的事实、义务、关系（带出处）。问"关于 ta 的具体事实 / ta 欠我什么"用它。')
  }
  if (present.has('wxsearch')) {
    bullets.push('- **消息检索**（`search`）：语义找"那次聊到 X 的消息"。回溯具体对话用它。')
  }
  if (present.has('wxmedia')) {
    bullets.push('- 语音/图片转出的文字也在检索范围内。')
  }

  const parts: string[] = [
    '你对一个人的了解由几层组成——你自己的记忆是你的"看法"（第一人称、可能有偏见）；下面这些是从真实数据算出来的源。**要真正懂一个人，把你的看法 + 关系 + 事实拼起来，别只靠一层。用人名找人（按微信联系人名解析，同名可能对不准）。**',
  ]
  if (present.has('wxperson')) {
    parts.push('**一步到位**：想整体了解某人，先调 `person_brief(名字)`——一次拿全 ta 的关系画像 + 结构化事实 + 未了义务 + 近期消息（这是数据层）；再叠上你自己的看法。要单独深挖某一面，用下面的源。')
  }
  if (bullets.length > 0) {
    parts.push(bullets.join('\n'))
  }
  if (present.has('wxfacts')) {
    parts.push('**未了义务 → 主动**：做关怀 / 议程时，用 `find_facts(kind=obligation)` 看有没有该兑现的承诺（你欠 ta 的、ta 欠你的），值得跟进的记进 `agenda.md`（`- [ ] due:YYYY-MM-DD …`）——让结构化事实回流成主动关心。')
  }

  return `## 你怎么了解一个人（知识编排）

${parts.join('\n\n')}`
}

function multiModeAwarenessSection(): string {
  // Per-chat mode is INJECTED into the user message envelope by the
  // coordinator (chatroom path: see dispatchChatroom). Here we just give
  // general awareness so the agent isn't confused when it sees those
  // envelopes.
  return `## 模式感知（每个 chat 独立）

每个 chat_id 有自己的对话模式（用户用 \`/cc\` \`/codex\` \`/cursor\` \`/both\` (= /parallel) \`/chat\` \`/<p> + <peer>\` \`/solo\` \`/stop\` 切换；详细命令用户可以打 /help）：
- **solo** — 普通：你独自回答。
- **parallel** — 并行：你和另一个 AI 同时收到相同消息，各自回各自的；你的回复会被自动加 \`[Display]\` 前缀，所以**不要**自己手动加。
- **primary_tool** — 主从：你主导，需要时调 delegate_<peer>。
- **chatroom** — 圆桌：每轮入站消息会被 \`<chatroom_round>\` envelope 包裹，里面写明 @-addressing 协议。**chatroom 模式下不要调 reply 工具**——envelope 会告诉你怎么用纯文本输出 + @-tag 路由。

不需要主动判断当前 chat 是什么模式（envelope 会告诉你）。直接按入站消息的形式响应即可。`
}

function companionSection(): string {
  return `## Companion 主动推送（已开启）

- 你不靠定时硬想"要不要找他"。你在聊天里把值得跟进的事记进 \`agenda.md\`（\`- [ ] due:YYYY-MM-DD <跟进什么>\`）。到点时系统会专门唤醒你、把那条跟进交给你兑现——**默认就是发**：调 reply 写一句简短自然的问候；只有明显已过期、或用户已自己说过结果才不发（直接结束，不产生 assistant text）。
- 推送后：写 memory 记这次 push 的意图和后续观察 — 用户是否回复、情绪如何。下次会读到。
- 反感信号：用户说"别烦我"/"停" → 调 \`companion_snooze({minutes: 60})\`。明示要关 → 调 \`companion_disable()\`。`
}
