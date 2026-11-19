// @ts-check
import { callNotebook } from '../daemon-client.js'
import {
  NOTEBOOK_CACHE_KEY, createNotebookQueue, notebookDay, notebookDateLabel, notebookPenStyle,
  notebookPeriod, readNotebookStorage, writeNotebookStorage,
} from './notebook-state.js'

/** @typedef {import('@wechat-cc/protocol').NotebookPageResponseT} NotebookPage */
/** @typedef {import('@wechat-cc/protocol').NotebookEntryT} NotebookEntry */
/** @typedef {import('@wechat-cc/protocol').NotebookPaperT} NotebookPaper */
/** @typedef {{ day: string, days: string[], entries: NotebookEntry[], pen: NotebookPage['pen'], paper: NotebookPaper, refs: Record<string, string> }} NotebookCache */

const LINE_HEIGHT = 36
const UNSAVED_DELAY = 5000
const DEFAULT_PEN = /** @type {const} */ ({ font: 'kai', ink: 'blueBlack', reason: '' })

/** @param {HTMLElement} host @param {Parameters<typeof callNotebook>[0]} transport */
export function mountNotebook(host, transport) {
  const input = /** @type {HTMLTextAreaElement} */ (host.querySelector('#notebook-write'))
  const list = /** @type {HTMLElement} */ (host.querySelector('#notebook-entries'))
  const scroll = /** @type {HTMLElement} */ (host.querySelector('.notebook-scroll'))
  const date = /** @type {HTMLElement} */ (host.querySelector('#notebook-date'))
  const prev = /** @type {HTMLButtonElement} */ (host.querySelector('#notebook-prev'))
  const next = /** @type {HTMLButtonElement} */ (host.querySelector('#notebook-next'))
  const back = /** @type {HTMLButtonElement} */ (host.querySelector('#notebook-today'))
  const paperButton = /** @type {HTMLButtonElement} */ (host.querySelector('#notebook-paper'))
  /** @type {Storage | null} */
  let storage = null
  try { storage = window.localStorage } catch { /* Keep writing in memory. */ }

  let initialized = false
  let active = false
  let day = notebookDay()
  let today = day
  /** @type {string[]} */
  let days = []
  /** @type {NotebookPage['pen']} */
  let pen = DEFAULT_PEN
  /** @type {NotebookPaper} */
  let paper = 'ruled'
  /** @type {Record<string, string>} */
  let refs = {}
  /** @type {Map<string, NotebookEntry[]>} */
  const pages = new Map()
  const loadedDays = new Set()
  /** @type {Map<string, Promise<NotebookPage>>} */
  const reads = new Map()
  /** @type {Map<string, { node: HTMLElement, signature: string }>} */
  const rows = new Map()
  const striking = new Set()
  let changingPaper = false
  let composing = false
  let view = 0
  let revision = 0
  let pollTimer = 0
  let statusTimer = 0

  const save = () => writeNotebookStorage(storage, NOTEBOOK_CACHE_KEY,
    { day, days, entries: pages.get(day) ?? [], pen, paper, refs })

  /** @param {string} dateKey */
  function rememberDay(dateKey) {
    if (!days.includes(dateKey)) days = [...days, dateKey].sort()
  }

  /** @param {string} dateKey */
  function readDay(dateKey) {
    const key = `${revision}:${dateKey}`
    let request = reads.get(key)
    if (!request) {
      request = (async () => {
        const result = /** @type {NotebookPage} */ (await callNotebook(transport, { day: dateKey }))
        if (result?.day !== dateKey || !Array.isArray(result.entries) || !Array.isArray(result.days)) {
          throw new Error('Notebook page unavailable')
        }
        return result
      })().finally(() => reads.delete(key))
      reads.set(key, request)
    }
    return request
  }

  const queue = createNotebookQueue(storage, async body => {
    const reply = /** @type {{ entry: NotebookEntry }} */ (await callNotebook(transport, { action: 'write', body }))
    return reply?.entry
  }, (pending, entry) => {
    revision++
    const writtenDay = notebookDay(new Date(entry.createdAt))
    // The persisted write timestamp is assigned by the daemon at delivery.
    const entries = pages.get(writtenDay) ?? []
    const existing = entries.findIndex(row => row.id === entry.id)
    if (existing === -1) pages.set(writtenDay, [...entries, entry])
    rememberDay(writtenDay)
    save()
    if (active) render()
    // Delivery after midnight moves the row from its original local page.
    if (active && pending.day !== writtenDay) queueMicrotask(render)
  })

  function atBottom() {
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2
  }

  function resizeInput() {
    if (input.hidden || !active) return
    const follow = atBottom()
    const top = scroll.scrollTop
    input.style.height = `${LINE_HEIGHT}px`
    input.style.height = `${Math.ceil(input.scrollHeight / LINE_HEIGHT) * LINE_HEIGHT}px`
    scroll.scrollTop = follow ? scroll.scrollHeight : top
  }

  function nearbyDays() {
    const occupied = new Set([...days, ...queue.entries().map(row => row.day)])
    const ordered = [...occupied].sort()
    return {
      previous: ordered.findLast(item => item < day),
      following: ordered.find(item => item > day),
    }
  }

  /** @param {string} label @param {() => void} onClick */
  function button(label, onClick) {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.addEventListener('click', onClick)
    return node
  }

  /** @param {string} key @param {NotebookEntry} entry @param {boolean} pending @param {boolean} overdue @param {string | undefined} refDay */
  function makeRow(key, entry, pending, overdue, refDay) {
    const node = document.createElement('div')
    node.className = 'notebook-entry'
    node.dataset.author = entry.author
    node.dataset.notebookKey = key
    node.toggleAttribute('data-struck', entry.struckAt !== null)
    const text = document.createElement('p')
    text.className = 'notebook-text'
    text.textContent = entry.body
    if (entry.author === 'cc') {
      Object.assign(node.style, notebookPenStyle(pen))
      const signature = document.createElement('div')
      signature.className = 'notebook-meta'
      signature.textContent = `CC，${notebookPeriod(entry.createdAt)}`
      node.append(text, signature)
      if (entry.refId && refDay) {
        const id = entry.refId
        const line = document.createElement('div')
        line.className = 'notebook-meta'
        const label = refDay === day ? '接着你上面那一条' : `接着你 ${notebookDateLabel(refDay)}那一条`
        line.append(button(label, () => showDay(refDay, id)))
        node.append(line)
      }
    } else {
      const line = document.createElement('div')
      line.className = 'notebook-owner-line'
      line.append(text)
      if (!pending) {
        const strikeButton = button(entry.struckAt === null ? '划掉' : '恢复', () => void strike(entry))
        strikeButton.className = 'notebook-strike'
        line.append(strikeButton)
      }
      node.append(line)
      if (overdue) {
        const status = document.createElement('div')
        status.className = 'notebook-pending'
        status.textContent = '还没存上'
        node.append(status)
      }
    }
    return node
  }

  function render() {
    if (!active) return
    const follow = atBottom()
    const top = scroll.scrollTop
    const viewportTop = scroll.getBoundingClientRect().top
    const anchor = /** @type {HTMLElement | undefined} */ (Array.from(list.children).find(
      row => row.getBoundingClientRect().bottom > viewportTop))
    const anchorKey = anchor?.dataset.notebookKey
    const anchorTop = anchor?.getBoundingClientRect().top
    const { previous, following } = nearbyDays()
    date.textContent = notebookDateLabel(day, today)
    prev.disabled = !previous
    next.disabled = !following
    back.hidden = day === today
    const inputWasHidden = input.hidden
    input.hidden = day !== today
    host.dataset.paper = paper
    paperButton.textContent = paper === 'ruled' ? '换成白纸' : '换成横线'

    const saved = pages.get(day) ?? []
    const savedClients = new Set(saved.map(row => row.clientId))
    const pending = queue.entries().filter(row => row.day === day && !savedClients.has(row.clientId))
    const pendingIds = new Set(pending.map(row => row.clientId))
    /** @type {NotebookEntry[]} */
    const entries = [...saved, ...pending.map(row => ({
      ...row, id: row.clientId, author: /** @type {const} */ ('owner'), origin: /** @type {const} */ ('desktop'),
      refId: null, struckAt: null,
    }))].sort((a, b) => a.createdAt - b.createdAt)

    const now = Date.now()
    let nextStatus = Infinity
    const retain = new Set()
    let position = list.firstChild
    for (const entry of entries) {
      const key = entry.clientId ?? entry.id
      const old = rows.get(key)
      // New CC rows can wait until the pen is lifted. The draft itself stays mounted.
      if (!old && entry.author === 'cc' && (composing || input.value) && day === today) continue
      retain.add(key)
      const isPending = pendingIds.has(key)
      const remaining = entry.createdAt + UNSAVED_DELAY - now
      if (isPending && remaining > 0) nextStatus = Math.min(nextStatus, remaining)
      const refDay = entry.refId ? refs[entry.refId] : undefined
      const overdue = isPending && remaining <= 0
      const signature = JSON.stringify([entry, isPending, overdue, refDay, entry.author === 'cc' ? pen : null])
      const node = old?.signature === signature ? old.node : makeRow(key, entry, isPending, overdue, refDay)
      if (old && old.node !== node) {
        const restoreFocus = old.node.contains(document.activeElement)
        if (position === old.node) position = node
        old.node.replaceWith(node)
        if (restoreFocus) node.querySelector('button')?.focus({ preventScroll: true })
      }
      if (node !== position) list.insertBefore(node, position)
      position = node.nextSibling
      rows.set(key, { node, signature })
    }
    for (const [key, row] of rows) {
      if (retain.has(key)) continue
      row.node.remove()
      rows.delete(key)
    }
    if (!input.hidden && inputWasHidden) resizeInput()
    if (follow) scroll.scrollTop = scroll.scrollHeight
    else {
      const newTop = anchorKey ? rows.get(anchorKey)?.node.getBoundingClientRect().top : undefined
      scroll.scrollTop = anchorTop === undefined || newTop === undefined ? top : top + newTop - anchorTop
    }
    window.clearTimeout(statusTimer)
    if (Number.isFinite(nextStatus)) statusTimer = window.setTimeout(render, nextStatus)
  }

  /** @param {number} token */
  async function resolveReferences(token) {
    const entries = pages.get(day) ?? []
    const ids = new Set(entries.flatMap(entry => entry.refId && !refs[entry.refId] ? [entry.refId] : []))
    if (!ids.size) return
    const candidates = [day, ...days.filter(item => item !== day).sort().reverse()]

    /** @param {string} candidate @param {NotebookEntry[]} entries */
    function match(candidate, entries) {
      let found = false
      for (const entry of entries) {
        if (!ids.delete(entry.id)) continue
        refs[entry.id] = candidate
        found = true
      }
      if (found) {
        save()
        render()
      }
      return found
    }

    for (const candidate of candidates) {
      match(candidate, pages.get(candidate) ?? [])
      if (!ids.size) return
    }
    const startRevision = revision
    for (const candidate of candidates) {
      if (loadedDays.has(candidate)) continue
      const data = await readDay(candidate)
      if (!active || token !== view || startRevision !== revision) return
      if (match(candidate, data.entries)) {
        pages.set(candidate, data.entries)
        loadedDays.add(candidate)
      }
      if (!ids.size) return
    }
  }

  /** @param {string} [target] */
  async function refresh(target) {
    const token = view
    const stamp = revision
    const selected = day
    try {
      const data = await readDay(selected)
      if (!active || token !== view) return
      if (stamp !== revision) return void refresh(target)
      pages.set(selected, data.entries)
      loadedDays.add(selected)
      days = [...data.days].sort()
      pen = data.pen ?? DEFAULT_PEN
      if (!changingPaper) paper = data.paper
      save()
      render()
      if (target) locate(target)
      await resolveReferences(token)
    } catch { /* Keep the last locally available page. */ }
  }

  /** @param {string} id */
  function locate(id) {
    // An owner row may be keyed by its clientId to keep its position on acknowledgment.
    const entry = pages.get(day)?.find(entry => entry.id === id)
    const target = entry && rows.get(entry.clientId ?? entry.id)?.node
    if (!target) return
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return true
    target.removeAttribute('data-notebook-highlight')
    void target.offsetWidth
    target.setAttribute('data-notebook-highlight', '')
    target.addEventListener('animationend', () => target.removeAttribute('data-notebook-highlight'), { once: true })
    return true
  }

  /** @param {string} selected @param {string} [target] */
  function showDay(selected, target) {
    if (selected !== day) {
      day = selected
      view++
      rows.clear()
      list.replaceChildren()
      scroll.scrollTop = 0
      render()
      scroll.scrollTop = selected === today && !target ? scroll.scrollHeight : 0
      if (selected === today && !target) input.focus({ preventScroll: true })
      save()
    }
    const located = target && locate(target)
    void refresh(located ? undefined : target)
  }

  /** @param {NotebookEntry} entry */
  async function strike(entry) {
    if (striking.has(entry.id)) return
    const selected = day
    striking.add(entry.id)
    try {
      const struck = entry.struckAt === null
      const result = /** @type {{ ok: true }} */ (await callNotebook(transport, {
        action: 'strike', body: { id: entry.id, struck },
      }))
      if (result?.ok !== true) return
      revision++
      pages.set(selected, (pages.get(selected) ?? []).map(row =>
        row.id === entry.id ? { ...row, struckAt: struck ? Date.now() : null } : row))
      save()
      render()
    } catch { /* Leave the row as it was. */ }
    finally { striking.delete(entry.id) }
  }

  paperButton.addEventListener('click', async () => {
    if (changingPaper) return
    changingPaper = true
    try {
      const result = /** @type {{ paper: NotebookPaper }} */ (await callNotebook(transport, {
        action: 'paper', body: { paper: paper === 'ruled' ? 'plain' : 'ruled' },
      }))
      if (result?.paper !== 'plain' && result?.paper !== 'ruled') return
      revision++
      paper = result.paper
      save()
      render()
    } catch { /* Leave the paper as it was. */ }
    finally { changingPaper = false }
  })

  async function retry() {
    await queue.flush()
    render()
  }

  function syncDate() {
    const localDay = notebookDay()
    if (localDay === today) return
    const wasToday = day === today
    today = localDay
    if (wasToday) showDay(today)
    else render()
  }

  input.addEventListener('input', () => {
    resizeInput()
    if (!input.value && !composing) render()
  })
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => {
    composing = false
    if (!input.value) render()
  })
  input.addEventListener('blur', () => { composing = false })
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return
    event.preventDefault()
    syncDate()
    const body = input.value.trim().replaceAll('\0', '')
    if (!body || Array.from(body).length > 4000) return
    queue.add({ body, clientId: crypto.randomUUID(), day, createdAt: Date.now() })
    input.value = ''
    resizeInput()
    render()
    void retry()
  })
  prev.addEventListener('click', () => { const { previous } = nearbyDays(); if (previous) showDay(previous) })
  next.addEventListener('click', () => { const { following } = nearbyDays(); if (following) showDay(following) })
  back.addEventListener('click', () => showDay(today))

  const observer = new ResizeObserver(resizeInput)
  observer.observe(scroll)
  window.addEventListener('online', () => {
    if (initialized) void retry()
    if (active) void refresh()
  })

  return {
    open() {
      if (active) return
      active = true
      view++
      if (!initialized) {
        initialized = true
        window.setInterval(() => void retry(), 30_000)
        const cached = /** @type {NotebookCache | null} */ (readNotebookStorage(storage, NOTEBOOK_CACHE_KEY))
        if (cached?.day && Array.isArray(cached.entries) && Array.isArray(cached.days)) {
          day = cached.day
          days = cached.days
          paper = cached.paper
          pen = cached.pen ?? DEFAULT_PEN
          refs = cached.refs ?? {}
          pages.set(day, cached.entries)
        }
      }
      syncDate()
      render()
      resizeInput()
      if (day === today) input.focus({ preventScroll: true })
      void refresh()
      void retry()
      pollTimer = window.setInterval(() => {
        syncDate()
        void refresh()
      }, 60_000)
    },
    close() {
      if (!active) return
      active = false
      view++
      window.clearInterval(pollTimer)
      window.clearTimeout(statusTimer)
    },
  }
}
