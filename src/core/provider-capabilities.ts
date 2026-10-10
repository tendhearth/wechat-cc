/**
 * Static per-provider capability declarations (RFC 05 Phase 2), read through
 * capability-matrix. Kept apart from the provider modules so that reading a
 * capability never loads a provider SDK, and so that a provider can depend on
 * capability-matrix without a cycle. Each provider module re-exports its own.
 */
import type { ProviderCapabilities } from './agent-provider'

/**
 * RFC 05 Phase 2 — static capabilities. Claude is the only provider with
 * a per-tool callback SDK; sandbox levels are empty because Claude has
 * no SDK-level sandbox knob (relies on canUseTool + disallowedTools).
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: true,
  defaultPeer: 'codex',
  authFailHint: '⚠ Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。',
  // 回复交付第 5 步(2026-10-03,维护者按约定定,主人授权):最后一段非空文字就是回复,之前的段是旁白(不进微信,
  // 超过 120 秒 daemon 发一句进度)。wechat MCP 是 wechatStdioMcpSpec('claude') + 会话 env(sdkOptionsForProject),
  // 按这个开关带 WECHAT_REPLY_DELIVERY=daemon ⇒ 没有 reply 族,只有附件工具(+ admin 的 message);会话令牌里有 chat。
  // SDK 的 result.result 只用来核对分段(见 claude-agent-provider.ts 的 result 分支)。闸门见 docs/reference/reply-once-experiment.md「第 5 步」。
  // 回滚:agent-config 的 reply_delivery: { claude: 'legacy' } + 重启 daemon(docs/maintainer/reply-delivery.md)。
  replyDelivery: 'daemon',
  // 编码型执行者:只取最后一段(spec §4.2 / 修订记录 2026-10-03)。
  replyText: 'last_segment',
}

/**
 * RFC 05 Phase 2 — Codex SDK has no per-tool callback (every dispatch
 * runs to completion against the SDK-level sandbox), so strict-mode
 * gating maps to coarse sandbox levels. All three levels supported.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  adminMcpTools: true,
  sandboxLevels: new Set(['read-only', 'workspace-write', 'full']),
  supportsDelegation: true,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: '⚠ Codex 登录已过期，请在电脑上跑 `codex login` 后再发消息。',
  // 回复交付第 4 步(2026-10-03,维护者按约定定,主人授权):最后一段非空文字(= 一轮最后一条 agent_message)
  // 就是回复,之前的段是旁白(不进微信,超过 120 秒 daemon 发一句进度)。wechat MCP 是按 spawn 合进 SDK config
  // 的(mcpServers + 会话 env),wechatStdioMcpSpec('codex') 按这个开关带 WECHAT_REPLY_DELIVERY=daemon ⇒ 没有
  // reply 族,只有附件工具(+ admin 的 message);会话令牌里有 chat,附件不带 chat_id。
  // 闸门见 docs/reference/reply-once-experiment.md「第 4 步」。
  // 回滚:agent-config 的 reply_delivery: { codex: 'legacy' } + 重启 daemon(docs/maintainer/reply-delivery.md)。
  replyDelivery: 'daemon',
  // 编码型执行者:只取最后一段(spec §4.2 / 修订记录 2026-10-03)。
  replyText: 'last_segment',
}

export const ACP_CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  // session/new.mcpServers[].env 逐会话带 WECHAT_SESSION_TOKEN/_TIER(spike 2026-09-17 第 4 条实证到模型手里),
  // 所以 owner/admin 聊天真的拿到 admin tier —— 与 claude/codex 同档。
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  // Cursor 自己的工具面按 permissionMode 就地判(acp-agent-provider 的 permissions:'mode'),
  // tierProfile 根本到不了它;更要命的是工作区内的文件编辑压根不发 session/request_permission
  // (2026-09-17 真机 spike 第 2 条)—— 访客的权限约束不到它,所以 guest 一律拒。
  guestSafe: false,
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
  // 回复交付第 3 步(2026-10-03,维护者按约定定,主人授权):最后一段非空文字就是回复,之前的段是旁白(不进微信,
  // 超过 120 秒 daemon 发一句进度)。wechat MCP 是逐会话注入的(acpMcpServersFor),wechatStdioMcpSpec('cursor')
  // 按这个开关带 WECHAT_REPLY_DELIVERY=daemon ⇒ 没有 reply 族,只有附件工具(+ admin 的 message)。
  // 闸门(不连模型:照真机报文演的假 cursor-agent acp + 生产的 ACP 客户端 / 协调器 / 交付运行时,
  // docs/reference/reply-once-experiment.md「第 3 步」):daemon 全部适用场景过关、无回归;legacy 在
  // 「CLI 不带 MCP 身份」下双发 5 次、strict 下 3/3 轮主人什么都没收到,daemon 都是 0。
  // 回滚:agent-config 的 reply_delivery: { cursor: 'legacy' } + 重启 daemon(docs/maintainer/reply-delivery.md)。
  // Cursor 的 SDK 兜底(cursor-agent-provider.ts,没装 CLI 时)也注册在 'cursor' 这个 id 下,同一个开关。
  replyDelivery: 'daemon',
  // 编码型执行者:只取最后一段(spec §4.2 / 修订记录 2026-10-03)。
  replyText: 'last_segment',
}

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  // We own the loop, so per-tool gating IS realisable.
  perToolCallback: true,
  // openai-mcp-bridge threads WECHAT_SESSION_TIER per session.
  adminMcpTools: true,
  // No SDK/OS sandbox in v1 — the tier gate is the only barrier.
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: false,
  defaultPeer: 'claude',
  authFailHint: 'openai: set WECHAT_OPENAI_API_KEY (and check base_url/model in agent config).',
  // 回复交付第 1 步(spec 2026-10-03 §5.2):2026-10-03 维护者决定切 daemon(主人授权)。四轮 reply-once
  // 闸门里新路在真正的故障点上全面好于 legacy(污染会话 15/15 干净收住 vs legacy 8.4 条、3/5 跑满步数;
  // 推送该静默 4/5 vs 0/5);剩下的是「语音后多一句」这类小毛病。回滚:agent-config 的
  // reply_delivery: { openai: 'legacy' } + 重启 daemon(docs/maintainer/reply-delivery.md)。
  replyDelivery: 'daemon',
  // 聊天型模型:本轮所有文字段按顺序都交付(工具前说的话也是聊天内容,不是长任务旁白)。
  replyText: 'all_segments',
}

/** RFC 05 Phase 2 capability declaration. We OWN the loop → per-tool gating is
 *  realisable (perToolCallback). No SDK sandbox (enforcement is the tool gate,
 *  like Claude). Delegation + resume deferred to a follow-up. */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  // mcpEnv threads WECHAT_SESSION_TIER per session.
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: false,
  defaultPeer: 'claude',
  // 回复交付收尾(spec 2026-10-03 §5.7 删除清单「gemini 二选一」,2026-10-04 定:迁到 daemon,不删)。
  // 和 openai 同一种形状:自研循环(没有 functionCall 的那一步就是一轮的结束)、聊天型模型 ⇒ 全部文字段按
  // 顺序交付。迁过来后 legacy 路径不再有任何默认使用者,第 6 步可以整块删。这家一直没有真模型闸门(主人
  // 机器上从没配过 GEMINI_API_KEY);回滚同其它家:agent-config 的 reply_delivery: { gemini: 'legacy' } + 重启。
  replyDelivery: 'daemon',
  replyText: 'all_segments',
}

