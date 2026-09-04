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
 * 「3 件 · 2 段见闻」—— 东西和见闻分开数:它们不是同一种计量单位。
 * @param {Array<any>} kept
 */
export function countLabel(kept) {
  const things = kept.filter(i => i.kind !== 'visit').length
  const visits = kept.length - things
  const parts = []
  if (things) parts.push(`${things} 件`)
  if (visits) parts.push(`${visits} 段见闻`)
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
  return `<article class="hb-card hb-visit" data-hb-id="${escapeHtml(it.id)}">
    <div class="hb-head">
      <h3 class="hb-title">🚶 ${escapeHtml(it.title || '串门')}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    ${it.image_svg ? `<div class="hb-postcard">${it.image_svg}</div>` : ''}
    <p class="hb-note">${escapeHtml(it.note || '')}</p>
    <div class="hb-foot hb-foot-visit">
      <button class="hb-del" data-hb-action="remove" data-hb-id="${escapeHtml(it.id)}" type="button" title="从背包里删掉">×</button>
    </div>
  </article>`
}

/** @param {any} it */
function renderCard(it) {
  if (it.kind === 'visit') return renderVisitCard(it)
  const url = it.url ? String(it.url) : ''
  const chips = STATUSES.map(s =>
    `<button class="hb-chip${it.status === s.key ? ' on' : ''}" data-hb-action="status"`
    + ` data-hb-id="${escapeHtml(it.id)}" data-hb-status="${s.key}" type="button">${s.label}</button>`).join('')
  // note 里已经包含链接原文;单独再列一次链接是为了能点、能复制。
  return `<article class="hb-card" data-hb-id="${escapeHtml(it.id)}">
    <div class="hb-head">
      <h3 class="hb-title">${escapeHtml(it.title || '(无标题)')}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    <p class="hb-note">${escapeHtml(it.note || '')}</p>
    ${url ? `<div class="hb-link">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
      <button class="hb-copy" data-hb-action="copy" data-hb-url="${escapeHtml(url)}" type="button">复制</button>
    </div>` : ''}
    <div class="hb-foot">
      <div class="hb-chips">${chips}</div>
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
    host.innerHTML = '<div class="fd-empty">读不到背包 —— daemon 没在跑?</div>'
    return
  }
  const { kept, dropped } = splitByStatus(data.items)
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

  if (action === 'status') {
    const status = btn.getAttribute('data-hb-status')
    const r = /** @type {{ok?:boolean}|null} */ (
      await invokeApi('POST', '/v1/journal/status', { id, status }).catch(() => null))
    // ok:false = 这条已经不在了(另一个窗口删过)。**不能装作成功** ——
    // 界面会显示一个改不动的状态,主人只会觉得点了没反应。
    if (!r?.ok) showToast('这条已经不在背包里了')
    await refreshHuntBag()
    return
  }

  if (action === 'remove') {
    const r = /** @type {{ok?:boolean}|null} */ (
      await invokeApi('POST', '/v1/journal/remove', { id }).catch(() => null))
    if (!r?.ok) showToast('这条已经不在背包里了')
    await refreshHuntBag()
  }
}

/** 装一次委托监听。 */
export function initHuntBag() {
  document.getElementById('fd-catch')?.addEventListener('click', onHuntBagClick)
}
