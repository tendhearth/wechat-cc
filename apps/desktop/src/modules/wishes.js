// @ts-check
/// <reference lib="dom" />
/**
 * 心愿: write → inspect the server's redacted wording → explicitly 派.
 * Saved drafts use that same confirmation step. No read or resume sends a wish.
 */
import { invokeApi } from '../api.js'
import { escapeHtml, showToast } from '../view.js'

const STATUS_LABEL = /** @type {Record<string, string>} */ ({
  draft: '草稿', open: '等回音', closed: '已关', expired: '过期', cancelled: '作废',
})
const SEND_FAIL_COPY = /** @type {Record<string, string>} */ ({
  no_channels: '还没有开着信道的朋友，先配对。',
  too_many_open: '同时最多派出 3 条心愿，请等已有心愿结束后再试。',
  not_draft: '这条心愿已经处理，请重新读取查看状态。',
  not_found: '暂时找不到这条心愿，请重新读取查看状态。',
})
const INTRO_FAIL_COPY = /** @type {Record<string, string>} */ ({
  already_requested: '已经在问了。', not_found: '这张明信片过期了。',
})

let active = false
let generation = 0
let readRevision = 0
let draftRevision = 0
/** @type {Map<string, any>} */
const savedDrafts = new Map()
/** @type {{ id: string, preview: string, sourceText?: string }|null} */
let currentDraft = null
/** @type {{ generation: number, draftRevision: number }|null} */
let creating = null
/** Keep an already posted mutation single-flight across page visits.
 * @type {Map<string, object>} */
const pendingWrites = new Map()

/** @param {number} epoch */
function isCurrent(epoch) { return active && generation === epoch }
/** A generic HTTP 503 or a connection error does not establish this state.
 * @param {unknown} error */
function isSocialOff(error) {
  return (error instanceof Error ? error.message : String(error)) === 'social_not_wired'
}

/** @param {any} result */
function wishGateErrText(result) {
  if (result?.error === 'gate_failed') {
    const reasons = Array.isArray(result.violations) ? result.violations.filter((/** @type {unknown} */ v) => typeof v === 'string').join('、') : ''
    return reasons ? `这句里有不能说的：${reasons}` : '这句里有不能公开的内容，请调整后再试。'
  }
  if (result?.error === 'checker_unavailable') return 'CC 暂时没能确认这句的措辞，请稍后再试。'
  return '暂时没能准备心愿，请再试一次。'
}

/** @param {any} pc */
function renderPostcardRow(pc) {
  const via = escapeHtml(String(pc.via_label ?? ''))
  const preview = escapeHtml(String(pc.preview ?? ''))
  const replyId = escapeHtml(String(pc.reply_id ?? ''))
  const action = pc.requested
    ? '<span class="wsh-pc-requested">已在问</span>'
    : `<button class="wsh-pc-intro" data-wsh-action="intro" data-wsh-reply="${replyId}" type="button">想认识 TA</button>`
  return `<div class="wsh-pc-row" data-wsh-reply-row="${replyId}"><span class="wsh-pc-text">「${via} 的朋友」${preview}</span>${action}</div>`
}

/** @param {any} wish */
function renderWishRow(wish) {
  const id = escapeHtml(String(wish.id ?? ''))
  const label = STATUS_LABEL[wish.status] ?? '状态未知'
  const meta = wish.status === 'draft' ? '草稿 · 尚未派出'
    : `${escapeHtml(label)} · 派给 ${Number(wish.sent_to) || 0} 人 · ${Number(wish.replies) || 0} 张回信`
  const postcards = Array.isArray(wish.postcards) ? wish.postcards : []
  const canCancel = wish.status === 'open' || wish.status === 'draft'
  return `<div class="wsh-row" data-wsh-row-id="${id}">
    <div class="wsh-body"><div class="wsh-text">${escapeHtml(String(wish.text ?? ''))}</div>
      <div class="wsh-meta">${meta}</div>${postcards.map(renderPostcardRow).join('')}</div>
    <div class="wsh-row-actions">
      ${wish.status === 'draft' ? `<button class="fd-btn" data-wsh-action="resume" data-wsh-id="${id}" type="button">继续确认</button>` : ''}
      ${canCancel ? `<button class="wsh-cancel" data-wsh-action="cancel" data-wsh-id="${id}" type="button">取消</button>` : ''}
    </div></div>`
}

/** @param {'off'|'error'} state @param {string} subject */
function readStatusHtml(state, subject) {
  return state === 'off'
    ? '<div class="wsh-status" role="status"><p>社交没开，开启后就能让 CC 帮你问认识的人。</p><button type="button" class="fd-btn" data-wsh-action="show-network">查看社交设置</button></div>'
    : `<div class="wsh-status" role="status"><p>暂时没能读取${escapeHtml(subject)}。</p><button type="button" class="fd-btn" data-wsh-action="retry">重新读取</button></div>`
}

