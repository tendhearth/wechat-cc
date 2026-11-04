/**
 * 终端会话的钩子事件进这件事的 MatterLog(M4a,设计稿 docs/superpowers/specs/2026-11-04-m4-terminal-matter-design.md)。
 * 一个原生会话 = 一件 kind='terminal' 的事(matter_bindings surface='cli');登记处(cli_sessions)照旧并行写。
 * 实现只经 MatterLog 写,写不上自己吞掉 —— 钩子的回包有时限,只少一步。
 */
export interface TerminalEventIn {
  source: string
  kind: 'stop' | 'prompt' | 'permission' | 'session_end'
  session_id: string
  cwd: string
  text?: string
  automated?: boolean
  machine?: string
  origin_agent?: string
  transcript_path?: string
  /** 这条会话的记录会读进这件事的步(M4b):发问原文 / 最后一句从记录来,钩子这边不再各写一步(免得两份)。 */
  transcribed?: boolean
}
export interface TerminalTurnLog {
  /** 钩子事件:prompt 开一轮(harness 自己塞的不开)、stop 收一轮、permission 等你、session_end 收尾。 */
  event(ev: TerminalEventIn, at: number): void
  /** 同步的权限请求(cli-permission-relay):等你那一步。同一件事已经有一张开着的卡 ⇒ 不再加。 */
  permissionAsked(req: { source: string; session_id: string; cwd: string; tool_name: string; summary?: string | null; machine?: string }, at: number): void
  /** 那张卡落定:allow ⇒ 做完;其余(deny / timeout / undelivered / unknown)⇒ failed。 */
  permissionSettled(sessionId: string, status: string): void
  /** 这个会话的那件事(没有就建,同 event 第一次见到时)。读记录进步之前先确保有(M4b,Codex 评审)。 */
  ensure(ev: Pick<TerminalEventIn, 'source' | 'session_id' | 'cwd' | 'machine' | 'origin_agent'>): string
  /** 开机:上一次进程里没收的终端轮记中断。 */
  interruptAll(): void
}
