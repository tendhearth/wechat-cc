// @ts-check
import {parseDraftAttachments} from './workbench-attachments.js'
/** @typedef {{path:string,text:string,title:string,providerId:string,followup:string,draftId?:string,attachments?:import('./workbench-attachments.js').DraftAttachment[]}} Draft */
/** @typedef {{q:string,archived:'exclude'|'only'|'all'}} Query */
/** @typedef {{scope:string|null,query:Query,search:string}} View */
/** @typedef {Pick<Storage,'getItem'|'setItem'|'removeItem'>} StorageLike */
const PREFIX = 'cc.workbench.window.v1:'
const emptyDraft = () => /** @type {Draft} */ ({path:'',text:'',title:'',providerId:'',followup:''})
const emptyView = () => /** @type {View} */ ({scope:null,query:{q:'',archived:'exclude'},search:''})
/** @param {unknown} value @returns {Draft|null} */
function parseDraft(value,recover=false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = /** @type {Record<string,unknown>} */ (value)
  const result = /** @type {Draft} */(emptyDraft())
  for (const key of /** @type {Array<'path'|'text'|'title'|'providerId'|'followup'>} */ (Object.keys(result))) {
    if (typeof data[key] !== 'string') return null
    result[key] = /** @type {string} */ (data[key])
  }
  if(typeof data.draftId==='string'&&/^[a-f0-9-]{36}$/i.test(data.draftId))result.draftId=data.draftId
  if(Array.isArray(data.attachments))result.attachments=parseDraftAttachments(data.attachments,recover)
  return result
}
/** @param {Pick<StorageLike,'getItem'>|null} storage @param {string} key */
function read(storage,key) {
  try { const raw = storage?.getItem(PREFIX + key); return raw ? JSON.parse(raw) : null }
  catch { return null }
}
/** @param {StorageLike|null} storage @param {string} key @param {unknown} value */
function write(storage,key,value) {
  try { storage?.setItem(PREFIX + key,JSON.stringify(value)) }
  catch {
    // Keep the in-memory copy, but don't resurrect an older sent draft on reload.
    try { storage?.removeItem(PREFIX + key) } catch { /* storage is unavailable */ }
  }
}
/** Per-window storage only. Drafts never enter model requests before submission.
 * @param {StorageLike|null} [storage] */
export function createWorkbenchDraftStore(storage=null) {
  /** @type {Map<string,Draft>} */ const values = new Map()
  const restore = (/** @type {string} */ key) => {
    if (!values.has(key)) {
      const draft = parseDraft(read(storage,'draft:' + key),true)
      if (draft) values.set(key,draft)
    }
  }
  return {
    /** @param {string} key @param {Draft} value */
    set(key,value) {
      const draft = parseDraft(value)
      if (!draft) return
      values.set(key,draft); write(storage,'draft:' + key,draft)
    },
    /** @param {string} key */
    get(key) { restore(key); return structuredClone(values.get(key) ?? emptyDraft()) },
    /** @param {string} key */
    has(key) { restore(key); return values.has(key) },
    /** @param {string} key */
    delete(key) { values.delete(key); try { storage?.removeItem(PREFIX + 'draft:' + key) } catch { /* optional persistence */ } },
  }
}
/** @param {unknown} value @returns {View|null} */
function parseView(value) {
  if (!value || typeof value !== 'object') return null
  const v = /** @type {View} */ (value)
  if (v.scope !== null && (typeof v.scope !== 'string' || !/^(new(?::.+)?|task:[a-f0-9]{8})$/.test(v.scope) || v.scope.length > 4096)) return null
  if (!v.query || typeof v.query.q !== 'string' || v.query.q.length > 200 || !['exclude','only','all'].includes(v.query.archived) || typeof v.search !== 'string' || v.search.length > 200) return null
  return {scope:v.scope,query:{q:v.query.q,archived:v.query.archived},search:v.search}
}
/** @param {Pick<StorageLike,'getItem'>|null} storage */
export function loadWorkbenchView(storage) { return parseView(read(storage,'view')) ?? emptyView() }
/** @param {StorageLike|null} storage @param {View} view */
export function saveWorkbenchView(storage,view) { const valid=parseView(view); if(valid)write(storage,'view',valid) }
/** Access can itself throw in a restricted webview. */
export function workbenchWindowStorage() { try { return typeof window === 'undefined' ? null : window.sessionStorage ?? null } catch { return null } }
