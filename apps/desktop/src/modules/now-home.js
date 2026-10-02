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

// 右上角状态行:与 CC 明暗同一个信号。还没拉到第一拍 ⇒ 灰「正在连接…」(poller 失败时发的是 presence:'down',不是 null);
// daemon 没跑 ⇒ 红;presence down ⇒ 红;两边都通才绿。
/** @param {{alive:boolean}|null|undefined} daemon @param {{presence:string}|null} presence */
export function nowStatusLine(daemon, presence) {
  if (!daemon || !presence) return { cls: /** @type {'unknown'} */ ('unknown'), text: '正在连接…' }
  if (!daemon.alive) return { cls: /** @type {'bad'} */ ('bad'), text: 'CC 没在运行' }
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

// 每行像手机那样写问题 / 权限本身(GET /v1/workbench/attention 的 first,daemon 已压成一行并截断;
// spec 2026-10-01 §9-4 主人拍板),说明行是所属任务标题。旧 daemon 没有 first ⇒ 退回任务标题 + 计数。
/** @typedef {{kind:'permission'|'question',text:string}} AttentionFirst */
/** @param {{tasks:Array<{id:string,title:string,pendingPermissionCount:number,pendingQuestionCount:number,first?:AttentionFirst|null}>,stale:boolean}|null} state */
export function waitingRows(state) {
  if (!state || state.stale) return []
  return state.tasks.map(t => {
    const first = t.first && typeof t.first.text === 'string' && t.first.text.trim() ? t.first : null
    const total = t.pendingPermissionCount + t.pendingQuestionCount
    if (first) return {
      id: t.id,
      title: first.text.trim(),
      detail: [t.title, total > 1 ? `共 ${total} 项` : ''].filter(Boolean).join(' · '),
      go: /** @type {'看清楚'|'回答'} */ (first.kind === 'permission' ? '看清楚' : '回答'),
    }
    return {
      id: t.id,
      title: t.title,
      detail: [t.pendingPermissionCount ? `${t.pendingPermissionCount} 项权限` : '', t.pendingQuestionCount ? `${t.pendingQuestionCount} 个问题` : ''].filter(Boolean).join(' · '),
      go: /** @type {'看清楚'|'回答'} */ (t.pendingPermissionCount > 0 ? '看清楚' : '回答'),
    }
  })
}

// 「N 件事等你」那一行:读不到(stale)不等于没有 ⇒ 灰字说不知道,而不是悄悄消失(终审 M3)。还没拉到第一拍(null)不说话。
/** @param {{tasks:Array<any>,stale:boolean}|null} state */
export function waitingHeader(state) {
  if (state?.stale) return { hidden: false, unknown: true, title: '暂时不知道有没有等你的事' }
  const n = waitingRows(state).length
  return n === 0 ? { hidden: true, unknown: false, title: '' } : { hidden: false, unknown: false, title: `${n} 件事等你` }
}
