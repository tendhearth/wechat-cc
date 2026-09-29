
var PA_CHUNK_BYTES = 128 * 1024
function paMessage(error) {
  var code = error && error.message || error
  if (code === "heic_not_supported") return "暂不支持 HEIC / HEIF 照片，请选 JPEG、PNG 或 WebP 原图。"
  if (code === "attachment_size") return "图片最多 5 MiB，其他文件最多 8 MiB；请选择小一点的文件。"
  if (code === "attachment_limit") return "一次最多 8 件材料，总共不超过 24 MiB。"
  if (code === "attachment_type") return "暂不支持这种文件，请选择图片、PDF、Office 文档或文本。"
  if (code === "reselect_mismatch") return "这不是原来的文件。请重新选择同名、同内容的原文件，或移除后重新添加。"
  if (code === "attachment_frozen") return "这些材料属于已交办的请求，正在确认是否收到，暂时不能移除或替换。"
  if (code === "upload_reply_mismatch") return "收到的上传信息对不上，已暂停。请重新选择原文件再确认。"
  if (code === "upload_discarded" || code === "upload_expired") return "这次上传已取消或过期，请移除后重新添加文件。"
  if (code === "upload_invalid_content" || code === "upload_restart_required") return "文件内容与格式或校验信息不一致，无法继续这次上传。请移除后重新添加可用文件。"
  if (code === "upload_storage") return "这台手机暂时无法保存上传进度，请先恢复浏览器存储再试。"
  return "还没确认上传完成，文件信息已保留。重新选择原文件可以继续。"
}
function paMime(file) {
  var extension = file.name.split(".").pop().toLowerCase(), mime = (file.type || "").toLowerCase()
  if (/^(heic|heif)$/.test(extension) || /^image\/hei[cf]/.test(mime)) throw new Error("heic_not_supported")
  var types = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", pdf:"application/pdf", txt:"text/plain", md:"text/markdown", csv:"text/csv", json:"application/json", docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation" }
  var inferred = types[extension] || (/^(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|hpp|css|html|sql|sh|yaml|yml|toml|xml|diff|patch)$/.test(extension) ? "text/plain" : "")
  if (!mime || mime === "application/octet-stream" || (inferred === "text/plain" && /^(text\/|application\/(javascript|x-javascript|xml|sql|yaml|x-yaml)$)/.test(mime)) || (inferred === "text/markdown" && mime === "text/x-markdown") || (inferred === "text/csv" && mime === "application/vnd.ms-excel")) mime = inferred
  if (Object.values(types).indexOf(mime) < 0) throw new Error("attachment_type")
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > (/^image\//.test(mime) ? 5 : 8) * 1024 * 1024) throw new Error("attachment_size")
  return mime
}
function paBase64(bytes) {
  var parts = []
  for (var i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)))
  return btoa(parts.join(""))
}
function paRequest(path, body) {
  var timer, opts = body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  return Promise.race([api(path, opts).then(function(r){ return r.json().then(function(value){
    if (r.status >= 400 || !value.ok) throw Object.assign(new Error(value.error || "upload_unavailable"), { status: r.status })
    return value
  }) }), new Promise(function(_resolve, reject){ timer = setTimeout(function(){ reject(new Error("timeout")) }, 15000) })]).finally(function(){ clearTimeout(timer) })
}
/** Each instance owns one draft. Files and preview URLs stay in memory, never in localStorage. */
function createPhoneAttachments(options) {
  var draftId = options.draftId, taskId = options.taskId || null, alive = true, host = null, notice = "", rows = [], busy = {}, onFile = null, onClick = null
  var key = "cc.phone.attachments.v1:" + (REMOTE ? REMOTE.id : location.host) + ":" + (taskId || "entry") + ":" + draftId
  function metadata(row) { return { id:row.id, draftId:draftId, taskId:taskId, name:row.name, mime:row.mime, size:row.size, sha256:row.sha256, nextOffset:row.nextOffset, status:row.status, frozen:!!row.frozen, removed:!!row.removed, error:row.error || "" } }
  try {
    var saved = JSON.parse(localStorage.getItem(key) || "null")
    if (saved && saved.version === 1 && Array.isArray(saved.items)) rows = saved.items.filter(function(r){ return r.draftId === draftId && r.taskId === taskId && typeof r.id === "string" }).map(function(r){
      return Object.assign(metadata(r), { generation:0, file:null, url:null, status:r.removed ? "discard_failed" : r.status === "ready" ? "ready" : r.status === "rejected" ? "rejected" : "needs_file" })
    })
  } catch (e) {}
  function selected() { return rows.filter(function(r){ return !r.removed }) }
  function persist() { try { if (!rows.length && typeof localStorage.removeItem === "function") localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({version:1,items:rows.map(metadata)})); return true } catch (e) { notice = paMessage(new Error("upload_storage")); return false } }
  function paint() {
    if (!host || !alive) return
    var frozen = selected().some(function(r){ return r.frozen })
    host.innerHTML = '<div class="pa-controls"><label class="pa-pick' + (frozen ? ' pa-disabled' : '') + '">＋ 添加图片或文件<input type="file" multiple data-pa-files' + (frozen ? ' disabled' : '') + '></label><span class="pa-help">图片 5 MiB · 每次最多 8 件</span></div><p class="pa-notice" role="status" aria-live="polite">' + esc(notice) + '</p><div class="pa-items">' + rows.map(function(row){
      var state = row.frozen ? "已随交办提交，正在确认回执" : row.status === "ready" ? "已准备好" : row.status === "hashing" ? "正在核对文件…" : row.status === "uploading" ? "正在上传 " + Math.floor(row.nextOffset * 100 / row.size) + "%" : row.removed ? "正在确认移除" : row.error || "请重新选择原文件继续上传"
      var resume = !row.frozen && !row.removed && (row.status === "needs_file" || row.status === "paused") ? '<label class="pa-resume">重新选原文件<input type="file" data-pa-resume="' + esc(row.id) + '"></label>' : ''
      return '<div class="pa-item">' + (row.url && !row.removed ? '<img src="' + esc(row.url) + '" alt="">' : '') + '<div class="pa-info"><span class="pa-name">' + esc(row.name) + '</span><small>' + esc(state) + '</small>' + resume + '</div><button type="button" data-pa-remove="' + esc(row.id) + '"' + (row.frozen || row.status === "removing" ? ' disabled' : '') + '>' + (row.removed ? '重试移除' : '移除') + '</button></div>'
    }).join("") + '</div>'
  }
  function changed() { if (!alive) return false; var saved = persist(); paint(); if (options.onChange) options.onChange(); return saved }
  function current(row, generation) { return alive && !row.removed && rows.indexOf(row) >= 0 && row.generation === generation }
  function revoke(row) { if (row.url) { URL.revokeObjectURL(row.url); row.url = null } }
  function failed(row, error) {
    var code = error && error.message || error
    row.status = /^(upload_invalid_content|upload_discarded|upload_expired)$/.test(code) ? "rejected" : "paused"
    if (row.status === "rejected") { row.file = null; revoke(row) }
    row.error = paMessage(error); changed()
  }
  function checked(row, state) {
    if (!state || state.id !== row.id || state.draftId !== draftId || state.taskId !== taskId || state.size !== row.size || state.sha256 !== row.sha256 || !Number.isSafeInteger(state.nextOffset) || state.nextOffset < 0 || state.nextOffset > row.size || (state.status !== "uploading" && state.status !== "ready")) throw new Error("upload_reply_mismatch")
    if (state.status === "ready") {
      var a = state.attachment
      if (state.nextOffset !== row.size || !a || a.id !== row.id || a.name !== row.name || a.mime !== row.mime || a.size !== row.size || a.sha256 !== row.sha256) throw new Error("upload_reply_mismatch")
    } else if (state.nextOffset >= row.size || state.nextOffset % PA_CHUNK_BYTES !== 0) throw new Error("upload_reply_mismatch")
    return state
  }
  function apply(row, state) { row.nextOffset = state.nextOffset; row.status = state.status; row.error = ""; changed() }
  async function upload(row, file, generation, query) {
    try {
      if (query) {
        var state
        try { state = await paRequest("/m/api/attachment/upload?id=" + encodeURIComponent(row.id) + "&draftId=" + encodeURIComponent(draftId), undefined) }
        catch (e) { if (e.status !== 404) throw e; state = null }
        if (!current(row, generation)) return
        if (state) apply(row, checked(row, state)); else { row.nextOffset = 0; row.status = "uploading" }
      }
      while (current(row, generation) && row.status !== "ready") {
        var offset = row.nextOffset, bytes = new Uint8Array(await file.slice(offset, offset + PA_CHUNK_BYTES).arrayBuffer())
        if (!current(row, generation)) return
        if (!bytes.length || !persist()) throw new Error("upload_storage")
        var response = await paRequest("/m/api/attachment/chunk", { id:row.id, draftId:draftId, ...(taskId ? {taskId:taskId} : {}), name:row.name, mime:row.mime, size:row.size, sha256:row.sha256, offset:offset, contentBase64:paBase64(bytes) })
        if (!current(row, generation)) return
        checked(row, response)
        if (response.nextOffset < offset + bytes.length) throw new Error("upload_reply_mismatch")
        apply(row, response)
      }
    } catch (error) { if (current(row, generation)) failed(row, error) }
  }
  async function select(files) {
    try {
      if (!alive) return
      if (selected().some(function(r){ return r.frozen })) throw new Error("attachment_frozen")
      var list = Array.from(files), mimes = list.map(paMime)
      if (selected().length + list.length > 8 || selected().reduce(function(n, r){ return n + r.size }, 0) + list.reduce(function(n, f){ return n + f.size }, 0) > 24 * 1024 * 1024) throw new Error("attachment_limit")
      var added = list.map(function(file, i){ return { id:mUuid(), name:file.name, mime:mimes[i], size:file.size, sha256:"", nextOffset:0, status:"hashing", frozen:false, removed:false, generation:0, error:"", file:file, url:null } })
      rows = rows.concat(added); notice = ""
      if (!changed()) throw new Error("upload_storage")
      await Promise.all(added.map(async function(row){
        var generation = row.generation
        try {
          var sha256 = await mSha256(new Uint8Array(await row.file.arrayBuffer()))
          if (!current(row, generation)) return
          row.sha256 = sha256; row.status = "uploading"
          if (/^image\//.test(row.mime)) row.url = URL.createObjectURL(row.file)
          if (!changed()) throw new Error("upload_storage")
          busy[row.id] = true
          await upload(row, row.file, generation, false)
        } catch (error) { if (current(row, generation)) failed(row, error) }
        finally { delete busy[row.id] }
      }))
    } catch (error) { notice = paMessage(error); changed(); throw error }
  }
  async function resume(files) {
    try {
      if (!alive) return
      for (var file of Array.from(files)) {
        var mime = paMime(file), matches = selected().filter(function(r){ return !r.frozen && !busy[r.id] && r.name === file.name && r.size === file.size && r.mime === mime })
        var candidates = matches.filter(function(r){ return r.status === "needs_file" || r.status === "paused" })
        if (!candidates.length) throw new Error(matches.some(function(r){ return r.status === "rejected" }) ? "upload_restart_required" : "reselect_mismatch")
        var sha256 = await mSha256(new Uint8Array(await file.arrayBuffer()))
        if (!alive) return
        var row = candidates.find(function(r){ return r.sha256 === sha256 && !r.removed && !busy[r.id] && rows.indexOf(r) >= 0 })
        if (!row) throw new Error("reselect_mismatch")
        var generation = ++row.generation
        row.file = file; revoke(row); if (/^image\//.test(mime)) row.url = URL.createObjectURL(file)
        row.status = "uploading"; row.error = ""; notice = ""
        if (!changed()) throw new Error("upload_storage")
        busy[row.id] = true
        try { await upload(row, file, generation, true) } finally { delete busy[row.id] }
      }
    } catch (error) { notice = paMessage(error); changed(); throw error }
  }
  async function remove(id) {
    var row = rows.find(function(r){ return r.id === id })
    if (!alive || !row) return
    if (row.frozen) { notice = paMessage(new Error("attachment_frozen")); paint(); throw new Error("attachment_frozen") }
    row.generation++; row.removed = true; row.status = "removing"; revoke(row); changed()
    try {
      await paRequest("/m/api/attachment/discard", { id:id, draftId:draftId })
      if (!alive) return
      rows = rows.filter(function(r){ return r !== row }); changed()
    } catch (error) { if (alive) { row.status = "discard_failed"; row.error = paMessage(error); notice = "暂时没确认移除，请再试一次；不会把它交给 CC。"; changed() }; throw error }
  }
  var control = {
    select:select, resume:resume, remove:remove,
    readyIds:function(){ return selected().filter(function(r){ return r.status === "ready" }).map(function(r){ return r.id }) },
    signature:function(){ return JSON.stringify(selected().map(function(r){ return [r.id,r.sha256,r.size] })) },
    items:function(){ return selected().map(metadata) },
    isReady:function(){ return selected().every(function(r){ return r.status === "ready" }) },
    freeze:function(ids){
      var wanted = ids || control.readyIds(), matches = selected().filter(function(r){ return wanted.indexOf(r.id) >= 0 })
      if (matches.length !== wanted.length || matches.some(function(r){ return r.status !== "ready" })) throw new Error("attachment_frozen")
      var previous = matches.map(function(r){ return r.frozen }); matches.forEach(function(r){ r.frozen = true })
      if (!changed()) { matches.forEach(function(r, i){ r.frozen = previous[i] }); throw new Error("upload_storage") }
    },
    acknowledge:function(ids){
      rows = rows.filter(function(r){ if (ids.indexOf(r.id) < 0) return true; r.generation++; revoke(r); return false })
      changed()
    },
    mount:function(element){
      host = element; paint()
      onFile = function(event){
        if (!alive) return
        var input = /** @type {HTMLInputElement} */ (event.target)
        if (input.hasAttribute("data-pa-files")) void select(input.files).catch(function(){})
        if (input.hasAttribute("data-pa-resume")) void resume(input.files).catch(function(){})
      }
      onClick = function(event){
        if (!alive) return
        var target = /** @type {HTMLElement} */ (event.target), button = /** @type {HTMLButtonElement} */ (target.closest("[data-pa-remove]"))
        if (button) void remove(button.dataset.paRemove).catch(function(){})
      }
      element.addEventListener("change", onFile)
      element.addEventListener("click", onClick)
    },
    dispose:function(){
      alive = false; rows.forEach(function(r){ r.generation++; revoke(r); r.file = null })
      if (host && host.removeEventListener) { host.removeEventListener("change", onFile); host.removeEventListener("click", onClick) }
      host = null
    },
  }
  return control
}
