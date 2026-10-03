/**
 * 回复交付的运行时回滚开关(spec 2026-10-03-reply-delivery):把 agent-config.json 的 `reply_delivery`
 * 装进 capability-matrix 的覆盖表。必须在 bootstrap 最前面调 —— wirePlugins 造 wechat MCP spec 时就按
 * 开关决定工具表(`WECHAT_REPLY_DELIVERY=daemon`),之后的提示词、协调器、伙伴推送读的也是同一个值。
 * 改了配置要重启 daemon 才生效(开关决定 MCP 子进程的工具表,不做热加载)。见 docs/maintainer/reply-delivery.md。
 */
import type { AgentConfig } from '../../lib/agent-config'
import { setReplyDeliveryOverrides } from '../../core/capability-matrix'

export function applyReplyDeliveryConfig(
  cfg: Pick<AgentConfig, 'reply_delivery'>,
  log: (tag: string, line: string) => void,
): void {
  const overrides = cfg.reply_delivery
  setReplyDeliveryOverrides(overrides)
  if (overrides && Object.keys(overrides).length > 0) {
    log('BOOT', `reply_delivery override (agent-config): ${Object.entries(overrides).map(([p, m]) => `${p}=${m}`).join(' ')}`)
  }
}
