// @ts-check
/// <reference lib="dom" />

import { invokeApi } from "../api.js"
import { escapeHtml } from "../view.js"
import { icon } from "./icons.js"
import { defaultReviewRange, orderReviewItems, reviewFailureCopy, reviewProgressCopy } from "./customer-review-utils.js"

export { defaultReviewRange, orderReviewItems, reviewFailureCopy, reviewProgressCopy } from "./customer-review-utils.js"

/** @typedef {{id:string,displayName:string,kind:string,lastMessageAt?:string,preview?:string}} CustomerContact */
/** @typedef {{evidenceKey:string,role:'commitment'|'completion'|'due_date',messageTime:string,senderSide:'me'|'contact',text?:string,messageType?:string}} ReviewEvidence */
/** @typedef {{sourceKey:string,commitment:string,aiStatus:'open'|'completed',dueDate?:string,confidence:'medium'|'high',reviewStatus:'unreviewed'|'confirmed'|'corrected'|'completed_elsewhere'|'rejected'|'ignored',correctedText?:string,evidence:ReviewEvidence[]}} ReviewItem */
/** @typedef {{windowIndex:number,rangeFrom:string,rangeTo:string,attempts:number}} ReviewAnalysisIssue */
/** @typedef {{id:string,contactId:string,contactDisplayName:string,rangeFrom:string,rangeTo:string,status:'queued'|'analyzing'|'ready'|'failed',sourceMessageCount:number,errorCode?:string,createdAt:string,completedAt?:string,analysisIssues?:ReviewAnalysisIssue[],items:ReviewItem[]}} CustomerReview */
/** @typedef {{contactId:string,displayName:string,reviewCount:number,lastReviewAt:string,lastStatus:'queued'|'analyzing'|'ready'|'failed'}} RecentReviewContact */

/** @type {CustomerContact|null} */
let selectedContact = null
/** @type {CustomerReview|null} */
let currentReview = null
/** @type {CustomerReview[]} */
let history = []
/** @type {ReturnType<typeof setTimeout>|null} */
let searchTimer = null
/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null
let searchSeq = 0
let detailSeq = 0
let api = invokeApi

/** The daemon's HTTP listener starts before the optional customer-review runtime. */
/**
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
async function customerReviewApi(method, path, body) {
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await api(method, path, body)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/customer_review_not_wired/i.test(message) || attempt === 4) throw error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw lastError
}

/** @param {string|undefined} value */
function formatDateTime(value) {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value.slice(0, 16)
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
}

/** @param {string} value */
function dateLabel(value) {
  const [y, m, d] = value.split("-")
  return y && m && d ? `${y}.${m}.${d}` : value
}

/** @param {unknown} error */
function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/customer_review_not_wired|WXVAULT|PROVIDER|MODEL/i.test(message)) return "客户回顾服务暂时不可用，请稍后再试。"
  if (/INVALID_RANGE/i.test(message)) return "请选择有效的时间范围。"
  return "操作没有完成，请稍后再试。"
}

/** @param {HTMLElement} root */
function renderShell(root) {
  const range = defaultReviewRange()
  root.innerHTML = `
    <aside class="customer-review-sidebar">
      <header class="customer-review-heading">
        <span class="customer-review-kicker">CUSTOMER REVIEW</span>
        <h1>客户回顾</h1>
        <p>把聊天中的明确承诺整理成待你核对的事项。</p>
      </header>
      <section class="customer-review-create" aria-labelledby="customer-review-create-title">
        <h2 id="customer-review-create-title">新建回顾</h2>
        <label class="customer-review-label" for="customer-review-search">客户</label>
        <div class="customer-review-search-wrap">
          <span>${icon("search-01", { size: 16 })}</span>
          <input id="customer-review-search" type="search" autocomplete="off" placeholder="输入微信联系人名称" />
        </div>
        <div id="customer-review-contact-results" class="customer-review-contact-results" hidden></div>
        <div id="customer-review-selected-contact" class="customer-review-selected-contact" hidden></div>
        <div class="customer-review-range">
          <label><span>开始日期</span><input id="customer-review-from" type="date" value="${range.from}" max="${range.to}" /></label>
          <label><span>结束日期</span><input id="customer-review-to" type="date" value="${range.to}" max="${range.to}" /></label>
        </div>
        <p id="customer-review-form-error" class="customer-review-inline-error" hidden></p>
        <button id="customer-review-submit" class="customer-review-primary" type="button" disabled>
          ${icon("play", { size: 16 })}<span>开始回顾</span>
        </button>
      </section>
      <section class="customer-review-recent-section" aria-labelledby="customer-review-recent-title">
        <div class="customer-review-section-head"><h2 id="customer-review-recent-title">最近回顾的客户</h2></div>
        <div id="customer-review-recent" class="customer-review-recent"><p class="customer-review-muted">正在加载…</p></div>
      </section>
      <section class="customer-review-history-section">
        <div class="customer-review-section-head"><h2>这位客户的回顾</h2><span id="customer-review-history-count"></span></div>
        <div id="customer-review-history" class="customer-review-history"><p class="customer-review-muted">选择客户后查看历史。</p></div>
      </section>
    </aside>
    <main id="customer-review-detail" class="customer-review-detail" aria-live="polite"></main>
  `
  renderDetail(root)
}

