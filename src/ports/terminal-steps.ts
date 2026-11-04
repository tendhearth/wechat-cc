/**
 * 终端会话记录增量读进这件事的步(M4b,设计稿 docs/superpowers/specs/2026-11-04-m4-terminal-matter-design.md)。
 * 解析在 features/terminal(cli-activity.ts 的 feedActivity);这里只管存:读到哪了、还在等结果的调用、步本身(经 MatterLog)。
 */
/** 一步是谁的:你说的 / 它说的 / 它做的动作。 */
export type TerminalStepKind = 'you' | 'said' | 'step'
/**
 * 一步 = 动作 + 对象(2026-10-17):text 是拼好的中文(手机网页、微信用);verb + target 给要按语言显示的端(App 英文界面)。
 * 每个 verb 对应 text 里固定的一种说法(features/terminal/cli-activity.ts 的 stepPhrase)。
 */
export type TerminalStepVerb = 'run' | 'edit' | 'write' | 'delete' | 'read' | 'search' | 'find' | 'subtask' | 'web' | 'websearch' | 'todo' | 'todos' | 'plan' | 'tend' | 'tool' | 'bgoutput'
/**
 * 步的 payload(读进来的那一步,matter_items.payload_json 存的就是它;M6d 起是 src 里唯一的这一份)。
 * 线上 `/m/api/cli/activity` 的 items、`CliSessionRow.now`(packages/protocol/src/api.ts)与它同形,那一份是冻结的线上形状(wire-compat.ts)。
 * detail(只在 step 上):点开这一步能看的 —— 改文件是 diff(`- 旧` / `+ 新`),跑命令是输出尾巴。
 * error:这一步的工具报错了(命令非零退出 / 工具 is_error)。
 */
export interface TerminalStepPayload { kind: TerminalStepKind; text: string; at: number | null; detail?: string; error?: boolean; verb?: TerminalStepVerb; target?: string }
export interface TerminalReadState {
  path: string
  /** 读到的字节位置(只到最后一个换行;读到一半的那一行留给下一次)。 */
  offset: number
  /** 第几次从头读(截短 / 换文件 / 跳过一大段 ⇒ 加一);步的 key 带上它,和上一次读进来的撞不上。 */
  gen: number
  /** 还在等结果的工具调用:调用 id → [那一步的 key, 要不要挂输出]。 */
  pending: Record<string, [string, boolean]>
}
export interface TerminalStepWrite {
  key: string
  kind: 'user_message' | 'agent_message' | 'tool_call'
  status: 'completed' | 'failed'
  payload: Record<string, unknown>
}
export interface TerminalStepStore {
  /** 这个终端会话的那件事;还没有(钩子没来过)⇒ null。 */
  matterOf(sessionId: string): string | null
  readState(matterId: string): TerminalReadState | null
  /** 读进来的那一步(key 以 STEP_KEY_PREFIX 开头的);没有 ⇒ null。 */
  item(matterId: string, key: string): Record<string, unknown> | null
  /** 最后读进来的那一步。 */
  last(matterId: string): { key: string; payload: Record<string, unknown> } | null
  /** 一个事务:写这些步(新的接在后面、旧的就地改;新的挂在跑着的那一轮上)并记下读到哪了。 */
  apply(matterId: string, writes: TerminalStepWrite[], state: TerminalReadState): void
  /** 最近 max 步的 payload,旧 → 新。 */
  recent(matterId: string, max: number): Array<Record<string, unknown>>
}
/** 读进来的步的 key 都以它开头(和钩子写的 user_message / agent_message / 权限卡分开)。 */
export const STEP_KEY_PREFIX = 't:'