/** @param {{ wishes: Array<any>|null, state?: 'off'|'error' }|null|undefined} data */
export function renderWishes(data) {
  const list = document.getElementById('fd-wish-list')
  const count = document.getElementById('fd-wish-count')
  const wishes = data && Array.isArray(data.wishes) ? data.wishes : null
  if (count) count.textContent = wishes ? String(wishes.filter(w => w.status === 'open').length) : ''
  if (!list) return
  savedDrafts.clear()
  if (wishes === null) {
    list.innerHTML = readStatusHtml(data?.state === 'off' ? 'off' : 'error', '心愿')
    return
  }
  // A successful complete read is authoritative for the current card.
  // The request may have succeeded while its response was lost or the page
  // was away. Only an existing draft still supports 派 / 算了; a read error
  // returns above and keeps the card. Reconciliation never clears input.
  if (currentDraft && !wishes.some(w => w.id === currentDraft?.id && w.status === 'draft')) renderWishDraft(null)
  const openish = wishes.filter(w => w.status === 'draft' || w.status === 'open')
  for (const wish of openish) if (wish.status === 'draft' && typeof wish.id === 'string' && typeof wish.text === 'string') savedDrafts.set(wish.id, wish)
  list.innerHTML = openish.length ? openish.map(renderWishRow).join('')
    : '<div class="fd-empty">还没有心愿，想问点什么就在上面写一句。</div>'
  syncPendingWrites()
}

/** Confirmation always displays the server's redacted wording.
 * sourceText exists only for a draft created in this renderer; it is used
 * to clear the input after a successful send only if its text is unchanged.
 * @param {{ id?: string, preview?: string, sourceText?: string }|null} preview */
export function renderWishDraft(preview) {
  const host = document.getElementById('fd-wish-draft')
  draftRevision++
  if (!preview) {
    currentDraft = null
    if (host) { host.hidden = true; host.innerHTML = ''; delete host.dataset.wshDraftId }
    return
  }
  currentDraft = { id: String(preview.id ?? ''), preview: String(preview.preview ?? ''), ...(preview.sourceText !== undefined ? { sourceText: preview.sourceText } : {}) }
  if (!host) return
  host.hidden = false
  host.dataset.wshDraftId = currentDraft.id
  const id = escapeHtml(currentDraft.id)
  host.innerHTML = `<div class="wsh-draft-text">${escapeHtml(currentDraft.preview)}</div>
    <div class="wsh-draft-actions">
      <button class="fd-btn fd-btn-primary" data-wsh-action="send" data-wsh-id="${id}" type="button">派</button>
      <button class="fd-btn wsh-btn-discard" data-wsh-action="discard" data-wsh-id="${id}" type="button">算了</button>
    </div>`
  syncPendingWrites()
}

/** @param {any} offer */
function renderOfferRow(offer) {
  const id = escapeHtml(String(offer.reply_id ?? ''))
  return `<div class="wsh-offer-row" data-wsh-reply-row="${id}">
    <span class="wsh-offer-text">「${escapeHtml(String(offer.via_label ?? ''))} 的朋友（问「${escapeHtml(String(offer.hint ?? ''))}」）想认识你」</span>
    <span class="wsh-offer-actions">
      <button class="fd-btn fd-btn-primary" data-wsh-action="accept" data-wsh-reply="${id}" type="button">同意</button>
      <button class="fd-btn wsh-btn-discard" data-wsh-action="decline" data-wsh-reply="${id}" type="button">不了</button>
    </span></div>`
}

/** @param {{ offers: Array<any>|null, state?: 'off'|'error' }|null|undefined} data */
export function renderOffers(data) {
  const host = document.getElementById('fd-wish-offers')
  if (!host) return
  if (data?.state === 'error') {
    host.hidden = false
    host.innerHTML = readStatusHtml('error', '待你点头的邀请')
    return
  }
  const offers = data && Array.isArray(data.offers) ? data.offers : []
  host.hidden = offers.length === 0
  host.innerHTML = offers.map(renderOfferRow).join('')
  syncPendingWrites()
}

/** @param {string} path @param {string} field
 * @returns {Promise<{ items: any[]|null, state?: 'off'|'error' }>} */
async function readList(path, field) {
  try {
    const response = /** @type {Record<string, any>|null|undefined} */ (await invokeApi('GET', path))
    if (response?.error === 'social_not_wired') return { items: null, state: 'off' }
    if (!Array.isArray(response?.[field])) return { items: null, state: 'error' }
    return { items: response[field] }
  } catch (error) {
    return { items: null, state: isSocialOff(error) ? 'off' : 'error' }
  }
}