/** @param {HTMLElement} root */
function renderDetail(root) {
  const detail = root.querySelector("#customer-review-detail")
  if (!(detail instanceof HTMLElement)) return
  if (!currentReview) {
    detail.innerHTML = `<div class="customer-review-empty">
      <span class="customer-review-empty-icon">${icon("user", { size: 24 })}</span>
      <h2>回顾一段客户沟通</h2>
      <p>选择一位客户和时间范围，AI 会整理明确承诺，并标出对应的聊天时间。</p>
      <ol><li>只读取你选择的联系人和日期</li><li>结果只覆盖有微信文本依据的明确承诺</li><li>不会自动向联系人发送消息</li></ol>
    </div>`
    return
  }
  const review = currentReview
  if (review.status === "queued" || review.status === "analyzing") {
    const progress = reviewProgressCopy(review.status, review.createdAt)
    detail.innerHTML = `<div class="customer-review-progress">
      <span class="customer-review-spinner" aria-hidden="true"></span>
      <span class="customer-review-kicker">${progress.kicker}</span>
      <h2>正在回顾与 ${escapeHtml(review.contactDisplayName)} 的沟通</h2>
      <p>${dateLabel(review.rangeFrom)} — ${dateLabel(review.rangeTo)}</p>
      <small>正在限定范围内读取聊天并核对承诺。${escapeHtml(progress.detail)}</small>
    </div>`
    return
  }
  if (review.status === "failed") {
    const failure = reviewFailureCopy(review.errorCode)
    detail.innerHTML = `<div class="customer-review-empty customer-review-failed">
      <span class="customer-review-empty-icon">${icon("alert-02", { size: 24 })}</span>
      <h2>${escapeHtml(failure.title)}</h2><p>${escapeHtml(failure.body)}</p><small>${escapeHtml(failure.hint)}</small>
      <button class="customer-review-secondary" data-review-action="retry" type="button">${icon("refresh", { size: 16 })}重新分析</button>
    </div>`
    return
  }
  const ordered = orderReviewItems(review.items || [])
  const analysisIssues = review.analysisIssues || []
  const pendingCount = ordered.filter(item => item.aiStatus === "open" && item.reviewStatus === "unreviewed").length
  detail.innerHTML = `<div class="customer-review-result">
    <header class="customer-review-result-head">
      <div><span class="customer-review-kicker">${analysisIssues.length ? "部分完成" : "回顾完成"}</span><h2>${escapeHtml(review.contactDisplayName)}</h2><p>${dateLabel(review.rangeFrom)} — ${dateLabel(review.rangeTo)} · 已分析 ${review.sourceMessageCount} 条消息</p></div>
      <span class="customer-review-result-count"><strong>${pendingCount}</strong> 项待你核对</span>
    </header>
    <p class="customer-review-result-note">找到 ${ordered.length} 项有微信文本依据的明确承诺；“未发现完成证据”不等于未在其他渠道完成。</p>
    ${analysisIssues.length ? `<details class="customer-review-coverage"><summary>${icon("alert-02", { size: 15 })}${analysisIssues.length} 个聊天片段未通过核对，未纳入结果</summary><ul>${analysisIssues.map(issue => `<li>${escapeHtml(formatDateTime(issue.rangeFrom))} — ${escapeHtml(formatDateTime(issue.rangeTo))} · 已尝试 ${issue.attempts} 次</li>`).join("")}</ul></details>` : ""}
    ${ordered.length ? `<div class="customer-review-items">${ordered.map(item => itemHtml(item)).join("")}</div>` : `<div class="customer-review-empty customer-review-empty-inline">
      <span class="customer-review-empty-icon">${icon(analysisIssues.length ? "alert-02" : "checkmark-circle-02", { size: 24 })}</span><h2>${analysisIssues.length ? "已完成部分分析，暂未生成可核对承诺" : "没有发现明确的待核对承诺"}</h2><p>${analysisIssues.length ? "未通过核对的聊天片段没有被纳入结果；你可以查看覆盖范围，或缩短对应时间段后重新分析。" : "在这段时间的聊天里，AI 没有找到同时具备明确行动和微信文本依据的承诺。"}</p></div>`}
  </div>`
}

