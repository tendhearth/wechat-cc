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

const INTRO_REQUEST_FAIL_COPY = /** @type {Record<string, string>} */ ({
  already_requested: '已经在问了',
  not_found: '这张明信片过期了',
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

/**
 * hop-2 明信片行 —— 「认识的人的朋友」带回来的一条,人还没接进来,先问要不要
 * 让伙伴去牵线。`requested` = 已经点过「想认识 TA」,不能再点第二次。
 * @param {any} pc
 */
function renderPostcardRow(pc) {
  const via = escapeHtml(String(pc.via_label ?? ''))
  const preview = escapeHtml(String(pc.preview ?? ''))
  const replyId = escapeHtml(String(pc.reply_id ?? ''))
  const action = pc.requested
    ? `<span class="wsh-pc-requested">已在问</span>`
    : `<button class="wsh-pc-intro" data-wsh-action="intro" data-wsh-reply="${replyId}" type="button">想认识 TA</button>`
  return `<div class="wsh-pc-row"><span class="wsh-pc-text">「${via} 的朋友」${preview}</span>${action}</div>`
}

/** @param {any} w */
function renderWishRow(w) {
  const label = STATUS_LABEL[w.status] ?? String(w.status ?? '')
  const sentTo = Number(w.sent_to) || 0
  const replies = Number(w.replies) || 0
  const canCancel = w.status === 'open' || w.status === 'draft'
  const postcards = Array.isArray(w.postcards) ? w.postcards : []
  return `<div class="wsh-row">
    <div class="wsh-body">
      <div class="wsh-text">${escapeHtml(String(w.text ?? ''))}</div>
      <div class="wsh-meta"><span>${escapeHtml(label)}</span><span class="wsh-dot">·</span><span>派给 ${sentTo} 人 · ${replies} 张回信</span></div>
      ${postcards.map(renderPostcardRow).join('')}
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
  // spec §5 说的是「**开着的**心愿列表」:草稿(还没派)和等回音的。关掉的、
  // 作废的、过期的都是往事 —— 回信本身在「🎒 带回来的」里,列表不做归档视图。
  const openish = wishes.filter(w => w.status === 'draft' || w.status === 'open')
  if (openish.length === 0) {
    list.innerHTML = '<div class="fd-empty">还没有心愿 —— 想问点什么就在上面写一句。</div>'
    return
  }
  list.innerHTML = openish.map(renderWishRow).join('')
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

/** @param {any} o */
function renderOfferRow(o) {
  const via = escapeHtml(String(o.via_label ?? ''))
  const hint = escapeHtml(String(o.hint ?? ''))
  const replyId = escapeHtml(String(o.reply_id ?? ''))
  return `<div class="wsh-offer-row">
    <span class="wsh-offer-text">「${via} 的朋友(问「${hint}」)想认识你」</span>
    <span class="wsh-offer-actions">
      <button class="fd-btn fd-btn-primary" data-wsh-action="accept" data-wsh-reply="${replyId}" type="button">同意</button>
      <button class="fd-btn wsh-btn-discard" data-wsh-action="decline" data-wsh-reply="${replyId}" type="button">不了</button>
    </span>
  </div>`
}

/**
 * 「待你点头」区块 —— 别人的伙伴托我的伙伴来问「能不能认识你」。空 → 整块收起,
 * 不占地方(不是每个人天天都有人想认识)。
 * @param {{ offers: Array<any> } | null | undefined} data
 */
export function renderOffers(data) {
  const box = document.getElementById('fd-wish-offers')
  if (!box) return
  const offers = data && Array.isArray(data.offers) ? data.offers : []
  if (offers.length === 0) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  box.innerHTML = offers.map(renderOfferRow).join('')
}

/**
 * 「社交没开」不是故障。两条路由都是 503 `social_not_wired`(api.js 把响应
 * body 的 error 抛成 message,读不到 body 时退成 `HTTP 503`)—— 这台机器没开
 * 这个功能而已,不该每次刷新都往控制台冒一条红字。别的错(daemon 没在跑、
 * 超时、500)照报。
 * @param {unknown} err
 */
function isSocialOff(err) {
  const msg = err instanceof Error ? err.message : String(err)
  return msg === 'social_not_wired' || msg === 'HTTP 503'
}

export async function refreshWishes() {
  const [wr, or] = await Promise.all([
    /** @type {Promise<{wishes?:Array<any>}|null>} */ (Promise.resolve(invokeApi('GET', '/v1/social/wishes')).catch(() => null)),
    /** @type {Promise<{offers?:Array<any>}|null>} */ (Promise.resolve(invokeApi('GET', '/v1/social/intro/offers')).catch(err => {
      if (!isSocialOff(err)) console.error('[wishes] 待你点头拉取失败', err)
      return null
    })),
  ])
  renderWishes({ wishes: wr ? (wr.wishes ?? []) : null })
  renderOffers({ offers: or ? (or.offers ?? []) : [] })
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
 * 委托点击:草稿卡(#fd-wish-draft)的 派/算了,列表(#fd-wish-list)里
 * open/draft 行的 取消,心愿下 hop-2 明信片的 想认识 TA,以及「待你点头」
 * (#fd-wish-offers)的 同意/不了。前三个落在 data-wsh-id 上,后三个(想认识 TA
 * / 同意 / 不了)落在 data-wsh-reply 上 —— 它们操作的是回信而不是心愿本身。
 * @param {any} ev
 */
export async function onWishAction(ev) {
  const btn = ev.target?.closest?.('[data-wsh-action]')
  if (!btn) return
  const action = btn.getAttribute('data-wsh-action')

  if (action === 'intro' || action === 'accept' || action === 'decline') {
    const replyId = btn.getAttribute('data-wsh-reply')
    if (!replyId) return
    const route = action === 'intro' ? '/v1/social/intro/request'
      : action === 'accept' ? '/v1/social/intro/accept'
      : '/v1/social/intro/decline'
    const r = /** @type {{ok?:boolean, reply_id?:string, reason?:string}|null} */ (
      await invokeApi('POST', route, { reply_id: replyId }).catch(() => null))
    if (action === 'intro') {
      showToast(r?.ok ? '已经托 TA 去问了' : (INTRO_REQUEST_FAIL_COPY[String(r?.reason)] ?? `没问成:${String(r?.reason ?? '未知错误')}`))
    } else if (action === 'accept') {
      showToast(r?.ok ? '名片递过去了' : `没弄成:${String(r?.reason ?? '未知错误')}`)
    } else {
      showToast(r?.ok ? '回了不了' : `没弄成:${String(r?.reason ?? '未知错误')}`)
    }
    await refreshWishes()
    return
  }

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
  document.getElementById('fd-wish-offers')?.addEventListener('click', onWishAction)
  refreshWishes()
}
