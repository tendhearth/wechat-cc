// @ts-check
/**
 * hunt-bag.js — 觅食台的「🎒 打猎背包」区块。
 *
 * 用户反馈(2026-09-03)原话:「虽然你的 cc 有自动打猎的功能,但是桌面端
 * 没有记录」。打猎每天在跑,发完只剩微信聊天记录,想回头找上周那条链接
 * 只能往上翻。
 *
 * 另一位用户的 CC 自己想了个补法:建个 Excel「军火库」,每样东西记
 * 「是什么 / 对你有什么用 / 链接 / 状态(没试 / 我跑过 / 你在用)」。这个
 * 区块就是那张表 —— 状态那一列是它的灵魂:**这东西我到底用上了没有**,
 * 而这件事只有主人自己知道,得他自己点。
 */
import { invokeApi } from '../api.js'
import { escapeHtml, showToast } from '../view.js'

/** Plain readable text, never interpret untrusted HTML. */
/** @param {unknown} value */
export function readableText(value) {
  return String(value || '').replace(/!?(?:\[([^\]]+)\])\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*\d+[.)、]\s*/gm, '').trim()
}

/** @param {Array<any>} items */
export function groupRecommendations(items) {
  const copies = items.map(it => ({ ...it, sourceIds: [it.id] }))
  const removed = new Set()
  for (const child of copies) {
    if (child.kind !== 'hunt' || child.url || !/^(为什么你会感兴趣|推荐理由|为什么推荐|对你有什么用|适合你|怎么用)[：:\s]/.test(readableText(child.note))) continue
    const suffix = String(child.id).slice(String(child.ts).length + 1)
    const match = /^(\d+):/.exec(suffix)
    if (!match) continue
    const predecessor = copies.find(it => it.kind === 'hunt' && it.url && it.ts === child.ts && it.chat_id === child.chat_id && it.status === child.status && String(it.id).startsWith(`${child.ts}:${Number(match[1]) - 1}:`))
    if (!predecessor) continue
    predecessor.note += `\n\n${child.note}`
    predecessor.sourceIds.push(child.id)
    removed.add(child.id)
  }
  return copies.filter(it => !removed.has(it.id))
}

/** @param {any} it @param {string} url */
function cardTitle(it, url) {
  let title = readableText(it.title).replace(/\*+$/g, '').trim()
  if (url && (!title || title === new URL(url).hostname)) {
    const path = new URL(url).pathname.split('/').filter(Boolean)
    title = path.length ? path.slice(-2).join(' / ') : new URL(url).hostname
  }
  return title || '一条发现'
}

/** @param {unknown} note @param {string} title @param {string} url */
function noteHtml(note, title, url) {
  let text = readableText(note)
  if (url) text = text.split(url).join('').trim()
  if (text === title) return ''
  if (text.startsWith(title + '\n')) text = text.slice(title.length).trim()
  if (!text) return ''
  if (text.length <= 180) return `<p class="hb-note">${escapeHtml(text)}</p>`
  return `<details class="hb-description"><summary><span class="hb-excerpt">${escapeHtml(text.slice(0, 150))}… </span><span class="hb-expand-label">展开全文</span><span class="hb-collapse-label">收起全文</span></summary><p class="hb-note">${escapeHtml(text)}</p></details>`
}

/** 状态机:主人手点,不由系统推断。 */
export const STATUSES = [
  { key: 'new',     label: '没试' },
  { key: 'tried',   label: '跑过' },
  { key: 'using',   label: '在用' },
  { key: 'dropped', label: '不要了' },
]

/** @param {string} s */
export function statusLabel(s) {
  return STATUSES.find(x => x.key === s)?.label ?? '没试'
}

