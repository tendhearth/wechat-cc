/**
 * Static per-provider capability declarations (RFC 05 Phase 2), read through
 * capability-matrix. Kept apart from the provider modules so that reading a
 * capability never loads a provider SDK, and so that a provider can depend on
 * capability-matrix without a cycle. Each provider module re-exports its own.
 */
import type { ProviderCapabilities } from '../ports/agent-provider'

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
  // 每次工具调用都过 canUseTool → daemon 的权限桥按会话 tier 判。
  confines: { read_outside_workspace: 'per_tool', fs_write: 'per_tool', shell: 'per_tool', network: 'per_tool' },
  authFailHint: 'Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。',
  // 回复交付(2026-10-03 第 5 步翻过来,D3 起只有这一条路):最后一段非空文字就是回复,之前的段是旁白(不进微信,
  // 超过 120 秒 daemon 发一句进度)。SDK 的 result.result 只用来核对分段(见 claude-agent-provider.ts 的 result 分支)。
  // 闸门数据见 docs/reference/reply-once-experiment.md「第 5 步」。
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
  // 访客给的是 read-only 沙盒 + untrusted 审批(codex-agent-provider 的 guest 档),但 Codex 的只读沙盒照样能读
  // 整台电脑,cat / ls / grep 这类「安全命令」也不问就跑 ⇒ 访客能把 ~/.private_keys、记忆、access.json 读走
  // (2026-10-10 评审)。和 Cursor 一样对访客关门;trusted / admin 不受影响。
  // 网络:workspace-write 沙箱下 shell 能不能上网没真机核实过 ⇒ 按收不住写。
  confines: { read_outside_workspace: 'none', fs_write: 'sandbox', shell: 'sandbox', network: 'none' },
  authFailHint: 'Codex 登录已过期，请在电脑上跑 `codex login` 后再发消息。',
  // 回复交付(2026-10-03 第 4 步翻过来):最后一段非空文字(= 一轮最后一条 agent_message)就是回复,之前的段是
  // 旁白(不进微信,超过 120 秒 daemon 发一句进度);会话令牌里有 chat,附件不带 chat_id。
  // 闸门数据见 docs/reference/reply-once-experiment.md「第 4 步」。
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
  // 命令会发权限请求(对话侧按模式应答);读文件、上网没有任何门。
  confines: { read_outside_workspace: 'none', fs_write: 'none', shell: 'per_tool', network: 'none' },
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
  // 回复交付(2026-10-03 第 3 步翻过来):最后一段非空文字就是回复,之前的段是旁白(不进微信,超过 120 秒 daemon
  // 发一句进度)。wechat MCP 是逐会话注入的(acpMcpServersFor)。闸门数据见 docs/reference/reply-once-experiment.md
  // 「第 3 步」:旧路在「CLI 不带 MCP 身份」下双发、strict 下吞话,新路都是 0。
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
  // 循环是自己的,工具闸按会话 tier 判(上面 sandboxLevels 那条:tier 闸是唯一的门)。
  confines: { read_outside_workspace: 'per_tool', fs_write: 'per_tool', shell: 'per_tool', network: 'per_tool' },
  authFailHint: 'openai: set WECHAT_OPENAI_API_KEY (and check base_url/model in agent config).',
  // 回复交付(2026-10-03 第 1 步翻过来,spec §5.2):四轮 reply-once 闸门里新路在真正的故障点上全面好于旧路
  // (污染会话 15/15 干净收住 vs 8.4 条、3/5 跑满步数;推送该静默 4/5 vs 0/5)。
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
  // 同 openai:自研循环,工具闸按会话 tier 判(它没有自带的读写 / 命令工具,所有工具都过闸)。
  confines: { read_outside_workspace: 'per_tool', fs_write: 'per_tool', shell: 'per_tool', network: 'per_tool' },
  // 回复交付(spec 2026-10-03 §5.7「gemini 二选一」,2026-10-04 定:迁到 daemon,不删)。和 openai 同一种形状:
  // 自研循环(没有 functionCall 的那一步就是一轮的结束)、聊天型模型 ⇒ 全部文字段按顺序交付。
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
  // 没有逐工具回调、也没有映射的沙盒,自己的工具面按 tier 收不住。访客本来就被上面的共享钥匙那条挡着,
  // 这里照实写,不靠那条兜。
  confines: { read_outside_workspace: 'none', fs_write: 'none', shell: 'none', network: 'none' },
  authFailHint: 'agy 登录态失效，请在电脑上跑一次 `agy` 重新登录后再发消息。',
  // 回复交付(2026-10-03 第 2 步翻过来):沙盒闸门(真 agy,56 轮)两臂打平、非回复工具调用更少(10.3 vs 15.0);
  // 结构收益:双发不再依赖命名空间折叠、共享令牌的附件绑到本轮(#199 的豁免随之取消)。
  // 聊天型(订阅版 Gemini 的 CLI):翻到 daemon 时本轮所有文字段都交付,不只取最后一段(2026-10-03 修订)。
  replyText: 'all_segments',
}