/**
 * RFC 05 Phase 2 capability declaration. agy has no per-tool callback (print
 * mode auto-denies/auto-allows) and no SDK sandbox surface we map in v1
 * (`--sandbox` deferred, see spec §7 non-goals). Resume IS real (native
 * `--conversation <id>`); delegation is explicitly out for v1 (spec §0
 * decision 2 — supportsDelegation:false keeps agy off primary_tool/parallel).
 */
export const AGY_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  // agy-mcp-config.ts pins WECHAT_SESSION_TIER to 'trusted' for its MCP
  // child (one static token, not per-session) — SESSION_IS_ADMIN is always
  // false, so admin-only tools (incl. the social-tools family) never
  // register for agy even when the owner is chatting.
  adminMcpTools: false,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: 'agy 登录态失效，请在电脑上跑一次 `agy` 重新登录后再发消息。',
  // 回复交付第 2 步(2026-10-03):维护者决定切 daemon(主人授权)。沙盒闸门(真 agy,56 轮)两臂行为打平、
  // daemon 非回复工具调用更少(10.3 vs 15.0);结构收益:双发不再依赖命名空间折叠、共享令牌的附件绑到本轮
  // (#199 豁免在 daemon 下取消)、走统一交付路径(终局要删 legacy)。回滚:agent-config 的
  // reply_delivery: { agy: 'legacy' } + 重启 daemon(docs/maintainer/reply-delivery.md)。
  replyDelivery: 'daemon',
  // 聊天型(订阅版 Gemini 的 CLI):翻到 daemon 时本轮所有文字段都交付,不只取最后一段(2026-10-03 修订)。
  replyText: 'all_segments',
}