export async function refreshWishes() {
  if (!active) return
  const epoch = generation
  const revision = ++readRevision
  const [wishes, offers] = await Promise.all([
    readList('/v1/social/wishes', 'wishes'), readList('/v1/social/intro/offers', 'offers'),
  ])
  if (!isCurrent(epoch) || revision !== readRevision) return
  renderWishes({ wishes: wishes.items, state: wishes.state })
  renderOffers({ offers: offers.items, state: offers.state })
}

/** @param {HTMLElement} host @param {string} message @param {boolean} [readAgain] */
function showFeedback(host, message, readAgain = false) {
  let note = host.querySelector(':scope > [data-wsh-feedback]')
  if (!(note instanceof HTMLElement)) {
    note = document.createElement('p')
    note.className = 'wsh-feedback wsh-draft-err'
    note.setAttribute('data-wsh-feedback', '')
    note.setAttribute('role', 'status')
    note.setAttribute('aria-live', 'polite')
    host.appendChild(note)
  }
  note.textContent = message
  if (readAgain) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'fd-btn'
    retry.dataset.wshAction = 'retry'
    retry.textContent = '重新读取'
    note.append(' ', retry)
  }
}

/** @param {string} message @param {boolean} [readAgain] */
function showDraftFeedback(message, readAgain = false) {
  const host = document.getElementById('fd-wish-draft')
  if (!host) return
  host.hidden = false
  showFeedback(host, message, readAgain)
}

/** @param {string} key @param {string} message @param {boolean} [readAgain] */
function showWriteFeedback(key, message, readAgain = false) {
  if (key.startsWith('wish:') && currentDraft?.id === key.slice(5)) { showDraftFeedback(message, readAgain); return }
  const attribute = key.startsWith('wish:') ? 'data-wsh-row-id' : 'data-wsh-reply-row'
  const id = key.slice(key.indexOf(':') + 1)
  for (const host of document.querySelectorAll(`[${attribute}]`)) {
    if (host instanceof HTMLElement && host.getAttribute(attribute) === id) showFeedback(host, message, readAgain)
  }
}

function syncPendingWrites() {
  for (const id of ['fd-wish-draft', 'fd-wish-list', 'fd-wish-offers']) {
    const host = document.getElementById(id)
    host?.querySelectorAll('button').forEach(button => {
      const key = button.dataset.wshId ? `wish:${button.dataset.wshId}`
        : button.dataset.wshReply ? `reply:${button.dataset.wshReply}` : null
      if (key) button.disabled = pendingWrites.has(key)
    })
  }
}

/** @param {boolean} busy */
function setComposeBusy(busy) {
  const button = document.getElementById('fd-wish-submit')
  if (button instanceof HTMLButtonElement) button.disabled = busy
  const form = document.getElementById('fd-wish-form')
  if (form) form.setAttribute('aria-busy', String(busy))
}

/** @param {{ preventDefault(): void }} event */
export async function onWishCompose(event) {
  event.preventDefault()
  if (!active || creating) return
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('fd-wish-text'))
  const sourceText = input?.value ?? ''
  const text = sourceText.trim()
  if (!text) { showDraftFeedback('先写下你想让 CC 帮你打听什么。'); return }
  const operation = { generation, draftRevision }
  creating = operation
  setComposeBusy(true)
  try {
    const result = /** @type {{ ok?: boolean, id?: string, preview?: string, error?: string, violations?: unknown[] }} */ (
      await invokeApi('POST', '/v1/social/wish', { text }))
    if (!isCurrent(operation.generation) || creating !== operation) return
    if (!result?.ok || typeof result.id !== 'string' || !result.id || typeof result.preview !== 'string') {
      if (draftRevision === operation.draftRevision) showDraftFeedback(wishGateErrText(result))
      return
    }
    // Reads started before this successful write can no longer establish
    // the current list state (including an obsolete disabled/error state).
    readRevision++
    // Typing a new sentence or choosing another saved draft while preparing
    // must not replace the current confirmation. The older draft is saved
    // server-side and can be resumed from the list after this fresh read.
    if (input?.value !== sourceText || draftRevision !== operation.draftRevision) {
      await refreshWishes()
      return
    }
    renderWishDraft({ id: result.id, preview: result.preview, sourceText })
  } catch {
    if (isCurrent(operation.generation) && creating === operation && draftRevision === operation.draftRevision) showDraftFeedback('暂时没能准备心愿，请再试一次。')
  } finally {
    if (creating === operation) {
      creating = null
      // The POST remains single-flight across visits. Its late completion
      // may release this lock but cannot change the new visit's content.
      if (active) setComposeBusy(false)
    }
  }
}

