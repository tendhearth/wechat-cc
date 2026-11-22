// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { executorName } from './executor-names.js'
import { icon } from './icons.js'

export const DESK_SEARCH_HINT = '搜项目、会话里说过的话、和 CC 的对话、交办的事'
const labels = { projects: '项目', terminals: '会话里说过的', chat: '和 CC 的对话' }
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' })
/** @typedef {keyof typeof labels} SectionKey */
/** @typedef {import('@wechat-cc/protocol').PlaceT} Place */
/** @typedef {import('@wechat-cc/protocol/desktop-api').TerminalSearchHitT} TerminalHit */
/** @typedef {{id?:string,messageId?:string,kind:string,text:string,createdAt:number}} ChatHit */
/** @typedef {Place | TerminalHit | ChatHit} Hit */
/** @typedef {'ready'|'pending'|'error'} Status */
/** @typedef {{status:Status,rows?:Hit[],paging?:boolean,pageError?:boolean}} Section */
/** @typedef {{root:HTMLElement,visible:()=>boolean,filter:(q:string)=>Promise<void>,invalidateTasks:()=>void}} View */
const sectionKeys = /** @type {SectionKey[]} */ (Object.keys(labels))
const time = (/** @type {number} */ at) => Number.isFinite(at) ? weekday.format(at) : ''

/** @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {string} [className] @param {string} [value] */
function node(tag, className, value) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (value != null) el.textContent = value
  return el
}

/** @param {string} label @param {number|null} count */
function title(label, count) {
  const heading = node('h3', 'desk-search-section-title', label)
  if (count != null) heading.append(node('span', '', String(count)))
  return heading
}

/** @param {HTMLElement} el @param {string} text @param {number} start @param {number} length */
function highlight(el, text, start, length) {
  if (start < 0 || !length) { el.textContent = text; return }
  el.append(text.slice(0, start), node('strong', '', text.slice(start, start + length)), text.slice(start + length))
}

/** @param {string} text @param {string} q */
function chatExcerpt(text, q) {
  const match = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(text)
  const before = Array.from(text.slice(0, match?.index ?? 0))
  const after = Array.from(text.slice((match?.index ?? 0) + (match?.[0].length ?? 0)))
  const prefix = (before.length > 40 ? '…' : '') + before.slice(-40).join('')
  const suffix = after.slice(0, 40).join('') + (after.length > 40 ? '…' : '')
  return { text: prefix + (match?.[0] ?? '') + suffix, start: prefix.length, length: match?.[0].length ?? 0 }
}

/** @param {unknown} result @param {string} key */
function readRows(result, key) {
  const rows = /** @type {Record<string,unknown>|null} */ (result)?.[key]
  if (!Array.isArray(rows)) throw new Error('search_unavailable')
  return rows
}

/** Window-scoped results. Workbench can remount without discarding completed searches.
 * @param {{call:typeof import('../api.js').invokeWorkbenchApi,
 * openProject:(place:Place)=>void,
 * openTerminal:(hit:TerminalHit)=>void,
 * openMessage:(id:string,excerpt:string)=>void}} deps
 */
