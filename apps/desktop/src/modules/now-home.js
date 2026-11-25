// @ts-check
// 够得着 daemon 就在身边;presence.offline 指微信外发,不变暗。
/** @param {{presence:string}|null} p */
export function ccPresence(p) {
  return p && p.presence !== 'down' ? 'here' : 'away'
}

// 左栏连接状态:与 CC 明暗同一个信号。还没拉到第一拍 ⇒ 灰「正在连接…」(poller 失败时发的是 presence:'down',不是 null);
// daemon 没跑 ⇒ 红;presence down ⇒ 红;两边都通才绿。
/** @param {{alive:boolean}|null|undefined} daemon @param {{presence:string}|null} presence */
export function nowStatusLine(daemon, presence) {
  if (!daemon || !presence) return { cls: /** @type {'unknown'} */ ('unknown'), text: '正在连接…' }
  if (!daemon.alive) return { cls: /** @type {'bad'} */ ('bad'), text: 'CC 没在运行' }
  if (ccPresence(presence) === 'away') return { cls: /** @type {'bad'} */ ('bad'), text: 'CC 不在身边' }
  // 2026-10-06:以前 offline(微信发不出去)/ degraded(可选子系统没起来)也报绿「运行中」—— 在家,但不全好。
  // 点这一行打开「CC 现在怎么样」看是哪一项。
  if (presence.presence === 'offline') return { cls: /** @type {'warn'} */ ('warn'), text: 'CC 在家 · 微信发不出去' }
  if (presence.presence === 'degraded') return { cls: /** @type {'warn'} */ ('warn'), text: 'CC 在家 · 有功能没起来' }
  return { cls: /** @type {'ok'} */ ('ok'), text: 'CC 在家 · 运行中' }
}