/** @param {ReviewItem} item */
function itemHtml(item) {
  const text = item.correctedText || item.commitment
  const statusLabel = item.reviewStatus === "confirmed"
    ? (item.aiStatus === "completed" ? "已确认完成" : "仍待处理")
    : { unreviewed: "待你核对", corrected: "已修订，待确认", completed_elsewhere: "已通过其他方式完成", rejected: "不是承诺", ignored: "不再跟进" }[item.reviewStatus]
  const evidence = (item.evidence || []).map(evidenceHtml).join("")
  const decided = item.reviewStatus !== "unreviewed" && item.reviewStatus !== "corrected"
  const completionActions = item.aiStatus === "open"
    ? `<button type="button" data-item-action="confirm">${icon("checkmark-circle-02", { size: 15 })}仍待处理</button>
      <button type="button" data-item-action="complete-elsewhere">已通过其他方式完成</button>`
    : `<button type="button" data-item-action="confirm">${icon("checkmark-circle-02", { size: 15 })}确认已完成</button>`
  const reviewActions = item.reviewStatus === "corrected"
    ? `<span class="customer-review-completion-prompt">文字已修改，请确认这项现在的处理状态：</span>${completionActions}`
    : item.aiStatus === "open"
      ? `${completionActions}
      <button type="button" data-item-action="edit">修改</button>
      <button type="button" data-item-action="reject">不是承诺</button>
      <button type="button" data-item-action="ignore">不再跟进</button>`
    : `${completionActions}
      <button type="button" data-item-action="edit">修改</button>
      <button type="button" data-item-action="reject">不是承诺</button>
      <button type="button" data-item-action="ignore">不再跟进</button>`
  return `<article class="customer-review-item${item.aiStatus === "completed" ? " is-completed" : ""}" data-source-key="${escapeHtml(item.sourceKey)}">
    <div class="customer-review-item-top"><span class="customer-review-item-state">${item.aiStatus === "open" ? "微信中未发现完成证据" : "微信中有完成迹象"}</span><span class="customer-review-review-status is-${item.reviewStatus}">${statusLabel}</span></div>
    <h3>${escapeHtml(text)}</h3>
    <div class="customer-review-item-meta">${item.dueDate ? `<span>约定时间 ${escapeHtml(dateLabel(item.dueDate))}</span>` : "<span>未提及明确日期</span>"}<span>${item.confidence === "high" ? "高可信" : "中等可信"}</span></div>
    <details class="customer-review-evidence" data-evidence-source-key="${escapeHtml(item.sourceKey)}"><summary>${icon("link-03", { size: 15 })}聊天依据 · ${item.evidence?.length || 0} 条 · 展开核对原文</summary><ul>${evidence || "<li><span>暂无可展示的证据时间</span></li>"}</ul></details>
    <div class="customer-review-edit" hidden><label>把这项承诺修改为</label><textarea maxlength="500">${escapeHtml(text)}</textarea><div><button type="button" data-item-action="save-edit">保存修改</button><button type="button" data-item-action="cancel-edit">取消</button></div></div>
    <div class="customer-review-item-actions"${decided ? " hidden" : ""}>
      ${reviewActions}
    </div>
  </article>`
}