export function createDeskSearch({ call, openProject, openTerminal, openMessage }) {
  let raw = '', q = '', revision = 0, composing = false, earlier = '', active = ''
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  /** @type {View|undefined} */ let view
  /** @type {Partial<Record<SectionKey,Section>>} */ let sections = {}
  /** @type {Status|undefined} */ let taskStatus
  let taskBusy = false, launching = false
  /** @type {{key:string, response:Promise<unknown>}|undefined} */ let taskRead
  const current = () => view?.visible()
  const field = () => /** @type {HTMLInputElement|null|undefined} */ (view?.root.querySelector('#wb-search'))
  const tasks = () => /** @type {HTMLElement|null|undefined} */ (view?.root.querySelector('.desk-search-tasks'))
  const options = () => view?.visible()
    ? [.../** @type {NodeListOf<HTMLButtonElement>} */ (view.root.querySelectorAll('.desk-search-row, .desk-search-tasks:not([hidden]) .wb-task-list .wb-task'))].filter(row => !row.closest('[hidden]'))
    : []

  function syncOptions() {
    const rows = options()
    const input = field()
    const list = /** @type {HTMLElement|null|undefined} */ (view?.root.querySelector('#desk-search-options'))
    if (!input || !list) return
    for (const row of rows) {
      if (!row.id) row.id = 'desk-search-task-' + encodeURIComponent(row.dataset.taskId ?? '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(row.id === active))
    }
    if (!rows.some(row => row.id === active)) active = ''
    if (active) input.setAttribute('aria-activedescendant', active)
    else input.removeAttribute('aria-activedescendant')
    list.setAttribute('aria-owns', rows.map(row => row.id).join(' '))
    input.setAttribute('aria-expanded', String(rows.length > 0))
    list.hidden = !rows.length
  }

  /** @param {()=>void} retry */
  function notice(retry) {
    const line = node('p', 'desk-search-note', '这一段暂时没能读取。')
    const button = node('button', 'wb-new', '重新读取')
    button.type = 'button'
    button.onclick = () => { field()?.focus(); retry() }
    line.append(button)
    return line
  }

  function syncSummary() {
    if (!view?.visible() || composing) return
    const clearButton = view.root.querySelector('.desk-search-clear')
    if (clearButton) clearButton.toggleAttribute('hidden', !raw)
    const taskArea = tasks()
    const clearing = !q && (launching || taskStatus === 'pending')
    const taskRows = clearing ? 0 : taskArea?.querySelectorAll('.wb-task-list .wb-task').length ?? 0
    const failed = taskStatus === 'error'
    if (taskArea) {
      taskArea.hidden = !!q && !failed && (taskStatus !== 'ready' || !taskRows)
      const count = taskArea.querySelector('.desk-search-section-title span')
      if (count) count.textContent = String(taskRows)
      const content = /** @type {HTMLElement} */ (taskArea.querySelector('.desk-search-task-content'))
      content.hidden = failed || clearing
      const error = taskArea.querySelector('.desk-search-task-error')
      if (failed && error && !error.firstChild) error.append(notice(runTasks))
      if (!failed) error?.replaceChildren()
    }
    const empty = view.root.querySelector('.desk-search-empty')
    if (empty) empty.textContent = q && taskStatus === 'ready' && !taskRows &&
      sectionKeys.every(key => sections[key]?.status === 'ready' && !sections[key]?.rows?.length)
      ? `没有找到「${q}」。` : ''
    syncOptions()
  }

  /** @param {SectionKey} key */
  function paintSection(key) {
    if (!view?.visible() || composing) return
    const host = view.root.querySelector(`[data-desk-search-section="${key}"]`)
    if (!host) return
    const section = sections[key]
    host.replaceChildren()
    if (!q || !section || section.status === 'pending' || (section.status === 'ready' && !section.rows?.length)) return
    host.append(title(labels[key], section.status === 'error' ? null : section.rows?.length ?? 0))
    if (section.status === 'error') { host.append(notice(() => void read(key))); return }
    section.rows?.forEach((hit, index) => {
      const button = node('button', 'desk-search-row')
      button.type = 'button'
      button.id = `desk-search-${key}-${index}`
      const text = node('span', 'desk-search-text')
      const sub = node('span', 'desk-search-meta')
      if (key === 'projects') {
        const place = /** @type {Place} */ (hit)
        text.textContent = place.name
        sub.textContent = place.line ?? ''
        button.onclick = () => openProject(place)
      } else if (key === 'terminals') {
        const terminal = /** @type {TerminalHit} */ (hit)
        highlight(text, terminal.snippet, terminal.matchStart, terminal.matchLength)
        sub.textContent = [terminal.project, executorName(terminal.source), time(terminal.at), terminal.who === 'you' ? '你说的' : '它说的'].filter(Boolean).join(' · ')
        button.onclick = () => openTerminal(terminal)
      } else {
        const message = /** @type {ChatHit} */ (hit)
        const excerpt = chatExcerpt(message.text ?? '', q)
        highlight(text, excerpt.text, excerpt.start, excerpt.length)
        sub.textContent = [message.kind === 'user' ? '你说的' : 'CC 说的', time(message.createdAt)].filter(Boolean).join(' · ')
        const id = message.messageId ?? message.id
        if (id) button.onclick = () => openMessage(id, message.text)
      }
      button.append(text)
      if (sub.textContent) button.append(sub)
      host.append(button)
    })
    if (key === 'chat' && earlier) {
      if (section.pageError) host.append(notice(() => void read('chat', earlier)))
      else {
        const more = node('button', 'wb-new desk-search-earlier', '再往前找')
        more.type = 'button'
        more.disabled = !!section.paging
        more.onclick = () => { field()?.focus(); void read('chat', earlier) }
        host.append(more)
      }
    }
  }

  /** @param {SectionKey} key */
  async function read(key, before = '') {
    const seq = revision
    const query = q
    const previous = sections[key] ?? { status: /** @type {Status} */ ('pending') }
    sections[key] = before ? { ...previous, paging: true, pageError: false } : { status: 'pending' }
    paintSection(key)
    /** @type {Hit[]} */ let rows
    let cursor = ''
    try {
      if (key === 'projects') {
        const result = await v1(call, V1.places.get)
        rows = readRows(result, 'places').filter(place => place.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
      } else if (key === 'terminals') {
        rows = readRows(await v1(call, V1.terminal.search, { query: { q: query, limit: 20 } }), 'hits').slice(0, 20)
      } else {
        try {
          const result = /** @type {{error?:string,earlier?:string}|null} */ (await v1(call, V1.conversation.window, { query: { q: query, before: before || undefined, limit: 10 } }))
          if (result?.error) throw new Error(result.error)
          rows = [...readRows(result, 'messages')].reverse()
          cursor = result?.earlier ?? ''
        } catch (error) {
          if (seq !== revision || before || !/^(?:Error: )?(?:not_found|HTTP 404(?: Not Found)?|workbench_endpoint_missing|conversation_window_not_wired|owner_chat_not_wired)$/.test(String(error))) throw error
          rows = readRows(await v1(call, V1.matter.ownerChatSearch, { query: { q: query, limit: 10 } }), 'hits')
        }
        if (before) {
          const messages = /** @type {ChatHit[]} */ ([...(previous.rows ?? []), ...rows])
          rows = [...new Map(messages.map(hit => [hit.messageId ?? hit.id, hit])).values()]
        }
      }
      if (seq !== revision) return
      if (key === 'chat') earlier = cursor
      sections[key] = { status: 'ready', rows }
    } catch {
      if (seq !== revision) return
      sections[key] = before ? { ...previous, paging: false, pageError: true } : { status: 'error' }
    }
    paintSection(key)
    syncSummary()
  }

  async function runTasks() {
    if (!view?.visible()) return
    const target = view, seq = revision
    if (taskStatus === 'error') taskRead = undefined
    taskBusy = true
    taskStatus = 'pending'
    syncSummary()
    try {
      await target.filter(q)
      if (seq === revision && view === target) taskStatus = 'ready'
    } catch {
      if (seq === revision && view === target) taskStatus = 'error'
    }
    if (seq === revision && view === target) taskBusy = false
    syncSummary()
  }

  function queueSearch() {
    clearTimeout(timer)
    if (!launching || !current() || composing) return
    timer = setTimeout(() => {
      if (!current() || composing) return
      launching = false
      if (q) for (const key of sectionKeys) void read(key)
      void runTasks()
    }, 250)
  }

  /** @param {string} value */
  function schedule(value) {
    raw = value
    const query = value.trim().slice(0, 200)
    if (query !== q) {
      q = query
      revision++
      active = earlier = ''
      sections = {}
      taskRead = taskStatus = undefined
      launching = true
      taskBusy = false
      view?.invalidateTasks()
      for (const key of sectionKeys) paintSection(key)
    }
    syncSummary()
    queueSearch()
  }

  function clear() {
    const input = field()
    if (!current() || !input?.value || composing) return false
    input.value = ''
    input.focus()
    schedule('')
    return true
  }

  function paint() {
    if (!view?.visible()) return
    const root = view.root
    const input = field()
    const controls = root.querySelector('.wb-list-controls')
    const list = root.querySelector('.wb-task-list')
    if (!input || !controls || !list) return
    if (!tasks()) {
      input.value = raw
      input.placeholder = DESK_SEARCH_HINT
      input.setAttribute('aria-label', DESK_SEARCH_HINT)
      input.setAttribute('role', 'combobox')
      input.setAttribute('aria-autocomplete', 'list')
      input.setAttribute('aria-controls', 'desk-search-options')
      const clearButton = node('button', 'desk-search-clear')
      clearButton.type = 'button'
      clearButton.setAttribute('aria-label', '清除')
      clearButton.innerHTML = icon('cancel-01', { size: 16 })
      clearButton.onclick = clear
      input.after(clearButton)
      const targets = node('div')
      targets.id = 'desk-search-options'
      targets.setAttribute('role', 'listbox')
      targets.setAttribute('aria-label', '搜索结果')
      controls.after(targets)
      const area = node('section', 'desk-search-tasks')
      const header = node('header', 'desk-search-task-header')
      const filters = node('div', 'desk-search-task-filters')
      for (const control of controls.querySelectorAll(':scope > label, .wb-list-filters')) filters.append(control)
      const delegate = root.querySelector('.wb-sidebar > header .wb-delegate')
      if (delegate) {
        delegate.classList.add('wb-new')
        filters.append(delegate)
      }
      header.append(title('交办的事', 0), filters)
      const content = node('div', 'desk-search-task-content')
      const pagination = root.querySelector('.wb-load-more')
      list.before(area)
      content.append(list)
      if (pagination) content.append(pagination)
      const archiveLabel = controls.querySelector('.wb-archive-label')
      if (archiveLabel) content.prepend(archiveLabel)
      const error = node('div', 'desk-search-task-error')
      area.append(header, error, content)
      for (const key of sectionKeys) {
        const section = node('section', 'desk-search-section')
        section.dataset.deskSearchSection = key
        area.before(section)
        paintSection(key)
      }
      const empty = node('p', 'desk-search-empty desk-search-note')
      empty.setAttribute('role', 'status')
      area.after(empty)
    }
    syncSummary()
  }

  return {
    get query() { return q },
    get composing() { return composing },
    /** Keep the first page available if the workbench is replaced while it is loading.
     * @param {URLSearchParams} query */
    readTaskList(query) {
      const key = query.toString()
      if (taskRead?.key !== key) taskRead = { key, response: v1(call, V1.workbench.list, { query }) }
      return taskRead.response
    },
    /** @param {()=>Promise<void>} refresh */
    async refreshTasks(refresh) {
      if (!view?.visible() || composing || taskBusy || launching || taskStatus === 'error' || (q && taskStatus === 'ready')) return
      const seq = revision, target = view
      taskBusy = true
      try {
        await refresh()
        if (seq === revision && view === target) taskStatus = 'ready'
      } catch {
        if (seq === revision && view === target) taskStatus = 'error'
      } finally {
        if (seq === revision && view === target) taskBusy = false
      }
      syncSummary()
    },
    /** @param {View} next */
    mount(next) {
      view = next
      paint()
      queueSearch()
    },
    /** @param {HTMLElement} next */
    unmount(next) {
      if (view?.root !== next) return
      view = undefined
      composing = false
      clearTimeout(timer)
      taskBusy = false
      if (taskStatus === 'pending') taskStatus = undefined
    },
    paint,
    /** @param {string} value */
    update(value) { if (!composing) schedule(value) },
    /** @param {boolean} start @param {string} value */
    compose(start, value) {
      composing = start
      if (start) clearTimeout(timer)
      else schedule(value)
    },
    clear,
    /** @param {KeyboardEvent} event */
    keydown(event) {
      if (!current() || event.target !== field() || composing || event.isComposing || event.keyCode === 229) return
      const rows = options()
      const index = rows.findIndex(row => row.id === active)
      if (event.key === 'Enter' && index >= 0) {
        event.preventDefault()
        rows[index]?.click()
      } else if (rows.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : index < 0 ? rows.length - 1 : Math.max(0, index - 1)
        active = rows[next]?.id ?? ''
        syncOptions()
        rows[next]?.scrollIntoView({ block: 'nearest' })
      }
    },
  }
}
