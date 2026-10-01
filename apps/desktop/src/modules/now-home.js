// @ts-check
// now-home.js — 「此刻」页的纯函数(spec 2026-10-01 §6.3)。无 DOM。

/** @param {number} hour */
export function greetingFor(hour) {
  return hour >= 5 && hour <= 11 ? '早上好' : hour >= 12 && hour <= 17 ? '下午好' : '晚上好'
}

// 够得着 daemon 就在身边;presence.offline 指微信外发,不变暗。
/** @param {{presence:string}|null} p */
export function ccPresence(p) {
  return p && p.presence !== 'down' ? 'here' : 'away'
}

// 右上角状态行:与 CC 明暗同一个信号。daemon 没跑 ⇒ 红;够不着(presence down / 还没拉到)⇒ 也不是绿。
/** @param {{alive:boolean}|null|undefined} daemon @param {{presence:string}|null} presence */
export function nowStatusLine(daemon, presence) {
  if (!daemon || !daemon.alive) return { cls: /** @type {'bad'} */ ('bad'), text: 'CC 没在运行' }
  if (ccPresence(presence) === 'away') return { cls: /** @type {'bad'} */ ('bad'), text: 'CC 不在身边' }
  return { cls: /** @type {'ok'} */ ('ok'), text: 'CC 在家 · 运行中' }
}

/** @param {Array<{role:string,text:string,at?:number,pending?:boolean}>} messages */
export function latestCCLine(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = /** @type {{role:string,text:string,at?:number,pending?:boolean}} */ (messages[i])
    if (m.role === 'cc' && !m.pending && m.text.trim() !== '') return { text: m.text.trim(), at: typeof m.at === 'number' ? m.at : null }
  }
  return null
}

/** @param {{tasks:Array<{id:string,title:string,pendingPermissionCount:number,pendingQuestionCount:number}>,stale:boolean}|null} state */
export function waitingRows(state) {
  if (!state || state.stale) return []
  return state.tasks.map(t => ({
    id: t.id,
    title: t.title,
    detail: [t.pendingPermissionCount ? `${t.pendingPermissionCount} 项权限` : '', t.pendingQuestionCount ? `${t.pendingQuestionCount} 个问题` : ''].filter(Boolean).join(' · '),
    go: /** @type {'看清楚'|'回答'} */ (t.pendingPermissionCount > 0 ? '看清楚' : '回答'),
  }))
}