/**
 * 日期显示成「今天 / 昨天 / 9月1日」—— 战利品是按天攒的,精确到秒没有意义,
 * 而「今天」比「2026-09-03」更快让人定位。
 * @param {string} iso @param {Date} [now]
 */
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dayOf = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((dayOf(now) - dayOf(d)) / 86_400_000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7 && diff > 0) return `${diff} 天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 「3 件 · 2 段见闻 · 1 张明信片」—— 东西、见闻、明信片分开数:它们不是同一种计量单位。
 * @param {Array<any>} kept
 */
export function countLabel(kept) {
  const things = kept.filter(i => i.kind !== 'visit' && i.kind !== 'postcard').length
  const visits = kept.filter(i => i.kind === 'visit').length
  const cards = kept.filter(i => i.kind === 'postcard').length
  const parts = []
  if (things) parts.push(`${things} 件`)
  if (visits) parts.push(`${visits} 段见闻`)
  if (cards) parts.push(`${cards} 张明信片`)
  return parts.join(' · ')
}

/**
 * 分成「在背包里」和「不要了」两摞。
 *
 * 丢弃的不删除(主人可能改主意,而且「我上次为什么丢了这个」本身是信息),
 * 但要折叠起来 —— 一个越用越长的废弃列表会把清单本身淹掉。
 * @param {Array<any>} items
 */
export function splitByStatus(items) {
  /** @type {Array<any>} */ const kept = []
  /** @type {Array<any>} */ const dropped = []
  for (const it of items) (it.status === 'dropped' ? dropped : kept).push(it)
  return { kept, dropped }
}

/**
 * 见闻卡(kind='visit'):串门回来讲的那段话。没有链接,也没有「试过没有」——
 * 一段见闻不是一件要处理的东西。只留日期和删除。
 * 明信片(image_svg)内联渲染 —— 和记忆页的小像同一做法:daemon 存之前已经
 * 过了 safeSvg,这里不再过滤(也没有 DOM 之外的净化器可用)。
 * @param {any} it
 */
function renderVisitCard(it) {
  return `<article class="hb-card hb-visit" data-hb-id="${escapeHtml(it.id)}" data-hb-ids="${escapeHtml(JSON.stringify(it.sourceIds || [it.id]))}">
    <div class="hb-head">
      <h3 class="hb-title">${escapeHtml(it.title || '串门')}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    ${it.image_svg ? `<div class="hb-postcard">${it.image_svg}</div>` : ''}
    <p class="hb-note">${escapeHtml(it.note || '')}</p>
    <div class="hb-foot hb-foot-visit">
      <button class="hb-del" data-hb-action="remove" data-hb-id="${escapeHtml(it.id)}" type="button" title="从背包里删掉">×</button>
    </div>
  </article>`
}

/**
 * 明信片卡(kind='postcard'):别人的伙伴回了你的心愿。没有链接,也没有状态档。
 * @param {any} it
 */
function renderPostcardCard(it) {
  return `<article class="hb-card hb-postcard-card" data-hb-id="${escapeHtml(it.id)}" data-hb-ids="${escapeHtml(JSON.stringify(it.sourceIds || [it.id]))}">
    <div class="hb-head">
      <h3 class="hb-title">${escapeHtml(it.title || '明信片')}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    <p class="hb-note">${escapeHtml(it.note || '')}</p>
    <div class="hb-foot hb-foot-visit">
      <button class="hb-del" data-hb-action="remove" data-hb-id="${escapeHtml(it.id)}" type="button" title="从背包里删掉">×</button>
    </div>
  </article>`
}

/** @param {any} it */
function renderCard(it) {
  if (it.kind === 'visit') return renderVisitCard(it)
  if (it.kind === 'postcard') return renderPostcardCard(it)
  const rawUrl = it.url ? String(it.url) : ''
  let url = ''
  try { const parsed = new URL(rawUrl); if (['http:', 'https:'].includes(parsed.protocol)) url = rawUrl } catch { /* not a navigable link */ }
  const title = cardTitle(it, url)
  const chips = STATUSES.map(s =>
    `<button class="hb-chip${it.status === s.key ? ' on' : ''}" data-hb-action="status"`
    + ` data-hb-id="${escapeHtml(it.id)}" data-hb-status="${s.key}" type="button">${s.label}</button>`).join('')
  // 正文去重后，来源链接只在此处显示，供打开或复制。
  return `<article class="hb-card" data-hb-id="${escapeHtml(it.id)}" data-hb-ids="${escapeHtml(JSON.stringify(it.sourceIds || [it.id]))}">
    <div class="hb-head">
      <h3 class="hb-title">${escapeHtml(title)}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    ${noteHtml(it.note, title, url)}
    ${url ? `<div class="hb-link">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
      <button class="hb-copy" data-hb-action="copy" data-hb-url="${escapeHtml(url)}" type="button">复制</button>
    </div>` : ''}
    <div class="hb-foot">
      <details class="hb-status-menu"><summary>使用状态：${escapeHtml(statusLabel(it.status))}</summary><div class="hb-chips">${chips}</div></details>
      <button class="hb-del" data-hb-action="remove" data-hb-id="${escapeHtml(it.id)}" type="button" title="从背包里删掉">×</button>
    </div>
  </article>`
}

/**
 * @param {{ items: Array<any> | null }} data — items 为 null = 读不到
 *   (daemon 没跑 / 路由未接)。**这和「打了但空手」不是一回事**,所以
 *   文案必须不同 —— 把读取失败显示成空清单,等于告诉主人 CC 什么都没找到。
 */
export function renderHuntBag(data) {
  const host = document.getElementById('fd-catch')
  const count = document.getElementById('fd-catch-count')
  if (!host) return

  if (data.items == null) {
    if (count) count.textContent = ''
    host.innerHTML = '<div class="fd-empty">暂时无法读取带回来的内容，请到首页检查连接后重试。</div>'
    return
  }
  const { kept, dropped } = splitByStatus(groupRecommendations(data.items))
  if (count) count.textContent = countLabel(kept)

  if (kept.length === 0 && dropped.length === 0) {
    host.innerHTML = '<div class="fd-empty">背包还是空的 —— CC 每天会上网替你找一两样东西、也会去朋友家串门，带回来的都记在这儿。</div>'
    return
  }
  host.innerHTML =
    (kept.length ? kept.map(renderCard).join('') : '<div class="fd-empty">背包里的都处理完了。</div>')
    + (dropped.length
      ? `<details class="hb-dropped"><summary>不要了的 ${dropped.length} 件</summary>${dropped.map(renderCard).join('')}</details>`
      : '')
}

/**
 * 主人打开了觅食台 = 带回来的都看过了(spec 2026-09-03-companion-presence §2.3)。
 * 推 daemon 侧水位;桌宠脚边的包袱在下一次轮询消失。失败无所谓 —— 下次打开再推。
 * @returns {Promise<boolean>}
 */
export async function markJournalSeen() {
  try {
    const r = /** @type {{ ok?: boolean } | null} */ (await invokeApi('POST', '/v1/journal/seen'))
    return !!r?.ok
  } catch { return false }
}

export async function refreshHuntBag() {
  const resp = /** @type {{items?:Array<any>}|null} */ (
    await invokeApi('GET', '/v1/journal').catch(() => null))
  renderHuntBag({ items: resp ? (resp.items ?? []) : null })
}

/**
 * 委托点击处理(挂在 #fd-catch 上,卡片是重渲染出来的)。
 * @param {any} ev
 */
export async function onHuntBagClick(ev) {
  const btn = ev.target?.closest?.('[data-hb-action]')
  if (!btn) return
  const action = btn.getAttribute('data-hb-action')

  if (action === 'copy') {
    const url = btn.getAttribute('data-hb-url') ?? ''
    try { await navigator.clipboard.writeText(url); showToast('链接已复制') }
    catch { showToast('复制不了 —— 手动选中那行链接吧') }
    return
  }

  const id = btn.getAttribute('data-hb-id')
  if (!id) return

  let ids = [id]
  try { const grouped = JSON.parse(btn.closest?.('[data-hb-ids]')?.getAttribute('data-hb-ids') || 'null'); if (Array.isArray(grouped) && grouped.every(x => typeof x === 'string') && grouped.length) ids = grouped } catch { /* single record */ }

  if (action === 'status') {
    const status = btn.getAttribute('data-hb-status')
    const r = /** @type {{ok?:boolean}|null} */ (
      await Promise.all(ids.map(id => invokeApi('POST', '/v1/journal/status', { id, status }).catch(() => null))).then(results => ({ok: results.every(r => /** @type {{ok?:boolean}|null} */ (r)?.ok)})))
    // ok:false = 这条已经不在了(另一个窗口删过)。**不能装作成功** ——
    // 界面会显示一个改不动的状态,主人只会觉得点了没反应。
    if (!r?.ok) showToast('未能完成操作，请刷新后检查记录')
    await refreshHuntBag()
    return
  }

  if (action === 'remove') {
    const r = /** @type {{ok?:boolean}|null} */ (
      await Promise.all(ids.map(id => invokeApi('POST', '/v1/journal/remove', { id }).catch(() => null))).then(results => ({ok: results.every(r => /** @type {{ok?:boolean}|null} */ (r)?.ok)})))
    if (!r?.ok) showToast('未能完成操作，请刷新后检查记录')
    await refreshHuntBag()
  }
}

/** 装一次委托监听。 */
export function initHuntBag() {
  document.getElementById('fd-catch')?.addEventListener('click', onHuntBagClick)
}
