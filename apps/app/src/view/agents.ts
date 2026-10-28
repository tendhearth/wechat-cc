/**
 * 执行者头像(2026-10-19,主人:「文字量有点多,用圆形图标代替;多个 agent 就半叠」):
 * 每件事 / 每条终端会话在行尾画一组圆头像,正在做的在最上。名字只进读屏标签和详情页,行里不再写名字。
 * 纯函数;画法在 ui/AgentAvatars.tsx。
 *
 * 名字(收敛清单 ⑥):只由 daemon 定 —— matter.agentNames、终端 / 会话行的 displayName。App **不存名字表**;
 * 图形按 id 认(下面 AGENT_GLYPHS),名字按调用方给的 `names` 查,查不到(老 daemon)⇒ 退回 id。
 */

/** 有图标的那几家(图形来自 lobe-icons,MIT;单色、按 ink 着色)。别的执行者画首字母。 */
export const AGENT_GLYPHS = ['claude', 'codex', 'cursor', 'agy', 'gemini', 'kimi', 'openai', 'deepseek', 'qwen'] as const
export type AgentGlyph = typeof AGENT_GLYPHS[number]

/** 执行者 id → daemon 给的正式名字。 */
export type AgentNames = Readonly<Record<string, string>> | undefined

export function agentName(id: string, names?: AgentNames): string {
  return names?.[id] || id
}

export function agentGlyph(id: string): AgentGlyph | null {
  return (AGENT_GLYPHS as readonly string[]).includes(id) ? id as AgentGlyph : null
}

/** 没有图标的执行者:取名字里第一个字母 / 汉字,大写。 */
export function agentMonogram(id: string, names?: AgentNames): string {
  const ch = [...agentName(id, names).trim()][0] ?? '?'
  return ch.toUpperCase()
}

/** 一组最多露 max 个,多出来的折成「+N」;重复的、空的去掉,顺序不动(正在做的在前)。 */
export function agentStack(ids: readonly string[] | undefined, max = 3): { shown: string[]; more: number } {
  const uniq = [...new Set((ids ?? []).filter(Boolean))]
  // 正好多一个时直接画出来:「+1」占的地方跟一个头像一样大,不如让人看见是谁
  if (uniq.length <= max + 1) return { shown: uniq, more: 0 }
  return { shown: uniq.slice(0, max), more: uniq.length - max }
}

/** 读屏念的那一句:「Claude、Codex」。 */
export function agentsLabel(ids: readonly string[] | undefined, names?: AgentNames): string {
  return [...new Set((ids ?? []).filter(Boolean))].map(id => agentName(id, names)).join('、')
}

/** 详情页那一组:任务自己的执行者在前,再接列表给的(老 daemon 不带 agents ⇒ 至少有任务那一家)。 */
export function matterAgents(d: { task?: { providerId: string } | null; matter: { agents?: string[] } }): string[] {
  return [...new Set([d.task?.providerId, ...(d.matter.agents ?? [])].filter((x): x is string => !!x))]
}
