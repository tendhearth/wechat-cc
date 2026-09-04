// @ts-check
/**
 * wishes.js — 觅食台的「📮 心愿」区块。
 *
 * 前身是「派心愿」+「回声」两个折叠子块(anonymous seek/echo forage 链路)。
 * 那条链路被撤下,换成这个更直接的形状:写一句话 → 伙伴先给你看脱敏后的
 * 措辞 → 你点「派」它才真的问「认识的人」(见 people.js) → 回信进「带回来的」
 * (journal.js 的 kind='postcard')。没有匿名觅食网、没有揭晓牵线仪式。
 */
import { invokeApi } from '../api.js'
import { escapeHtml, showToast } from '../view.js'

/** 状态字 —— 后端 v/v1/social/wish* 的 status 枚举。 */
const STATUS_LABEL = /** @type {Record<string, string>} */ ({
  draft: '草稿', open: '等回音', closed: '已关', expired: '过期', cancelled: '作废',
})

const SEND_FAIL_COPY = /** @type {Record<string, string>} */ ({
  no_channels: '还没有开着信道的朋友,先配对',
  too_many_open: '同时最多 3 条',
})

/** @param {any} r */
function wishGateErrText(r) {
  if (r?.error === 'gate_failed') {
    const violations = Array.isArray(r.violations) ? r.violations.join('、') : ''
    return `这句里有不能说的:${violations}`
  }
  if (r?.error === 'checker_unavailable') return '模型这会儿没响应,稍后再试'
  return `没发出去:${String(r?.error ?? '未知错误')}`
}

/** @param {any} w */
function renderWishRow(w) {
  const label = STATUS_LABEL[w.status] ?? String(w.status ?? '')
  const sentTo = Number(w.sent_to) || 0
  const replies = Number(w.replies) || 0
  const canCancel = w.status === 'open' || w.status === 'draft'
  return `<div class="wsh-row">
    <div class="wsh-body">
      <div class="wsh-text">${escapeHtml(String(w.text ?? ''))}</div>
      <div class="wsh-meta"><span>${escapeHtml(label)}</span><span class="wsh-dot">·</span><span>派给 ${sentTo} 人 · ${replies} 张回信</span></div>
    </div>
    ${canCancel ? `<button class="wsh-cancel" data-wsh-action="cancel" data-wsh-id="${escapeHtml(String(w.id ?? ''))}" type="button">取消</button>` : ''}
  </div>`
}

/**
 * @param {{ wishes: Array<any> | null } | null | undefined} data — wishes 为
 *   null = 读不到(社交没开 / daemon 没在跑)。和「派了但没有心愿」不是一回事。
 */
export function renderWishes(data) {
  const list = document.getElementById('fd-wish-list')
  const count = document.getElementById('fd-wish-count')
  const wishes = data && Array.isArray(data.wishes) ? data.wishes : null
  if (count) count.textContent = wishes ? String(wishes.filter(w => w.status === 'open').length) : ''
  if (!list) return
  if (wishes == null) {
    list.innerHTML = '<div class="fd-empty">社交没开 —— 打开后就能让伙伴帮你去问认识的人。</div>'
    return
  }
  if (wishes.length === 0) {
    list.innerHTML = '<div class="fd-empty">还没有心愿 —— 想问点什么就在上面写一句。</div>'
    return
  }
  list.innerHTML = wishes.map(renderWishRow).join('')
}

/**
 * 撰写草稿卡:成功 preview → 「派」/「算了」;preview 为 null 清空草稿
 * (发出去之后 / 算了之后收起)。
 * @param {{ id?: string, preview?: string } | null} preview
 */
export function renderWishDraft(preview) {
  const draft = document.getElementById('fd-wish-draft')
  if (!draft) return
  if (!preview) { draft.hidden = true; draft.innerHTML = ''; return }
  draft.hidden = false
  const id = escapeHtml(String(preview.id ?? ''))
  draft.innerHTML = `<div class="wsh-draft-text">${escapeHtml(String(preview.preview ?? ''))}</div>` +
    `<div class="wsh-draft-actions">` +
    `<button class="fd-btn fd-btn-primary" data-wsh-action="send" data-wsh-id="${id}" type="button">派</button>` +
    `<button class="fd-btn wsh-btn-discard" data-wsh-action="discard" data-wsh-id="${id}" type="button">算了</button>` +
    `</div>`
}

export async function refreshWishes() {
  const r = /** @type {{wishes?:Array<any>}|null} */ (
    await invokeApi('GET', '/v1/social/wishes').catch(() => null))
  renderWishes({ wishes: r ? (r.wishes ?? []) : null })
}

/** @param {{ preventDefault(): void }} ev */
export async function onWishCompose(ev) {
  ev.preventDefault()
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-wish-text'))
  const text = String(input?.value ?? '').trim()
  const draft = document.getElementById('fd-wish-draft')
  if (!text) {
    if (draft) { draft.hidden = false; draft.innerHTML = '<div class="wsh-draft-err">先写下你想让伙伴帮你打听什么</div>' }
    return
  }
  try {
    const r = /** @type {{ok?:boolean, id?:string, preview?:string, error?:string, violations?:Array<string>}} */ (
      await invokeApi('POST', '/v1/social/wish', { text }))
    if (r?.ok) {
      renderWishDraft({ id: r.id, preview: r.preview })
    } else if (draft) {
      draft.hidden = false
      draft.innerHTML = `<div class="wsh-draft-err">${escapeHtml(wishGateErrText(r))}</div>`
    }
  } catch (err) {
    if (draft) {
      draft.hidden = false
      draft.innerHTML = `<div class="wsh-draft-err">派不出去:${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`
    }
  }
}

/**
 * 委托点击:草稿卡(#fd-wish-draft)的 派/算了,以及列表(#fd-wish-list)里
 * open/draft 行的 取消。三者都落在 data-wsh-action 上。
 * @param {any} ev
 */
export async function onWishAction(ev) {
  const btn = ev.target?.closest?.('[data-wsh-action]')
  if (!btn) return
  const action = btn.getAttribute('data-wsh-action')
  const id = btn.getAttribute('data-wsh-id')
  if (!id) return

  if (action === 'send') {
    const r = /** @type {{ok?:boolean, sent_to?:number, reason?:string}|null} */ (
      await invokeApi('POST', '/v1/social/wish/send', { id }).catch(() => null))
    if (r?.ok) {
      showToast(`已派给 ${Number(r.sent_to) || 0} 个朋友`)
      renderWishDraft(null)
      await refreshWishes()
    } else {
      showToast(SEND_FAIL_COPY[String(r?.reason)] ?? `没派出去:${String(r?.reason ?? '未知错误')}`)
    }
    return
  }

  if (action === 'discard' || action === 'cancel') {
    const r = /** @type {{ok?:boolean}|null} */ (
      await invokeApi('POST', '/v1/social/wish/cancel', { id }).catch(() => null))
    if (action === 'discard') renderWishDraft(null)
    if (!r?.ok) showToast('没能取消 —— 稍后再试')
    await refreshWishes()
  }
}

/** 装一次委托监听 + 首次拉取。 */
export function initWishes() {
  document.getElementById('fd-wish-form')?.addEventListener('submit', onWishCompose)
  document.getElementById('fd-wish-draft')?.addEventListener('click', onWishAction)
  document.getElementById('fd-wish-list')?.addEventListener('click', onWishAction)
  refreshWishes()
}