/** @param {ReviewEvidence} evidence */
function evidenceHtml(evidence) {
  const role = evidence.role === "commitment" ? "承诺依据" : evidence.role === "completion" ? "完成迹象" : "时间依据"
  const speaker = evidence.senderSide === "me" ? "我" : "客户"
  const content = typeof evidence.text === "string"
    ? escapeHtml(evidence.text || "[非文本消息]")
    : "原始聊天内容将在展开后读取。"
  return `<li><div><span>${speaker} · ${formatDateTime(evidence.messageTime)}</span><p>${content}</p></div><em>${role}</em></li>`
}

/** @param {HTMLElement} root @param {CustomerContact[]} contacts */
function renderContacts(root, contacts) {
  const box = root.querySelector("#customer-review-contact-results")
  if (!(box instanceof HTMLElement)) return
  box.hidden = false
  box.innerHTML = contacts.length ? contacts.map(contact => `<button type="button" data-contact-id="${escapeHtml(contact.id)}">
    <span class="customer-review-contact-avatar">${escapeHtml(contact.displayName.slice(0, 1) || "客")}</span>
    <span><strong>${escapeHtml(contact.displayName)}</strong><small>${escapeHtml(contact.preview || (contact.lastMessageAt ? `最近沟通 ${formatDateTime(contact.lastMessageAt)}` : "微信联系人"))}</small></span>
  </button>`).join("") : `<p class="customer-review-muted">没有找到匹配的单聊联系人。</p>`
}

/** @param {HTMLElement} root */
function renderSelectedContact(root) {
  const selected = root.querySelector("#customer-review-selected-contact")
  const submit = /** @type {HTMLButtonElement|null} */ (root.querySelector("#customer-review-submit"))
  if (!(selected instanceof HTMLElement)) return
  selected.hidden = !selectedContact
  selected.innerHTML = selectedContact ? `<span class="customer-review-contact-avatar">${escapeHtml(selectedContact.displayName.slice(0, 1) || "客")}</span><span><strong>${escapeHtml(selectedContact.displayName)}</strong><small>已选择</small></span><button type="button" data-action="clear-contact" aria-label="重新选择">${icon("cancel-01", { size: 15 })}</button>` : ""
  if (submit) submit.disabled = !selectedContact
}

/** @param {HTMLElement} root */
function renderHistory(root) {
  const box = root.querySelector("#customer-review-history")
  const count = root.querySelector("#customer-review-history-count")
  if (!(box instanceof HTMLElement)) return
  if (count) count.textContent = history.length ? `${history.length} 次` : ""
  box.innerHTML = history.length ? history.map(review => `<button type="button" data-review-id="${escapeHtml(review.id)}" class="${currentReview?.id === review.id ? "is-active" : ""}">
    <span><strong>${dateLabel(review.rangeFrom)} — ${dateLabel(review.rangeTo)}</strong><small>${review.status === "ready" ? `${review.items?.filter(item => item.aiStatus === "open" && item.reviewStatus === "unreviewed").length || 0} 项待核对` : review.status === "failed" ? "分析失败" : "分析中"}</small></span><time>${formatDateTime(review.createdAt)}</time>
  </button>`).join("") : `<p class="customer-review-muted">这位客户还没有历史回顾。</p>`
}

/** @param {HTMLElement} root @param {RecentReviewContact[]} contacts */
function renderRecentReviewContacts(root, contacts) {
  const box = root.querySelector("#customer-review-recent")
  if (!(box instanceof HTMLElement)) return
  const statusLabel = { queued: "等待分析", analyzing: "分析中", ready: "已回顾", failed: "上次未完成" }
  box.innerHTML = contacts.length ? contacts.map(contact => `<button type="button" data-recent-contact-id="${escapeHtml(contact.contactId)}" data-recent-contact-name="${escapeHtml(contact.displayName)}">
    <span class="customer-review-contact-avatar">${escapeHtml(contact.displayName.slice(0, 1) || "客")}</span>
    <span><strong>${escapeHtml(contact.displayName)}</strong><small>${contact.reviewCount} 次回顾 · ${statusLabel[contact.lastStatus]} · ${formatDateTime(contact.lastReviewAt)}</small></span>
  </button>`).join("") : `<p class="customer-review-muted">还没有可打开的客户回顾。</p>`
}

