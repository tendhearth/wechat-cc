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
import { createRecordReader, isVisibleRecordTarget } from './record-reader.js'

/** @type {Map<string, any>} */
let records = new Map()
/** @type {any} */
let selectedRecord = null
let readGeneration = 0
let pageGeneration = 0
let pageActive = true
const pendingSources = new Set()
const reader = createRecordReader({
  onClose() { selectedRecord = null },
  focusFallback(opener) {
    const buttons = [...(document.getElementById('fd-catch')?.querySelectorAll('[data-hb-action="open"]') ?? [])]
    return [buttons.find(el => el.getAttribute('data-hb-id') === opener?.getAttribute('data-hb-id')),
      document.querySelector('#fd-catch [data-hb-action="retry"]'), ...buttons,
      document.querySelector('.hb-dropped>summary'), document.getElementById('fd-connect-btn')]
      .find(el => el && isVisibleRecordTarget(el)) ?? null
  },
})

/** 推荐理由段的开头(与 src/core/hunt-catch.ts 的 REASON_RE 同一张词表)。 */
const REASON_RE = /^[*#\s]*(?:为什么你会感兴趣|推荐理由|为什么推荐|对你有什么用|适合你|怎么用)[*\s]*[:：\s]/

/**
 * 旧记录归组(2026-09-29,取代 Codex #114 的一半):hunt-catch 修好之前,「推荐理由」段被单独存成一条
 * 没链接的记录。展示时把它并进紧挨着的上一条 —— 同一次打猎(同 ts)、同 chat、同状态、编号连续、
 * 理由段本身没链接。原始数据不动;返回的是拷贝,带 `sourceIds`,卡上的状态 / 删除覆盖组里每一条。
 * @param {Array<any>} items
 */
export function groupRecommendations(items) {
  const copies = items.map(it => ({ ...it, sourceIds: [it.id] }))
  const seq = (/** @type {any} */ it) => {
    const m = String(it.id).slice(String(it.ts).length).match(/^:(\d+):/)
    return m ? Number(m[1]) : null
  }
  const removed = new Set()
  for (const child of copies) {
    if (child.kind !== 'hunt' || child.url || !REASON_RE.test(String(child.note || ''))) continue
    const n = seq(child)
    if (n === null || n === 0) continue
    const parent = copies.find(it => it.kind === 'hunt' && it.url && !removed.has(it.id)
      && it.ts === child.ts && it.chat_id === child.chat_id && it.status === child.status && seq(it) === n - 1)
    if (!parent) continue
    parent.note = `${parent.note || ''}\n\n${child.note}`
    parent.sourceIds.push(child.id)
    removed.add(child.id)
  }
  return copies.filter(it => !removed.has(it.id))
}

/** 只放行 http / https —— 记录里的链接来自模型输出,`javascript:` 之类绝不能进 href。 @param {unknown} raw */
function safeUrl(raw) {
  if (!raw) return ''
  try { const u = new URL(String(raw)); return u.protocol === 'http:' || u.protocol === 'https:' ? String(raw) : '' } catch { return '' }
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

/** @param {any} it */
function recordTitle(it) { return String(it.title || '').replace(/[*#`]/g, '').trim() || '带回来的内容' }
/** @param {any} it */
function recordKind(it) { return it.kind === 'visit' ? '见闻' : it.kind === 'postcard' ? '明信片' : '推荐' }
/** @param {any} it */
function recordPicture(it) {
  // SVG stays in an image document, never as executable nodes in the app.
  return it.image_svg ? '<img class="hb-postcard" src="' + escapeHtml('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it.image_svg)) + '" alt="' + escapeHtml(recordTitle(it)) + '">' : ''
}
/** @param {any} it */
function renderCard(it) {
  const kind = it.kind === 'visit' ? ' hb-visit' : it.kind === 'postcard' ? ' hb-postcard-card' : ''
  const status = it.kind === 'visit' || it.kind === 'postcard' ? '' : ' · ' + statusLabel(it.status)
  return '<article class="hb-card' + kind + '" data-hb-id="' + escapeHtml(it.id) + '">'
    + '<button class="hb-read" type="button" data-hb-action="open" data-hb-id="' + escapeHtml(it.id) + '" data-hb-ids="' + escapeHtml(JSON.stringify(it.sourceIds || [it.id])) + '">'
    + '<span class="hb-head"><span class="hb-title">' + escapeHtml(recordTitle(it)) + '</span><span class="hb-day">' + escapeHtml(dayLabel(it.ts)) + '</span></span>'
    + '<span class="hb-note">' + escapeHtml(it.note || '') + '</span>'
    + '<span class="hb-meta">' + escapeHtml(recordKind(it) + status) + '</span></button></article>'
}
/** @param {any} it */
function detailMarkup(it) {
  const url = safeUrl(it.url), ids = escapeHtml(JSON.stringify(it.sourceIds || [it.id]))
  const attrs = ' data-hb-id="' + escapeHtml(it.id) + '" data-hb-ids="' + ids + '"'
  const statuses = it.kind === 'visit' || it.kind === 'postcard' ? '' : '<div class="hb-chips" role="group" aria-label="使用状态">'
    + STATUSES.map(state => '<button class="hb-chip' + (it.status === state.key ? ' on' : '') + '" type="button" data-hb-action="status"' + attrs + ' data-hb-status="' + state.key + '" aria-pressed="' + (it.status === state.key) + '">' + state.label + '</button>').join('') + '</div>'
  return '<article class="hb-detail"><h2>' + escapeHtml(recordTitle(it)) + '</h2><p class="hb-meta">' + escapeHtml(recordKind(it) + ' · ' + dayLabel(it.ts)) + '</p>'
    + recordPicture(it) + '<p>' + escapeHtml(it.note || '') + '</p>'
    + (url ? '<p class="hb-detail-link"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">打开链接 →</a></p>' : '')
    + '<details class="hb-detail-more"><summary>更多</summary>' + statuses
    + '<div class="hb-detail-actions">' + (url ? '<button class="hb-copy" type="button" data-hb-action="copy" data-hb-url="' + escapeHtml(url) + '">复制链接</button>' : '')
    + '<button class="hb-del" type="button" data-hb-action="remove"' + attrs + '>删除这条记录</button></div></details></article>'
}
function syncReadingState() {
  const dialog = reader.element
  if (!dialog || !selectedRecord) return
  const fresh = records.get(String(selectedRecord.id))
  if (fresh) selectedRecord = fresh
  const busy = (selectedRecord.sourceIds || [selectedRecord.id]).some((/** @type {string} */ id) => pendingSources.has(id))
  dialog.querySelectorAll('[data-hb-action="status"],[data-hb-action="remove"]').forEach(button => {
    if (button instanceof HTMLButtonElement) button.disabled = busy
    const status = button.getAttribute('data-hb-status')
    if (status) { button.setAttribute('aria-pressed', String(status === selectedRecord.status)); button.classList.toggle('on', status === selectedRecord.status) }
  })
}
/** @param {any} record @param {any} trigger */
function openRecord(record, trigger) {
  reader.open({label:recordKind(record),html:detailMarkup(record),trigger,onAction:onHuntBagClick})
  selectedRecord = record
  syncReadingState()
}

/** @param {string|null} message */
function showReadFeedback(message) {
  const detail = reader.element?.querySelector('.hb-detail')
  if (!detail) return
  detail.querySelector('.hb-detail-feedback')?.remove()
  if (!message) return
  const note = document.createElement('div')
  note.className = 'hb-detail-feedback'
  note.setAttribute('role', 'status')
  const text = document.createElement('p')
  text.textContent = message
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.dataset.hbAction = 'retry'
  retry.textContent = '重新读取'
  note.append(text, retry)
  detail.append(note)
}

/**
 * @param {{ items: Array<any> | null, error?:string|null }} data — items 为 null = 读不到
 *   (daemon 没跑 / 路由未接)。**这和「打了但空手」不是一回事**,所以
 *   文案必须不同 —— 把读取失败显示成空清单,等于告诉主人 CC 什么都没找到。
 */
export function renderHuntBag(data) {
  readGeneration++
  const host = document.getElementById('fd-catch')
  const count = document.getElementById('fd-catch-count')
  if (!host) return

  if (data.items == null) {
    if (count) count.textContent = ''
    host.innerHTML = '<div class="fd-empty" role="status"><p>暂时无法读取带回来的内容。</p><button type="button" data-hb-action="retry">重试</button></div>'
    return
  }
  const grouped = groupRecommendations(data.items)
  records = new Map(grouped.map(it => [String(it.id), it]))
  const { kept, dropped } = splitByStatus(grouped)
  if (count) count.textContent = countLabel(kept)

  if (kept.length === 0 && dropped.length === 0) {
    host.innerHTML = '<div class="fd-empty">还没有带回来的内容。CC 留下的推荐、见闻和明信片会出现在这里。</div>'
    return
  }
  host.innerHTML =
    (kept.length ? kept.map(renderCard).join('') : '<div class="fd-empty">带回来的都已收进「不要了」。</div>')
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
  const ticket = ++readGeneration
  const resp = /** @type {{items?:Array<any>}|null} */ (
    await invokeApi('GET', '/v1/journal').catch(() => null))
  if (ticket !== readGeneration) return false
  const items = Array.isArray(resp?.items) ? resp.items : null
  renderHuntBag({ items })
  syncReadingState()
  showReadFeedback(items ? null : '暂时无法重新读取。已确认的操作保留，可以稍后重试。')
  return items !== null
}

/**
 * 委托点击处理(挂在 #fd-catch 上,卡片是重渲染出来的)。
 * @param {any} ev
 */
export async function onHuntBagClick(ev) {
  const btn = ev.target?.closest?.('[data-hb-action]')
  if (!btn || btn.disabled) return
  const action = btn.getAttribute('data-hb-action')

  if (action === 'retry') { await refreshHuntBag(); return }
  if (action === 'open') {
    const record = records.get(btn.getAttribute('data-hb-id'))
    if (record) openRecord(record, btn)
    return
  }
  if (action === 'copy') {
    const url = btn.getAttribute('data-hb-url') ?? ''
    try { await navigator.clipboard.writeText(url); showToast('链接已复制') }
    catch { showToast('复制不了 —— 手动选中那行链接吧') }
    return
  }

  const id = btn.getAttribute('data-hb-id')
  if (!id) return
  // 归组卡(groupRecommendations)上的动作覆盖组里每一条。
  /** @type {string[]} */
  let ids = [id]
  try {
    const g = JSON.parse(btn.getAttribute('data-hb-ids') || 'null')
    if (Array.isArray(g) && g.length > 0 && g.every(x => typeof x === 'string')) ids = g
  } catch { /* 单条 */ }
  let transportFailed = false
  /** @param {string} path @param {(id: string) => Record<string, unknown>} body */
  const each = async (path, body) => {
    const rs = await Promise.all(ids.map(x => invokeApi('POST', path, body(x)).catch(() => { transportFailed = true; return null })))
    return rs.map(r => !!(/** @type {{ok?:boolean}|null} */ (r))?.ok)
  }
  // ok:false = 这条已经不在了(另一个窗口删过)。**不能装作成功** ——
  // 界面会显示一个改不动的状态,主人只会觉得点了没反应。
  const report = (/** @type {boolean[]} */ oks) => {
    if (oks.every(Boolean)) return
    showToast(oks.some(Boolean) ? '有一部分没改成 —— 刷新后看看' : transportFailed ? '暂时没能更新这条记录，请重试。' : '这条已经不在背包里了')
  }

  if (action !== 'status' && action !== 'remove') return
  if (ids.some(id => pendingSources.has(id))) return
  ids.forEach(id => pendingSources.add(id))
  const owner = pageGeneration
  syncReadingState()
  btn.disabled = true
  try {
    const oks = action === 'status'
      ? await each('/v1/journal/status', id => ({ id, status: btn.getAttribute('data-hb-status') }))
      : await each('/v1/journal/remove', id => ({ id }))
    if (owner === pageGeneration) report(oks)
    if (owner === pageGeneration && action === 'status' && oks.every(Boolean)) {
      const fresh = records.get(id)
      if (fresh) records.set(id, { ...fresh, status: btn.getAttribute('data-hb-status') })
      syncReadingState()
    }
    if (pageActive) await refreshHuntBag()
    if (pageActive && owner === pageGeneration && action === 'remove' && oks.every(Boolean) && selectedRecord?.id === id) reader.close()
  } finally {
    ids.forEach(id => pendingSources.delete(id))
    btn.disabled = false
    syncReadingState()
  }
}

/** 装一次委托监听。 */
export function initHuntBag() {
  const host = document.getElementById('fd-catch')
  if (!host || host.dataset?.readingBound === 'true') return
  if (host.dataset) host.dataset.readingBound = 'true'
  host.addEventListener('click', onHuntBagClick)
}

export function deactivateHuntBag() {
  readGeneration++
  pageGeneration++
  pageActive = false
  reader.close({restoreFocus:false})
}

export function activateHuntBag() { pageActive = true }
