// @ts-check
// 生成物,别手改:改 packages/protocol/src/status-table.ts 后跑 bun run gen:routes
// 一件事的状态 ⇒ 怎么说、画什么、上不上强调色、归哪一组。三端(App / 桌面 / 手机网页)只认这一张。

export const STATUS_TABLE = /** @type {const} */ ({
  "working": {
    "word": "status.working",
    "icon": null,
    "tone": "inkSoft",
    "group": "working"
  },
  "waiting": {
    "word": "status.waiting",
    "icon": "shield",
    "tone": "accent",
    "group": "waiting"
  },
  "replied": {
    "word": "status.replied",
    "icon": "message",
    "tone": "inkSoft",
    "group": "back"
  },
  "done": {
    "word": "status.done",
    "icon": "done",
    "tone": "inkSoft",
    "group": "back"
  },
  "failed": {
    "word": "status.failed",
    "icon": "alert",
    "tone": "inkSoft",
    "group": "back"
  },
  "stopped": {
    "word": "status.stopped",
    "icon": "pause",
    "tone": "inkSoft",
    "group": "back"
  }
})

export const HOME_GROUP_ORDER = /** @type {const} */ (["waiting","working","back"])

export const STATUS_WORDS = /** @type {const} */ ({
  "working": "在做",
  "waiting": "等你决定",
  "replied": "这一轮做完了",
  "done": "完成",
  "failed": "没做成",
  "stopped": "停下了"
})

export const HOME_GROUP_WORDS = /** @type {const} */ ({
  "waiting": "等你",
  "working": "在做",
  "back": "带回来的"
})

/** @typedef {keyof typeof STATUS_TABLE} StatusKey */
/** @typedef {typeof HOME_GROUP_ORDER[number]} HomeGroupKey */
