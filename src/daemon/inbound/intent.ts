/**
 * intent.ts — 一条入站消息"是什么":路由阶段(mw-route)算一次,后面的消费者按它分发。
 *
 * 2026-09-17 之前,九个消费型中间件各自 `if (await handle(msg)) consumed` —— "谁先试谁赢",
 * 匹配逻辑藏在各自的副作用里,顺序靠人记。现在每个消费者交出一个**只读**的 probe,
 * 优先级是下面这张表(就是原来链上的顺序),不是链上的位置。
 * 第一步(a)只算 + 记 trace,不改任何决策;第二步(b)消费者按 intent 早退;第三步(c)收成处理表。
 */
export type IntentKind = 'task-command' | 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'cli-reply' | 'task-reference' | 'chat'

export interface Intent {
  kind: IntentKind
  /** 这条消息归到哪件事(有 matters 登记处时)。 */
  matterId?: string | null
  /** probe 顺手算出来、消费者可以复用的东西(比如管家的指称解析结果),避免算两遍。 */
  data?: unknown
}

/**
 * 第二步(b):消费者按 intent 早退。路由判过(ctx.intent 存在)且不是我 ⇒ 我不碰这条消息。
 * 没路由(旧链 / 测试直接组装)⇒ 照旧自己试。
 */
export const routedAway = (ctx: { intent?: Intent }, mine: IntentKind): boolean => ctx.intent !== undefined && ctx.intent.kind !== mine

/** 消费者的优先级 —— 与 build.ts 里原来的链序一致;chat 是兜底,不在表里。 */
export const INTENT_ORDER: readonly Exclude<IntentKind, 'chat'>[] = ['task-command', 'admin', 'mode', 'onboarding', 'permission-reply', 'cli-reply', 'task-reference']
