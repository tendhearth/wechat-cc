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
      <div class="pp-meta">${escapeHtml(familiarityLine(r.familiarity, r.kind))}<span class="pp-dot"></span>${escapeHtml(r.origin)}</div>
      ${r.familiarity.note ? `<div class="pp-note">上次聊到:${escapeHtml(r.familiarity.note)}</div>` : ''}
    </div>
    ${btn}
  </div>`
}

/**
 * @param {{ relationships: Array<any> | null }} data — null = 读不到(daemon 没跑)。
 *   和「一个人都不认识」文案不同 —— 读取失败显示成空名单,等于说伙伴没朋友。
 */
export function renderPeople(data) {
  const host = document.getElementById('fd-people')
  const count = document.getElementById('fd-people-count')
  if (!host) return
  if (data.relationships == null) {
    if (count) count.textContent = ''
    host.innerHTML = '<div class="fd-empty">读不到 —— daemon 没在跑?</div>'
    return
  }
  const rels = data.relationships
  if (count) count.textContent = rels.length ? `${rels.length} 位` : ''
  if (rels.length === 0) {
    host.innerHTML = '<div class="fd-empty">还谁都不认识。开了社交之后附近就有邻居了。</div>'
    return
  }
  host.innerHTML = rels.map(renderRow).join('')
}

export async function refreshPeople() {
  const resp = /** @type {{relationships?:Array<any>}|null} */ (
    await invokeApi('GET', '/v1/social/relationships').catch(() => null))
  renderPeople({ relationships: resp ? (resp.relationships ?? []) : null })
}

/** @param {any} ev */
export async function onPeopleClick(ev) {
  const btn = ev.target?.closest?.('[data-pp-action="visit"]')
  if (!btn || btn.disabled) return
  const target = btn.getAttribute('data-pp-target')
  if (!target) return
  btn.disabled = true
  const r = /** @type {{ok?:boolean, error?:string}|null} */ (
    await invokeApi('POST', '/v1/social/visit', { target }).catch(() => null))
  btn.disabled = false
  if (r?.ok) showToast('🚶 出门了,聊完会在微信里跟你说')
  else showToast(r?.error === 'social_not_wired' ? '社交还没开' : '没出得了门')
}

export function initPeople() {
  document.getElementById('fd-people')?.addEventListener('click', onPeopleClick)
}