/** @param {Event} event */
export async function onWishAction(event) {
  if (!active || !(event.target instanceof HTMLElement)) return
  const button = event.target.closest('[data-wsh-action]')
  if (!(button instanceof HTMLButtonElement) || button.disabled || !button.isConnected) return
  const action = button.dataset.wshAction
  if (action === 'show-network') {
    const network = document.getElementById('fd-net')
    const details = network?.querySelector('details')
    if (details) details.open = true
    network?.scrollIntoView?.({ block: 'nearest' })
    return
  }
  if (action === 'retry') {
    const epoch = generation
    button.disabled = true
    try { await refreshWishes() }
    finally { if (isCurrent(epoch) && button.isConnected) button.disabled = false }
    return
  }
  const id = button.dataset.wshId
  if (action === 'resume') {
    if (!id || pendingWrites.has(`wish:${id}`)) return
    const saved = savedDrafts.get(id)
    if (saved?.status === 'draft') renderWishDraft({ id, preview: saved.text })
    return
  }
  const intro = action === 'intro' || action === 'accept' || action === 'decline'
  const replyId = button.dataset.wshReply
  if (intro ? !replyId : !id || (action !== 'send' && action !== 'discard' && action !== 'cancel')) return
  const key = intro ? `reply:${replyId}` : `wish:${id}`
  if (pendingWrites.has(key)) return
  const operation = {}
  const epoch = generation
  const panel = !intro && currentDraft?.id === id ? { ...currentDraft, revision: draftRevision } : null
  pendingWrites.set(key, operation)
  syncPendingWrites()
  try {
    const path = intro ? action === 'intro' ? '/v1/social/intro/request'
      : action === 'accept' ? '/v1/social/intro/accept' : '/v1/social/intro/decline'
      : action === 'send' ? '/v1/social/wish/send' : '/v1/social/wish/cancel'
    const result = /** @type {{ ok?: boolean, reason?: string, sent_to?: number }} */ (
      await invokeApi('POST', path, intro ? { reply_id: replyId } : { id }))
    if (!isCurrent(epoch)) return
    if (!result?.ok) {
      const message = intro ? INTRO_FAIL_COPY[String(result?.reason)] ?? '暂时没能完成介绍，请再试一次。'
        : action === 'send' ? SEND_FAIL_COPY[String(result?.reason)] ?? '这次没能派出，请再试一次。'
        : '这次没能取消，请再试一次。'
      showWriteFeedback(key, message, result?.reason === 'not_draft' || result?.reason === 'not_found')
      return
    }
    if (intro) showToast(action === 'intro' ? '已经托 TA 去问了' : action === 'accept' ? '名片递过去了' : '回了不了')
    else {
      if (action === 'send') showToast(`已派给 ${Number(result.sent_to) || 0} 个朋友`)
      if (panel && currentDraft?.id === panel.id && draftRevision === panel.revision) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('fd-wish-text'))
        if (action === 'send' && panel.sourceText !== undefined && input?.value === panel.sourceText) input.value = ''
        renderWishDraft(null)
      }
    }
    await refreshWishes()
  } catch {
    if (isCurrent(epoch)) showWriteFeedback(key, intro ? '暂时没能完成介绍，请再试一次。'
      : action === 'send' ? '暂时无法确认是否已派出，请重新读取心愿查看状态。'
      : '暂时无法确认是否已取消，请重新读取心愿查看状态。', true)
  } finally {
    if (pendingWrites.get(key) === operation) pendingWrites.delete(key)
    // Releasing this entity's lock is safe after re-entry; it cannot clear
    // cards, inputs, or a newer operation's lock. Content effects above are
    // guarded by the page generation and confirmation revision.
    if (active) syncPendingWrites()
  }
}

/** main calls this before refreshing the visible 觅食 pane. */
export function activateWishes() {
  if (active) return
  active = true
  generation++
  setComposeBusy(creating !== null)
  syncPendingWrites()
}

/** main calls this when leaving 觅食 and on pagehide. Keep unsent text/cards. */
export function deactivateWishes() {
  active = false
  generation++
  readRevision++
  draftRevision++
}

/** Wire once. Hidden-pane bootstrap must not reactivate a page left by main. */
export function initWishes() {
  const form = document.getElementById('fd-wish-form')
  if (!form) return
  if (form.dataset.wshReady !== 'true') {
    form.dataset.wshReady = 'true'
    form.addEventListener('submit', event => { onWishCompose(event).catch(() => {}) })
    for (const id of ['fd-wish-draft', 'fd-wish-list', 'fd-wish-offers']) {
      document.getElementById(id)?.addEventListener('click', event => { onWishAction(event).catch(() => {}) })
    }
  }
  if (active) refreshWishes().catch(() => {})
}
