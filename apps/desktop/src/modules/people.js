// @ts-check
/**
 * people.js — 觅食台「👥 认识的人」:伙伴的社交圈(架构重构 §2.2 的关系视图)。
 *
 * 四种对方一张表:朋友的伙伴(peer)/ 经介绍人认识、还没揭晓的(anon)/
 * 邻居(neighbor)/ 来找过我的人(human)。数据来自 GET /v1/social/relationships,
 * 派生、不落表 —— 这里只负责让它读得出「我的伙伴认识谁、认识多深」。
 *
 * 唯一的动作是「串门」:去对方家坐坐。真对端要它回过串门信才能自动去
 * (旧版对端认不出信封);这里主人手动点是允许的 —— 主人知道两边都更新了。
 */
import { invokeApi } from '../api.js'
import { escapeHtml, showToast } from '../view.js'
import { dayLabel } from './journal.js'
let readGeneration = 0
let pageGeneration = 0
const pendingVisits = new Set()

/** @type {Record<string, string>} */
const KIND_LABEL = { peer: '朋友的伙伴', anon: '还没揭晓', neighbor: '邻居', human: '来找过我' }

/**
 * 「去过 3 次 · 上次昨天」/「还没去过」—— 熟悉度一行读完。
 * @param {{ visits: number, lastAt: string | null }} f @param {string} kind
 */
export function familiarityLine(f, kind) {
  const verb = kind === 'human' ? '来过' : '去过'
  if (!f.visits && !f.lastAt) return kind === 'human' ? '聊过一次' : '还没去过'
  const parts = []
  if (f.visits) parts.push(`${verb} ${f.visits} 次`)
  if (f.lastAt) parts.push(`上次${dayLabel(f.lastAt)}`)
  return parts.join(' · ')
}

/**
 * 能不能点「串门」:邻居永远能;有信道的真对端能(主人手动);人和没信道的不能。
 * @param {any} r
 */
export function canVisit(r) {
  if (r.kind === 'neighbor') return true
  if ((r.kind === 'peer' || r.kind === 'anon') && r.channel) return true
  return false
}

/** 串门按钮要传给后端的目标:邻居传 id 的后半段,真对端传信道。 @param {any} r */
export function visitTarget(r) {
  if (r.kind === 'neighbor') return String(r.id).slice('neighbor:'.length)
  return r.channel ? String(r.channel) : null
}

/** @param {any} r */
function renderRow(r) {
  const target = visitTarget(r)
  const btn = canVisit(r) && target
    ? `<button class="fd-btn pp-visit" data-pp-action="visit" data-pp-target="${escapeHtml(target)}" type="button">串门</button>`
    : ''
  const auto = r.autoVisit ? '<span class="pp-auto" title="每天会自己去">自动</span>' : ''
  return `<div class="pp-row pp-${escapeHtml(r.kind)}" data-pp-id="${escapeHtml(r.id)}">
    <div class="pp-main">
      <div class="pp-name">${escapeHtml(r.label)}<span class="pp-kind">${escapeHtml(KIND_LABEL[r.kind] ?? r.kind)}</span>${auto}</div>
      <div class="pp-meta">${escapeHtml(familiarityLine(r.familiarity, r.kind))} · ${escapeHtml(r.origin)}</div>
      ${r.familiarity.note ? `<div class="pp-note">上次聊到:${escapeHtml(r.familiarity.note)}</div>` : ''}
    </div>
    ${btn}
  </div>`
}

/**
 * @param {{ relationships: Array<any> | null, error?: string|null }} data — null = 读不到(daemon 没跑)。
 *   和「一个人都不认识」文案不同 —— 读取失败显示成空名单,等于说伙伴没朋友。
 */
export function renderPeople(data) {
  readGeneration++
  const host = document.getElementById('fd-people')
  const count = document.getElementById('fd-people-count')
  if (!host) return
  if (data.relationships == null) {
    if (count) count.textContent = ''
    host.innerHTML = String(data.error || '').includes('social_not_wired')
      ? '<div class="fd-empty" role="status"><p>朋友来往还没有开启。开启后，CC 可以和朋友的 CC 打交道。</p><button type="button" data-action="social-enable">启用社交</button></div>'
      : '<div class="fd-empty" role="status"><p>暂时无法读取联系人。</p><button type="button" data-pp-action="retry">重试</button></div>'
    return
  }
  const rels = data.relationships
  if (count) count.textContent = rels.length ? `${rels.length} 位` : ''
  if (rels.length === 0) {
    host.innerHTML = '<div class="fd-empty">还谁都不认识。与朋友配对后的来往会留在这里。</div>'
    return
  }
  host.innerHTML = rels.map(renderRow).join('')
  syncVisitButtons()
}

function syncVisitButtons() {
  document.getElementById('fd-people')?.querySelectorAll?.('[data-pp-action="visit"]').forEach(button => {
    if (button instanceof HTMLButtonElement) button.disabled = pendingVisits.has(button.getAttribute('data-pp-target'))
  })
}

export async function refreshPeople() {
  const ticket = ++readGeneration
  let error = null
  const resp = /** @type {{relationships?:Array<any>}|null} */ (
    await invokeApi('GET', '/v1/social/relationships').catch(err => { error = String(err?.message ?? err); return null }))
  if (ticket !== readGeneration) return
  renderPeople({ relationships: Array.isArray(resp?.relationships) ? resp.relationships : null, error })
}

/** @param {any} ev */
export async function onPeopleClick(ev) {
  const btn = ev.target?.closest?.('[data-pp-action]')
  if (!btn || btn.disabled) return
  if (btn.getAttribute('data-pp-action') === 'retry') { await refreshPeople(); return }
  const target = btn.getAttribute('data-pp-target')
  if (!target || pendingVisits.has(target)) return
  const owner = pageGeneration
  pendingVisits.add(target)
  btn.disabled = true
  const r = /** @type {{ok?:boolean, error?:string}|null} */ (
    await invokeApi('POST', '/v1/social/visit', { target }).catch(() => null))
  btn.disabled = false
  pendingVisits.delete(target)
  syncVisitButtons()
  if (owner !== pageGeneration) return
  if (r?.ok) showToast('出门了，聊完会在微信里跟你说')
  else showToast(r?.error === 'social_not_wired' ? '社交还没开' : '这次没能出门，请稍后重试')
}

export function initPeople() {
  const host = document.getElementById('fd-people')
  if (!host || host.dataset?.peopleBound === 'true') return
  if (host.dataset) host.dataset.peopleBound = 'true'
  host.addEventListener('click', onPeopleClick)
}

export function deactivatePeople() { readGeneration++; pageGeneration++ }
