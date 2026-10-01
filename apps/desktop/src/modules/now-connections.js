// @ts-check
// now-connections.js — 「此刻」右上角状态行打开的「CC 的连接」浮层(spec 2026-10-01)。
// 数据来自 GET /v1/connections(admin 全量)。规则与手机 /connections 一致
// (apps/app/src/view/connections.ts,那边是 TS + i18n,桌面不打包,所以在这里照抄成 JS + 中文):
//   - headline 取最坏的状态;任何「不知道」都是灰,绝不默认绿;
//   - 电脑不在线并进最坏的严重度(红);
//   - 来源行的日期是最新一条消息的时间(不是同步时间);
//   - 读不到 ⇒ 只当「上次所知」:所有点变灰,电脑不说「在线」。

/** @typedef {'ok'|'warn'|'bad'|'unknown'} Dot */
/** @typedef {'ready'|'behind'|'not_loaded'|'unknown'} State */
/** @typedef {{id:string,kind:string,name:string,state:State,latestAt:number|null,syncedAt:number|null}} Source */
/** @typedef {{generatedAt:number,sources:Source[],starting?:boolean,computers:Array<{id:string,label:string,online:boolean,since:number|null,version:string|null}>,recent:Array<{matterId:string,title:string,phase:string,at:number}>,outputs:Array<{matterId:string,name:string,mime:string,at:number}>}} Connections */

const STALE_AFTER_MS = 30_000
/** @param {number} ms */
const shortDate = ms => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日` }
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')

/** @type {Record<State, Dot>} */
const DOT = { ready: 'ok', behind: 'warn', not_loaded: 'bad', unknown: 'unknown' }
/** @type {Dot[]} 最坏的在前 */
const SEVERITY = ['bad', 'warn', 'unknown', 'ok']

/** @param {Connections} s @param {{stale?:boolean}} [opts] */
export function connectionsView(s, opts = {}) {
  const sources = s.sources.map(x => {
    const date = x.latestAt === null ? null : shortDate(x.latestAt)
    const label = x.state === 'ready' ? (date ? `最新消息 ${date}` : '已连上')
      : x.state === 'behind' ? (date ? `有一阵没同步 · 最新消息 ${date}` : '有一阵没更新了')
      : x.state === 'not_loaded' ? '没加载' : '不知道'
    const name = x.kind === 'wechat_history' ? '微信聊天记录' : x.kind === 'knowledge' ? '知识库' : x.name
    return { id: x.id, name, dot: DOT[x.state] ?? /** @type {Dot} */ ('unknown'), label }
  })
  const offline = s.computers.filter(c => !c.online).length
  const worst = SEVERITY.find(d => sources.some(x => x.dot === d) || (d === 'bad' && offline > 0)) ?? 'unknown'
  const count = sources.filter(x => x.dot === worst).length
  const badSources = sources.filter(x => x.dot === 'bad').length
  const text = worst === 'bad' ? (badSources === 0 ? `${offline} 台电脑不在线` : `${badSources} 项没加载`)
    : worst === 'warn' ? `${count} 项有点旧`
    : worst === 'ok' ? '都连着'
    : s.starting === true ? '电脑还在启动，暂时不知道' : '暂时不知道连接情况'
  const computers = s.computers.map(c => ({
    id: c.id, label: c.label, dot: /** @type {Dot} */ (c.online ? 'ok' : 'bad'),
    detail: !c.online ? '不在线' : opts.stale ? '上次连上时在线' : c.since === null ? '在线' : `在线 · 自 ${shortDate(c.since)}`,
  }))
  const view = {
    headline: { dot: /** @type {Dot} */ (worst), text },
    sources, computers,
    recent: s.recent.map(r => ({ matterId: r.matterId, title: r.title, when: shortDate(r.at) })),
    outputs: s.outputs.map(o => ({ matterId: o.matterId, name: o.name, when: shortDate(o.at) })),
  }
  if (!opts.stale) return view
  const grey = /** @type {Dot} */ ('unknown')
  return {
    ...view,
    headline: { ...view.headline, dot: grey },
    sources: view.sources.map(x => ({ ...x, dot: grey })),
    computers: view.computers.map(x => ({ ...x, dot: grey })),
  }
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
/** @param {Dot} d */
const dot = d => { const n = el('span', `dot ${d}`); n.setAttribute('aria-hidden', 'true'); return n }

/** @param {string} title @param {HTMLElement[]} rows */
function section(title, rows) {
  const s = el('section', 'nc-section')
  s.append(el('h3', 'nc-section-title', title))
  const ul = el('ul', 'nc-list')
  ul.append(...rows)
  s.append(ul)
  return s
}
/** @param {string} cls @param {Dot|null} d @param {string} name @param {string} detail */
function row(cls, d, name, detail) {
  const li = el('li', `nc-row ${cls}`)
  if (d) li.append(dot(d))
  li.append(el('span', 'nc-name', name), el('span', 'nc-detail', detail))
  return li
}

/**
 * @param {{host:HTMLElement, call:(method:'GET', path:string)=>Promise<unknown>, now?:()=>number}} o
 */
export function mountNowConnections({ host, call, now = () => Date.now() }) {
  /** @type {Connections|null} */ let data = null
  /** @type {number|null} */ let fetchedAt = null
  let failed = false
  let aging = false // 浮层重新打开、上次拉取已超过 30 秒:新结果回来前只当「上次所知」
  let ticket = 0

  function render() {
    const stale = (failed || aging) && data !== null
    const v = data ? connectionsView(data, { stale }) : null
    const head = el('p', 'nc-headline')
    head.append(dot(v ? v.headline.dot : 'unknown'), el('span', 'nc-headline-text', v ? v.headline.text : '暂时不知道连接情况'))
    /** @type {HTMLElement[]} */
    const parts = [el('h2', 'nc-title', 'CC 的连接'), head]
    if (stale && fetchedAt !== null) {
      const d = new Date(fetchedAt)
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
      parts.push(el('p', 'nc-stale', failed ? `现在读不到连接情况，下面是 ${hm} 时的情况` : `正在更新，下面是 ${hm} 时的情况`))
    }
    if (v) {
      if (v.sources.length) parts.push(section('来源', v.sources.map(x => row('nc-source', x.dot, x.name, x.label))))
      if (v.computers.length) parts.push(section('家里的电脑', v.computers.map(x => row('nc-computer', x.dot, x.label, x.detail))))
      if (v.recent.length) parts.push(section('最近在做', v.recent.map(x => row('nc-recent', null, x.title, x.when))))
      if (v.outputs.length) parts.push(section('成果', v.outputs.map(x => row('nc-output', null, x.name, x.when))))
    }
    host.replaceChildren(...parts)
  }

  async function refresh() {
    const mine = ++ticket
    try {
      const r = /** @type {Connections} */ (await call('GET', '/v1/connections'))
      if (mine !== ticket) return
      if (!r || !Array.isArray(r.sources) || !Array.isArray(r.computers)) throw new Error('invalid_connections')
      data = { ...r, recent: Array.isArray(r.recent) ? r.recent : [], outputs: Array.isArray(r.outputs) ? r.outputs : [] }
      fetchedAt = now()
      failed = false
      aging = false
    } catch {
      if (mine !== ticket) return
      failed = true
    }
    render()
  }

  /** 浮层打开时调:上次拉取超过 30 秒 ⇒ 先压灰再拉(终审 M2:别让上次的绿冒充现在)。 */
  function open() {
    if (data !== null && fetchedAt !== null && now() - fetchedAt > STALE_AFTER_MS) { aging = true; render() }
    return refresh()
  }

  render()
  return { refresh, open }
}
