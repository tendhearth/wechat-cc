/** @type {ReturnType<typeof import('../../desktop/src/shared/task-entry-contract.js').createEntryContract>} */
var eContract
// 新交办与任务里的「接着说」各存各的。pending 保留送出时的原文，不能随编辑改变。
var eStorage = "cc.phone.entry.v1:" + (REMOTE ? REMOTE.id : location.host)
var eState = null, eOptions = null, eMounted = false, eViewEpoch = 0, eOptionsSeq = 0, eBusy = {}, eAttachments = null, eMaterialQuiet = false
var E_PENDING_LIMIT = 8
function eEmptyDraft(revision) { return { text: "", target: { kind: "managed" }, providerId: "", executionMode:"auto", requestId: null, revision: revision || 0, draftId:mUuid(), materialSignature:"[]" } }
function eLoad() {
  if (eState) return
  try {
    var saved = JSON.parse(localStorage.getItem(eStorage) || "null")
    if (saved && saved.version === 1 && saved.draft && typeof saved.draft.text === "string" && saved.draft.target && Array.isArray(saved.pending)) eState = saved
  } catch (e) {}
  if (!eState) eState = { version: 1, draft: eEmptyDraft(0), pending: [], last: null, expired:[] }
  if (!Array.isArray(eState.expired)) eState.expired = []
  if (!Array.isArray(eState.rejected)) eState.rejected = []
  if (!eState.draft.draftId) eState.draft.draftId = mUuid()
  if (!eState.draft.materialSignature) eState.draft.materialSignature = "[]"
}
function eSave() {
  try { localStorage.setItem(eStorage, JSON.stringify(eState)); return true }
  catch (e) { eNotice("这台手机暂时无法保存草稿，请先留好原文，恢复存储后再交办。"); return false }
}
function eNotice(message) { document.getElementById("entry-notice").textContent = message }
function eText() { return /** @type {HTMLTextAreaElement} */ (document.getElementById("entry-text")) }
function eInput() {
  var draft = eState.draft, input = { requestId: draft.requestId, text: draft.text, target: Object.assign({}, draft.target) }
  if (draft.providerId) input["providerId"] = draft.providerId
  if(draft.target.kind === "project") input["executionMode"] = draft.executionMode || "auto"
  var ids = eAttachments ? eAttachments.readyIds() : []
  if (ids.length) { input["draftId"] = draft.draftId; input["attachmentIds"] = ids }
  return input
}
function eSame(record) {
  return eState.draft.revision === record.revision && (record.materialSignature || "[]") === eState.draft.materialSignature && JSON.stringify(eInput()) === JSON.stringify(record.input)
}
function eMountMaterials() {
  if (eAttachments) eAttachments.dispose()
  eAttachments = createPhoneAttachments({ draftId:eState.draft.draftId, onChange:function(){
    if (eMaterialQuiet) return
    var signature = eAttachments.signature()
    if (signature !== eState.draft.materialSignature) { eState.draft.materialSignature = signature; eState.draft.revision++ }
    eSave(); eUpdate()
  } })
  eAttachments.mount(document.getElementById("entry-attachments"))
  var signature = eAttachments.signature()
  if (signature !== eState.draft.materialSignature) { eState.draft.materialSignature = signature; eState.draft.revision++ }
  eSave()
}
function eDetachMaterials() {
  if (!eAttachments.items().some(function(item){ return item.frozen })) return false
  eState.draft.draftId = mUuid(); eState.draft.materialSignature = "[]"
  eMountMaterials()
  eNotice("已附材料属于上一提交。这份新草稿可以重新添加材料。")
  return true
}
function eRecordMaterials(record, action) {
  if (!record.input.attachmentIds || !record.input.attachmentIds.length) return
  var current = record.input.draftId === eState.draft.draftId
  var control = current ? eAttachments : createPhoneAttachments({draftId:record.input.draftId})
  eMaterialQuiet = true
  try { control[action](record.input.attachmentIds) }
  finally { eMaterialQuiet = false; if (!current) control.dispose() }
}
function eCurrentRecord() {
  var pending = eState.pending.find(function(p){ return p.input.requestId === eState.draft.requestId })
  return pending || (eState.last && eState.last.input.requestId === eState.draft.requestId ? eState.last : null)
}
function eSelectionError() {
  if (!eOptions) return "暂时连不上 CC。草稿留在这里，连接恢复后再试。"
  if (eOptions.reason && eOptions.reason.code === "invalid_entry_owner") return "草稿已保留。请先在桌面配置主人身份，再回来交给 CC。"
  var draft = eState.draft
  var project = draft.target.kind === "project" && eOptions.projects.find(function(p){ return p.id === draft.target.projectId })
  if (draft.target.kind === "project" && !project) return "之前选择的项目现在不可用，请在更多选择里重新选择。草稿已保留。"
  if (draft.providerId && !eOptions.providers.some(function(p){ return p.id === draft.providerId && p.available })) return "之前选择的执行者现在不可用，请在更多选择里重新选择。草稿已保留。"
  var providerId = draft.providerId || (project && project.providerId) || eOptions.defaultProviderId
  if (!eOptions.providers.some(function(p){ return p.id === providerId && p.available })) {
    return eOptions.providers.some(function(p){ return p.available }) ? "草稿已保留。请在更多选择里选一位已连接的执行者，或到桌面连接原来的执行者。" : "草稿已保留。请在桌面工作台连接一位执行者，再回来交给 CC。"
  }
  var provider = eOptions.providers.find(function(p){ return p.id === providerId })
  if (eAttachments && eAttachments.items().length && provider.capabilities && provider.capabilities.features && provider.capabilities.features.attachments === false) return "这位执行者暂时不能接收材料，请在更多选择里重新选择。材料和草稿都还在。"
  return ""
}
function eUpdate() {
  document.getElementById("entry-location").hidden = eState.draft.target.kind !== "project"
  var record = eCurrentRecord(), same = record && eSame(record), button = /** @type {HTMLButtonElement} */ (document.getElementById("entry-submit"))
  button.textContent = same ? (eBusy[record.input.requestId] ? "正在确认是否收到…" : "确认是否收到") : (eState.draft.requestId ? "交办这件新事" : "交给 CC")
  button.disabled = same ? !!eBusy[record.input.requestId] : !!eSelectionError() || (!eState.draft.text.trim() && !eAttachments.readyIds().length) || !eAttachments.isReady() || !!eContract.entryContentError(eState.draft) || eState.pending.length >= E_PENDING_LIMIT
  document.getElementById("entry-another").hidden = !eAttachments.items().some(function(item){ return item.frozen })
  document.getElementById("entry-count").textContent = eContract.entryContentError(eState.draft) ? "要求有些长，请缩减到 " + eContract.ENTRY_LIMITS.text.toLocaleString("en-US") + " 字以内；原文还在。" : ""
  document.getElementById("entry-selection").textContent = eState.draft.target.kind === "managed" ? "CC 会为这件事安排一处独立的工作位置。" : (eState.draft.executionMode === "project" ? "会在原目录里工作。" : "Git 项目默认在独立副本里做，当前未提交内容不会带入；非 Git 项目沿用原目录。无法准备时会说明原因，草稿和材料会保留。")
}
function eChoices() {
  var draft = eState.draft, project = /** @type {HTMLSelectElement} */ (document.getElementById("entry-project")), provider = /** @type {HTMLSelectElement} */ (document.getElementById("entry-provider"))
  var projects = eOptions ? eOptions.projects : [], providers = eOptions ? eOptions.providers.filter(function(p){ return p.available }) : []
  var missingProject = draft.target.kind === "project" && !projects.some(function(p){ return p.id === draft.target.projectId })
  var missingProvider = draft.providerId && !providers.some(function(p){ return p.id === draft.providerId })
  project.innerHTML = '<option value="">由 CC 安排</option>' + (missingProject ? '<option value="__missing" disabled>原项目暂不可用，请重新选择</option>' : '') + projects.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>' }).join("")
  provider.innerHTML = '<option value="">按项目或 CC 的默认选择</option>' + (missingProvider ? '<option value="__missing" disabled>原执行者暂不可用，请重新选择</option>' : '') + providers.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.displayName) + '</option>' }).join("")
  project.value = missingProject ? "__missing" : (draft.target.projectId || "")
  var locationChoice = /** @type {HTMLSelectElement} */(document.getElementById("entry-execution-mode"))
  locationChoice.value = draft.executionMode || "auto"
  provider.value = missingProvider ? "__missing" : (draft.providerId || "")
  eUpdate()
}
function eHistory() {
  var html = eState.pending.map(function(p){
    return '<div class="entry-pending"><p>' + esc(p.input.text.slice(0, 100) || "带材料的交办") + '</p>' + ((p.materials || []).length ? '<small>已附材料：' + esc(p.materials.map(function(a){ return a.name }).join("、")) + '</small>' : '') + '<small>' + esc(p.error || "正在确认是否收到，原文已保存。") + '</small><button type="button" data-entry-retry="' + esc(p.input.requestId) + '"' + (eBusy[p.input.requestId] ? ' disabled' : '') + '>确认这一件</button></div>'
  }).join("")
  if (eState.last) html += '<div class="entry-received"><span>CC 已收到：' + esc(eState.last.input.text.slice(0, 80) || "带材料的交办") + '</span><button type="button" data-entry-open="' + esc(eState.last.receipt.matterId) + '">查看这件事 ↗</button></div>'
  html += eState.expired.concat(eState.rejected).map(function(p){
    return '<details class="entry-pending"><summary>' + (p.rejection ? '一份需要调整的交办' : '一份已到期的交办') + ' · 原要求还在</summary><p>' + esc(p.input.text || "带材料的交办") + '</p><small>这次请求没有被接受。' + (p.rejection ? esc(eRejectionMessage(p.rejection)) : '') + ((p.materials || []).length ? '原材料：' + esc(p.materials.map(function(a){ return a.name }).join("、")) + '。需要重新选择材料。' : '') + '</small><button type="button" data-entry-recover="' + esc(p.input.requestId) + '">恢复这份要求</button><button type="button" data-entry-forget="' + esc(p.input.requestId) + '">移除旧草稿</button></details>'
  }).join("")
  document.getElementById("entry-history").innerHTML = html
  if (eState.pending.length >= E_PENDING_LIMIT) eNotice("还有几件交办正在确认。先点下方确认一件，再交办新的；草稿会留在这里。")
}
function eMount() {
  eLoad()
  if (eMounted) return
  var root = document.getElementById("entry-root")
  if (!root) return
  root.innerHTML = '<form id="entry-form" class="entry-card"><label for="entry-text" class="entry-heading">有件事，想交给 CC</label><p class="entry-intro">说说你想做什么，我们从这里开始。</p><textarea id="entry-text" rows="3" placeholder="比如，帮我整理一份周末出游清单…" aria-describedby="entry-count entry-notice"></textarea><p id="entry-count" class="entry-hint"></p><div id="entry-attachments"></div><details class="entry-more"><summary>更多选择</summary><label for="entry-project">在哪儿做<select id="entry-project"></select></label><label id="entry-location" for="entry-execution-mode" hidden>执行位置<select id="entry-execution-mode"><option value="auto">独立副本（Git 项目默认）</option><option value="project">原目录</option></select></label><label for="entry-provider">交给谁<select id="entry-provider"></select></label><p id="entry-selection" class="entry-hint"></p></details><div class="entry-actions"><button id="entry-submit" type="submit">交给 CC</button><button id="entry-another" type="button" hidden>另写一件</button><button id="entry-refresh" type="button">刷新连接</button></div><p id="entry-notice" role="status" aria-live="polite"></p></form><div id="entry-history"></div>'
  document.getElementById("entry-execution-mode").addEventListener("change",function(event){eState.draft.executionMode=/** @type {HTMLSelectElement} */(event.target).value === "project" ? "project" : "auto"; eState.draft.revision++;eSave();eUpdate()})
  eMounted = true
  eText().value = eState.draft.text
  eText().addEventListener("input", function(){ eDetachMaterials(); eState.draft.text = eText().value; eState.draft.revision++; eSave(); eUpdate() })
  document.getElementById("entry-another").addEventListener("click", function(){ eDetachMaterials(); eState.draft.text = ""; eState.draft.requestId = null; eState.draft.revision++; eText().value = ""; eSave(); eUpdate(); eText().focus() })
  document.getElementById("entry-project").addEventListener("change", function(event){
    var value = /** @type {HTMLSelectElement} */ (event.target).value
    if (value === "__missing") return
    var detached = eDetachMaterials()
    eState.draft.target = value ? { kind: "project", projectId: value } : { kind: "managed" }
    eState.draft.revision++; eSave(); eUpdate(); if (!detached || eSelectionError()) eNotice(eSelectionError())
  })
  document.getElementById("entry-provider").addEventListener("change", function(event){
    var value = /** @type {HTMLSelectElement} */ (event.target).value
    if (value === "__missing") return
    var detached = eDetachMaterials()
    eState.draft.providerId = value; eState.draft.revision++; eSave(); eUpdate(); if (!detached || eSelectionError()) eNotice(eSelectionError())
  })
  document.getElementById("entry-form").addEventListener("submit", function(event){ event.preventDefault(); void submitEntry() })
  document.getElementById("entry-refresh").addEventListener("click", function(){ void restoreEntry() })
  document.getElementById("entry-history").addEventListener("click", function(event){
    var target = /** @type {HTMLElement} */ (event.target), button = /** @type {HTMLButtonElement} */ (target.closest("button"))
    if (!button) return
    if (button.dataset.entryRetry) {
      var record = eState.pending.find(function(p){ return p.input.requestId === button.dataset.entryRetry })
      if (record) void eSend(record, true, false)
    }
    if (button.dataset.entryOpen) { eViewEpoch++; mobilePane("matters"); openMatter(button.dataset.entryOpen) }
    if (button.dataset.entryRecover) {
      var expired = eState.expired.concat(eState.rejected).find(function(p){ return p.input.requestId === button.dataset.entryRecover })
      if (!expired) return
      if ((eState.draft.text.trim() && eState.draft.text !== expired.input.text) || eAttachments.items().length) { eNotice("当前还有新草稿，先处理它再恢复旧要求。原文保留在下方。"); return }
      eState.draft = Object.assign(eEmptyDraft(eState.draft.revision + 1), {text:expired.input.text,target:Object.assign({},expired.input.target),providerId:expired.input.providerId || "",executionMode:expired.input.executionMode || "auto"})
      eText().value = eState.draft.text; eMountMaterials(); eChoices(); eNotice("原要求已放回草稿，请重新选择材料，再交给 CC。"); eText().focus()
    }
    if (button.dataset.entryForget) {
      eState.expired = eState.expired.filter(function(p){ return p.input.requestId !== button.dataset.entryForget })
      eState.rejected = eState.rejected.filter(function(p){ return p.input.requestId !== button.dataset.entryForget })
      eSave(); eHistory()
    }
  })
  document.querySelectorAll("nav button[data-p]").forEach(function(button){ button.addEventListener("click", function(){ eViewEpoch++ }) })
  document.addEventListener("visibilitychange", function(){ if (document.hidden) eViewEpoch++ })
  window.addEventListener("pagehide", function(){ eViewEpoch++ })
  window.addEventListener("offline", function(){ eViewEpoch++ })
  eMountMaterials(); eChoices(); eHistory()
}
function eRequest(path, opts) {
  var timer
  return Promise.race([api(path, opts).then(function(r){
    return r.json().then(function(body){
      if (r.status >= 400 || !body.ok) throw Object.assign(new Error(body.error || "unavailable"), { status: r.status })
      return body
    })
  }), new Promise(function(_resolve, reject){ timer = setTimeout(function(){ reject(new Error("timeout")) }, 15000) })]).finally(function(){ clearTimeout(timer) })
}
function eLoadOptions() {
  var seq = ++eOptionsSeq
  return eRequest("/m/api/entry/options", undefined).then(function(options){
    if (seq !== eOptionsSeq) return
    eOptions = options; eChoices()
    var error = eSelectionError()
    if (error) eNotice(error)
    else if (!eState.pending.length) eNotice("")
  }).catch(function(){ if (seq === eOptionsSeq) { eOptions = null; eUpdate(); eNotice(eSelectionError()) } })
}
function eReceipt(record, result, navigation) {
  var receipt = result && result.receipt
  if (!receipt || receipt.requestId !== record.input.requestId || !/^[a-f0-9]{8}$/.test(receipt.taskId) || receipt.matterId !== receipt.taskId || !receipt.runId || !Number.isFinite(receipt.acceptedAt) || !result.task || result.task.id !== receipt.taskId) throw new Error("receipt_mismatch")
  var same = eSame(record)
  eState.pending = eState.pending.filter(function(p){ return p.input.requestId !== receipt.requestId })
  if (!eState.last || eState.last.receipt.acceptedAt <= receipt.acceptedAt) eState.last = { input: record.input, revision: record.revision, receipt: receipt, materials:record.materials, materialSignature:record.materialSignature }
  eRecordMaterials(record, "acknowledge")
  if (same) { eState.draft = eEmptyDraft(eState.draft.revision + 1); eText().value = ""; eMountMaterials(); eChoices() }
  eSave(); eHistory(); eUpdate()
  eNotice(same ? "CC 已收到，随时可以查看这件事。" : "上一件交办 CC 已收到，这份新草稿已保留。")
  if (same && navigation && navigation.epoch === eViewEpoch && navigation.matter === mCurrent && navigation.seq === mSeq && !document.hidden) {
    eViewEpoch++; mobilePane("matters"); openMatter(receipt.matterId)
  }
}
function eCheck(record) {
  return eRequest("/m/api/matter/create-receipt?requestId=" + encodeURIComponent(record.input.requestId), undefined)
    .catch(function(error){ if (error.status === 404) return null; throw error })
}
function eRejectionMessage(code) {
  if (/attachment/.test(code)) return "这位执行者暂时不能接收这份材料，请调整材料或在更多选择里换一位执行者。"
  if (code === "unattended_ack_required") return "请先在桌面确认这位执行者的运行方式，再回来交办。"
  return eContract.entryRejectionMessage(code)
}
/** @param {string} [sentAs] 发这一趟时用的令牌 */
function eFailure(record, error, creating, sentAs) {
  var kind = eContract.entryFailureKind(error.message, {surface:"phone", method:creating ? "POST" : "GET", status:error.status})
  var expired = kind === "expired", rejected = kind === "rejected"
  if (expired || rejected) {
    eState.pending = eState.pending.filter(function(p){ return p.input.requestId !== record.input.requestId })
    var history = expired ? eState.expired : eState.rejected
    if (rejected) record.rejection = error.message
    if (!history.some(function(p){ return p.input.requestId === record.input.requestId })) history.push(record)
    eRecordMaterials(record, "acknowledge")
    if (eState.draft.requestId === record.input.requestId) {
      if (eState.draft.draftId === record.input.draftId) { eState.draft.draftId = mUuid(); eState.draft.materialSignature = "[]"; eMountMaterials() }
      eState.draft.requestId = null; eState.draft.revision++
    }
    eSave(); eHistory(); eUpdate()
    eNotice(expired ? "上一提交已到期，没有被接受。原要求已保留，请重新选择材料，再点击交给 CC。" : "这次交办没有被接受。" + eRejectionMessage(error.message) + "原要求和材料说明已保留。" + ((record.materials || []).length ? "请重新选择材料，再点击交给 CC。" : "")); return
  }
  var message = "正在确认是否收到。原文已保留，连接恢复后点“确认是否收到”，会继续核对同一件事。"
  if (error.message === "draft_storage") message = "这台手机暂时无法保存草稿，请先留好原文，恢复存储后再交办。"
  // 单次配对(plan 7a):这一趟在飞时刚配上、换了令牌,旧短令牌回 401/403 不说明连接失效 —— 保持「正在确认」,下一次核对用新令牌。
  else if (error.status === 401 || error.status === 403) { if (sentAs === T) message = "手机连接已失效，请从微信重新打开随身 CC。草稿与待确认交办已保留。" }
  else if (error.message === "creation_conflict") message = "这件交办的内容与先前不同，请先确认原交办；原文已保留。"
  else if (error.status >= 400 && error.status < 500) message = "这次交办尚未确认：" + error.message + "。请检查要求和执行位置，原文和材料已保留；重试会核对同一请求。"
  record.error = message; eSave(); eNotice(message); eHistory()
}
function eSend(record, retry, navigate) {
  if (eBusy[record.input.requestId]) return Promise.resolve()
  var navigation = navigate ? { epoch: eViewEpoch, matter: mCurrent, seq: mSeq } : null
  eBusy[record.input.requestId] = true; eUpdate(); eHistory(); eNotice("正在确认是否收到…")
  var sentAs = T
  var creating = false, lookup = retry ? eCheck(record) : Promise.resolve(null)
  return lookup.then(function(result){
    if (result) return result
    // 查询不到不是失败回执。只有用户主动确认才以原 requestId、原内容重试。
    if (!eSave()) throw new Error("draft_storage")
    eRecordMaterials(record, "freeze")
    creating = true
    return eRequest("/m/api/matter/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record.input) })
  }).then(function(result){ eReceipt(record, result, navigation) })
    .catch(function(error){ eFailure(record, error, creating, sentAs) })
    .finally(function(){ delete eBusy[record.input.requestId]; eUpdate(); eHistory() })
}
function openEntry() {
  eMount(); eViewEpoch++; mobilePane("matters")
  document.getElementById("entry-root").scrollIntoView({ behavior: "smooth", block: "center" })
  eText().focus()
  return eLoadOptions()
}
function submitEntry() {
  eMount()
  var record = eCurrentRecord()
  if (record && eSame(record)) return eSend(record, true, true)
  var error = eSelectionError()
  if (!error && !eAttachments.isReady()) error = "材料还没有准备好。可以继续写要求，等上传确认后再交给 CC。"
  if (!error && !eState.draft.text.trim() && !eAttachments.readyIds().length) error = "写一句要求，或者先添一份材料吧。"
  if (!error && eContract.entryContentError(eState.draft)) error = "要求有些长，请缩减到 " + eContract.ENTRY_LIMITS.text.toLocaleString("en-US") + " 字以内；原文还在。"
  if (!error && eState.pending.length >= E_PENDING_LIMIT) error = "还有几件交办正在确认，先确认一件再交办新的。草稿会留在这里。"
  if (error) { eNotice(error); return Promise.resolve() }
  // 此按钮在改写后明确显示「交办这件新事」；编辑本身不产生新身份。
  eState.draft.requestId = mUuid()
  record = { input: eInput(), revision: eState.draft.revision, materialSignature:eAttachments.signature(), materials:eAttachments.items().map(function(a){ return {id:a.id,name:a.name,mime:a.mime,size:a.size,sha256:a.sha256} }) }
  eState.pending.push(record)
  if (!eSave()) { eUpdate(); eHistory(); return Promise.resolve() }
  try { eRecordMaterials(record, "freeze") } catch (error) { eNotice(paMessage(error)); eUpdate(); eHistory(); return Promise.resolve() }
  return eSend(record, false, true)
}
function restoreEntry() {
  eMount()
  var checks = eState.pending.slice().map(function(record){
    if (eBusy[record.input.requestId]) return Promise.resolve()
    eBusy[record.input.requestId] = true
    var sentAs = T
    return eCheck(record).then(function(result){
      if (result) eReceipt(record, result, null)
      else eNotice("正在确认是否收到。原文还在，点“确认这一件”会用原请求再试。")
    }).catch(function(error){ eFailure(record, error, false, sentAs) })
      .finally(function(){ delete eBusy[record.input.requestId]; eUpdate(); eHistory() })
  })
  eUpdate(); eHistory()
  return Promise.all([eLoadOptions()].concat(checks)).then(function(){})
}