/** @param {HTMLElement} root */
async function loadRecentReviewContacts(root) {
  const box = root.querySelector("#customer-review-recent")
  if (!(box instanceof HTMLElement)) return
  try {
    const response = /** @type {{contacts:RecentReviewContact[]}} */ (await customerReviewApi("GET", "/v1/customer-review/recent"))
    renderRecentReviewContacts(root, response.contacts || [])
  } catch (error) {
    box.innerHTML = `<p class="customer-review-inline-error">${escapeHtml(safeError(error))}</p>`
  }
}

/** @param {HTMLElement} root @param {CustomerContact} contact */
function selectContact(root, contact) {
  selectedContact = contact
  history = []
  const search = /** @type {HTMLInputElement|null} */ (root.querySelector("#customer-review-search"))
  if (search) { search.value = ""; search.hidden = true }
  const results = root.querySelector("#customer-review-contact-results")
  if (results instanceof HTMLElement) results.hidden = true
  renderSelectedContact(root)
  loadHistory(root)
}

/** @param {HTMLElement} root @param {string} query */
async function searchContacts(root, query) {
  const seq = ++searchSeq
  if (!query.trim()) {
    const box = root.querySelector("#customer-review-contact-results")
    if (box instanceof HTMLElement) box.hidden = true
    return
  }
  const box = root.querySelector("#customer-review-contact-results")
  if (box instanceof HTMLElement) { box.hidden = false; box.innerHTML = `<p class="customer-review-muted">正在查找…</p>` }
  try {
    const response = /** @type {{contacts:CustomerContact[]}} */ (await customerReviewApi("GET", `/v1/customer-review/contacts?query=${encodeURIComponent(query.trim())}`))
    if (seq !== searchSeq) return
    renderContacts(root, response.contacts || [])
  } catch (error) {
    if (seq !== searchSeq || !(box instanceof HTMLElement)) return
    box.innerHTML = `<p class="customer-review-inline-error">${escapeHtml(safeError(error))}</p>`
  }
}

/** @param {HTMLElement} root */
async function loadHistory(root) {
  if (!selectedContact) return
  const contactId = selectedContact.id
  const box = root.querySelector("#customer-review-history")
  if (box instanceof HTMLElement) box.innerHTML = `<p class="customer-review-muted">正在加载…</p>`
  try {
    const response = /** @type {{reviews:CustomerReview[]}} */ (await customerReviewApi("GET", `/v1/customer-review/history?contact_id=${encodeURIComponent(contactId)}`))
    if (selectedContact?.id !== contactId) return
    history = response.reviews || []
    renderHistory(root)
  } catch (error) {
    if (box instanceof HTMLElement) box.innerHTML = `<p class="customer-review-inline-error">${escapeHtml(safeError(error))}</p>`
  }
}

/** @param {HTMLElement} root @param {string} id */
async function loadReview(root, id) {
  const seq = ++detailSeq
  try {
    const response = /** @type {{review:CustomerReview}} */ (await customerReviewApi("GET", `/v1/customer-review?id=${encodeURIComponent(id)}`))
    if (seq !== detailSeq) return
    currentReview = response.review
    renderDetail(root)
    renderHistory(root)
    if (currentReview.status === "queued" || currentReview.status === "analyzing") schedulePoll(root, id)
    else stopCustomerReviewPolling()
  } catch (error) {
    if (seq !== detailSeq) return
    stopCustomerReviewPolling()
    const detail = root.querySelector("#customer-review-detail")
    if (detail instanceof HTMLElement) detail.innerHTML = `<div class="customer-review-empty"><h2>无法打开这次回顾</h2><p>${escapeHtml(safeError(error))}</p></div>`
  }
}

/** @param {HTMLElement} root @param {string} id */
function schedulePoll(root, id) {
  stopCustomerReviewPolling()
  pollTimer = setTimeout(() => {
    if (!root.hidden && currentReview?.id === id) loadReview(root, id)
  }, 1500)
}

/** @param {HTMLElement} root */
async function createReview(root) {
  if (!selectedContact) return
  const from = /** @type {HTMLInputElement|null} */ (root.querySelector("#customer-review-from"))?.value || ""
  const to = /** @type {HTMLInputElement|null} */ (root.querySelector("#customer-review-to"))?.value || ""
  const error = root.querySelector("#customer-review-form-error")
  const submit = /** @type {HTMLButtonElement|null} */ (root.querySelector("#customer-review-submit"))
  if (!from || !to || from > to) {
    if (error instanceof HTMLElement) { error.hidden = false; error.textContent = "开始日期不能晚于结束日期。" }
    return
  }
  if (error instanceof HTMLElement) error.hidden = true
  if (submit) { submit.disabled = true; submit.querySelector("span")?.replaceChildren("正在创建…") }
  try {
    const response = /** @type {{id:string,status:'queued'}} */ (await customerReviewApi("POST", "/v1/customer-review", { contact_id: selectedContact.id, contact_display_name: selectedContact.displayName, range_from: from, range_to: to }))
    currentReview = { id: response.id, contactId: selectedContact.id, contactDisplayName: selectedContact.displayName, rangeFrom: from, rangeTo: to, status: "queued", sourceMessageCount: 0, createdAt: new Date().toISOString(), items: [] }
    renderDetail(root)
    schedulePoll(root, response.id)
    loadHistory(root)
    loadRecentReviewContacts(root)
  } catch (err) {
    if (error instanceof HTMLElement) { error.hidden = false; error.textContent = safeError(err) }
  } finally {
    if (submit) { submit.disabled = false; submit.querySelector("span")?.replaceChildren("开始回顾") }
  }
}

/** @param {HTMLElement} root @param {HTMLElement} card @param {string} action */
async function reviewItem(root, card, action) {
  if (!currentReview) return
  const sourceKey = card.dataset.sourceKey
  if (!sourceKey) return
  if (action === "edit") {
    const editor = card.querySelector(".customer-review-edit")
    const actions = card.querySelector(".customer-review-item-actions")
    if (editor instanceof HTMLElement) editor.hidden = false
    if (actions instanceof HTMLElement) actions.hidden = true
    card.querySelector("textarea")?.focus()
    return
  }
  if (action === "cancel-edit") {
    const editor = card.querySelector(".customer-review-edit")
    const actions = card.querySelector(".customer-review-item-actions")
    if (editor instanceof HTMLElement) editor.hidden = true
    if (actions instanceof HTMLElement) actions.hidden = false
    return
  }
  const status = action === "save-edit" ? "corrected"
    : action === "confirm" ? "confirmed"
      : action === "complete-elsewhere" ? "completed_elsewhere"
        : action === "reject" ? "rejected" : "ignored"
  const corrected = action === "save-edit" ? /** @type {HTMLTextAreaElement|null} */ (card.querySelector("textarea"))?.value.trim() : undefined
  if (action === "save-edit" && !corrected) return
  card.classList.add("is-saving")
  try {
    const response = /** @type {{review:CustomerReview}} */ (await customerReviewApi("POST", "/v1/customer-review/item", { id: currentReview.id, source_key: sourceKey, status, ...(corrected ? { corrected_text: corrected } : {}) }))
    currentReview = response.review
    renderDetail(root)
    history = history.map(review => review.id === currentReview?.id ? currentReview : review)
    renderHistory(root)
  } catch (error) {
    card.classList.remove("is-saving")
    const actions = card.querySelector(".customer-review-item-actions")
    if (actions instanceof HTMLElement) { actions.hidden = false; actions.insertAdjacentHTML("beforeend", `<span class="customer-review-inline-error">${escapeHtml(safeError(error))}</span>`) }
  }
}

/** @param {HTMLElement} root @param {HTMLDetailsElement} details */
async function loadEvidence(root, details) {
  const sourceKey = details.dataset.evidenceSourceKey
  if (!currentReview || !sourceKey || details.dataset.evidenceLoaded === "true" || details.dataset.evidenceLoading === "true") return
  const reviewId = currentReview.id
  const list = details.querySelector("ul")
  if (!(list instanceof HTMLElement)) return
  details.dataset.evidenceLoading = "true"
  list.innerHTML = "<li class=\"customer-review-evidence-loading\">正在读取这几条原始聊天…</li>"
  try {
    const response = /** @type {{evidence:ReviewEvidence[]}} */ (await customerReviewApi("GET", `/v1/customer-review/evidence?id=${encodeURIComponent(reviewId)}&source_key=${encodeURIComponent(sourceKey)}`))
    if (currentReview?.id !== reviewId) return
    const item = currentReview.items.find(candidate => candidate.sourceKey === sourceKey)
    if (item) item.evidence = response.evidence
    list.innerHTML = response.evidence.length
      ? response.evidence.map(evidenceHtml).join("")
      : "<li class=\"customer-review-evidence-loading\">这次回顾对应的原始聊天暂时不可读取。</li>"
    details.dataset.evidenceLoaded = "true"
  } catch {
    list.innerHTML = "<li class=\"customer-review-evidence-loading\">原始聊天内容暂时不可读取，请稍后重试。</li>"
  } finally {
    delete details.dataset.evidenceLoading
  }
}

/** @param {HTMLElement} root */
function wire(root) {
  const search = /** @type {HTMLInputElement|null} */ (root.querySelector("#customer-review-search"))
  search?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => searchContacts(root, search.value), 250)
  })
  root.querySelector("#customer-review-contact-results")?.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-contact-id]") : null
    if (!(button instanceof HTMLElement)) return
    const name = button.querySelector("strong")?.textContent || "客户"
    selectContact(root, { id: button.dataset.contactId || "", displayName: name, kind: "private" })
  })
  root.querySelector("#customer-review-recent")?.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-recent-contact-id]") : null
    if (!(button instanceof HTMLElement)) return
    selectContact(root, {
      id: button.dataset.recentContactId || "",
      displayName: button.dataset.recentContactName || "客户",
      kind: "private",
    })
  })
  root.querySelector("#customer-review-selected-contact")?.addEventListener("click", event => {
    const clear = event.target instanceof Element ? event.target.closest("[data-action='clear-contact']") : null
    if (!clear) return
    selectedContact = null; history = []
    if (search) { search.hidden = false; search.focus() }
    renderSelectedContact(root); renderHistory(root)
  })
  root.querySelector("#customer-review-submit")?.addEventListener("click", () => createReview(root))
  root.querySelector("#customer-review-history")?.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-review-id]") : null
    if (button instanceof HTMLElement && button.dataset.reviewId) loadReview(root, button.dataset.reviewId)
  })
  root.querySelector("#customer-review-detail")?.addEventListener("toggle", event => {
    const details = event.target
    if (details instanceof HTMLDetailsElement && details.open) void loadEvidence(root, details)
  }, true)
  root.querySelector("#customer-review-detail")?.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    const retry = target?.closest("[data-review-action='retry']")
    if (retry && currentReview) {
      customerReviewApi("POST", "/v1/customer-review/run", { id: currentReview.id }).then(() => {
        if (!currentReview) return
        currentReview.status = "queued"; renderDetail(root); schedulePoll(root, currentReview.id)
      }).catch(error => console.error("customer review retry failed", error))
      return
    }
    const action = target?.closest("[data-item-action]")
    const card = action?.closest("[data-source-key]")
    if (action instanceof HTMLElement && card instanceof HTMLElement && action.dataset.itemAction) reviewItem(root, card, action.dataset.itemAction)
  })
}

/** Initialise once; no customer data is read until the user opens this view. */
/** @param {{api?: typeof invokeApi}} [options] */
export function initCustomerReviewPage(options = {}) {
  if (typeof options.api === "function") api = options.api
  const root = document.getElementById("customer-review-root")
  if (!root) return
  if (root.dataset.ready === "true") {
    if (currentReview && (currentReview.status === "queued" || currentReview.status === "analyzing")) schedulePoll(root, currentReview.id)
    loadRecentReviewContacts(root)
    if (selectedContact) loadHistory(root)
    return
  }
  root.dataset.ready = "true"
  renderShell(root)
  wire(root)
  loadRecentReviewContacts(root)
}

export function stopCustomerReviewPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}
