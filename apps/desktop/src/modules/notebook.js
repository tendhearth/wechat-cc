// @ts-check
import { callNotebook } from '../daemon-client.js'
import {
  NOTEBOOK_CACHE_KEY, createNotebookQueue, notebookDay, notebookDateLabel, NOTEBOOK_FONT_KEYS, notebookPenFamily, notebookPenStyle,
  notebookSignaturePeriod, readNotebookStorage, writeNotebookStorage,
} from './notebook-state.js'

/** @typedef {import('@wechat-cc/protocol').NotebookPageResponseT} NotebookPage */
/** @typedef {import('@wechat-cc/protocol').NotebookEntryT} NotebookEntry */
/** @typedef {import('@wechat-cc/protocol').NotebookPaperT} NotebookPaper */
/** @typedef {{ day: string, today?: string, timeZone?: string, days: string[], entries: NotebookEntry[], pen: NotebookPage['pen'], penPending?: boolean, paper: NotebookPaper }} NotebookCache */

const LINE_HEIGHT = 36
const UNSAVED_DELAY = 5000
const DEFAULT_PEN = /** @type {const} */ ({ font: 'kai', ink: 'blueBlack', reason: '' })

/**
 * @param {HTMLElement} host
 * @param {Parameters<typeof callNotebook>[0]} transport
 * @param {Pick<ReturnType<typeof import("./notebook-mail.js").mountNotebookMail>, "markSeen" | "wrote">} [mail]
 */
export function mountNotebook(host, transport, mail) {
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
  let knowsToday = false
  /** @type {string | undefined} */
  let timeZone
  /** @type {string[]} */
  let days = []
  /** @type {NotebookPage['pen']} */
  let pen = DEFAULT_PEN
  let penPending = true
  /** @type {Map<string, { loaded?: boolean, ready: Promise<void> }>} */
  const penFonts = new Map()

  function preparePen() {
    const family = !penPending && notebookPenFamily(pen.font)
    if (!family) return
    let state = penFonts.get(family)
    if (!state) {
      const pending = {
        /** @type {boolean | undefined} */
        loaded: undefined,
        ready: Promise.resolve().then(async () => {
          try {
            const faces = await document.fonts.load(`400 19px ${family}`)
            pending.loaded = faces.some(face => face.status === 'loaded')
          } catch { pending.loaded = false }
          render()
        }),
      }
      penFonts.set(family, pending)
      state = pending
    }
    return state
  }
  /** @type {NotebookPaper} */
  let paper = 'ruled'
  /** @type {Map<string, NotebookEntry[]>} */
  const pages = new Map()
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
  let seenScheduled = false
  let seenInFlight = false
  /** @type {Map<Element, string>} */
  let renderedReplies = new Map()
  const confirmed = new Set()
  const exposedReplies = new Set()
  /** @type {Set<Element>} */
  const observedReplies = new Set()
  const replyObserver = mail && typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      if (!canConfirm()) return
      for (const entry of entries) {
        const id = renderedReplies.get(entry.target)
        if (id && entry.isIntersecting && entry.intersectionRatio >= 0.5) exposedReplies.add(id)
      }
      scheduleSeen()
    }, { root: scroll, threshold: 0.5 })
    : undefined

  function canConfirm() {
    return !!mail && active && !host.hidden && document.body.dataset.pane === 'notebook'
      && document.documentElement.dataset.mode === 'dashboard'
      && document.visibilityState === 'visible'
  }

  function stopObservingReplies() {
    replyObserver?.disconnect()
    replyObserver?.takeRecords()
    observedReplies.clear()
  }

  function observeReplies() {
    if (!replyObserver || !canConfirm()) return
    for (const node of observedReplies) {
      if (renderedReplies.has(node)) continue
      replyObserver.unobserve(node)
      observedReplies.delete(node)
    }
    for (const [node, id] of renderedReplies) {
      if (confirmed.has(id) || observedReplies.has(node)) continue
      observedReplies.add(node)
      replyObserver.observe(node)
    }
  }

  function repliesToConfirm() {
    return [...renderedReplies.values()].filter(id => !confirmed.has(id) && (!replyObserver || exposedReplies.has(id)))
  }

  function scheduleSeen() {
    if (seenScheduled || seenInFlight || !canConfirm() || !repliesToConfirm().length) return
    seenScheduled = true
    // Give the current rows a frame to paint. A render or pane change in
    // between invalidates that frame and schedules a new confirmation.
    const rowsToConfirm = renderedReplies
    const pane = view
    requestAnimationFrame(() => requestAnimationFrame(() => {
      seenScheduled = false
      if (pane !== view || rowsToConfirm !== renderedReplies) scheduleSeen()
      else void confirmRenderedReplies()
    }))
  }

  async function confirmRenderedReplies() {
    if (!mail || !canConfirm()) return
    const ids = repliesToConfirm().slice(0, 50)
    if (!ids.length) return
    const selected = day
    seenInFlight = true
    try {
      if (!await mail.markSeen(ids)) return
      if (selected === day) for (const id of ids) confirmed.add(id)
    } catch { return /* Retry on the next render or visibility change. */ }
    finally { seenInFlight = false }
    scheduleSeen()
  }

  const save = () => writeNotebookStorage(storage, NOTEBOOK_CACHE_KEY,
    { day, today: knowsToday ? today : undefined, timeZone, days, entries: pages.get(day) ?? [], pen, penPending, paper })

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
        const result = /** @type {NotebookPage} */ (await callNotebook(transport, { day: dateKey, fonts: NOTEBOOK_FONT_KEYS }))
        if (result?.day !== dateKey || !result.today || !Array.isArray(result.entries) || !Array.isArray(result.days)) {
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
    mail?.wrote?.()
    revision++
    for (const [dateKey, entries] of pages) {
      if (dateKey === entry.day) continue
      if (entries.some(row => row.clientId === pending.clientId)) {
        pages.set(dateKey, entries.filter(row => row.clientId !== pending.clientId))
      }
    }
    const entries = pages.get(entry.day) ?? []
    if (!entries.some(row => row.id === entry.id)) pages.set(entry.day, [...entries, entry])
    rememberDay(entry.day)
    save()
    render()
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

  /** @param {string} key @param {NotebookEntry} entry @param {boolean} pending @param {boolean} overdue @param {string | undefined} period @param {boolean} penLoaded */
  function makeRow(key, entry, pending, overdue, period, penLoaded) {
    const node = document.createElement('div')
    node.className = 'notebook-entry'
    node.dataset.author = entry.author
    node.dataset.notebookKey = key
    node.toggleAttribute('data-struck', entry.struckAt !== null)
    const text = document.createElement('p')
    text.className = 'notebook-text'
    text.textContent = entry.body
    if (entry.author === 'cc') {
      Object.assign(node.style, notebookPenStyle(pen, penLoaded))
      node.append(text)
      if (period) {
        const signature = document.createElement('div')
        signature.className = 'notebook-meta'
        signature.textContent = `CC，${period}`
        node.append(signature)
      }
      const { refDay } = entry
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

    // Keep the owner's page writable while the chosen face loads. Insert CC's
    // rows only when their final face (or the italic fallback) is ready.
    const penFont = preparePen()
    const penLoaded = penFont?.loaded === true
    const saved = (pages.get(day) ?? []).filter(entry =>
      entry.author !== 'cc' || !penFont || penFont.loaded !== undefined)
    const pending = queue.entries().filter(row => row.day === day &&
      ![...pages.values()].some(entries => entries.some(entry => entry.clientId === row.clientId)))
    const pendingIds = new Set(pending.map(row => row.clientId))
    /** @type {NotebookEntry[]} */
    const entries = [...saved, ...pending.map(row => ({
      ...row, id: row.clientId, author: /** @type {const} */ ('owner'), origin: /** @type {const} */ ('desktop'),
      refId: null, struckAt: null,
    }))].sort((a, b) => a.createdAt - b.createdAt).filter(entry =>
      // New CC rows can wait until the pen is lifted. The draft itself stays mounted.
      !(entry.author === 'cc' && day === today && (composing || input.value) && !rows.has(entry.clientId ?? entry.id)))

    const now = Date.now()
    let nextStatus = Infinity
    const retain = new Set()
    /** @type {Map<Element, string>} */
    const replies = new Map()
    let position = list.firstChild
    for (const [index, entry] of entries.entries()) {
      const key = entry.clientId ?? entry.id
      const old = rows.get(key)
      retain.add(key)
      const isPending = pendingIds.has(key)
      const remaining = entry.createdAt + UNSAVED_DELAY - now
      if (isPending && remaining > 0) nextStatus = Math.min(nextStatus, remaining)
      const nextEntry = entries[index + 1]
      const signaturePeriod = notebookSignaturePeriod(entry, nextEntry, timeZone)
      const overdue = isPending && remaining <= 0
      const signature = JSON.stringify([entry, isPending, overdue, signaturePeriod, entry.author === 'cc' ? [pen, penLoaded] : null])
      const node = old?.signature === signature ? old.node : makeRow(key, entry, isPending, overdue, signaturePeriod, penLoaded)
      if (old && old.node !== node) {
        const restoreFocus = old.node.contains(document.activeElement)
        if (position === old.node) position = node
        old.node.replaceWith(node)
        if (restoreFocus) node.querySelector('button')?.focus({ preventScroll: true })
      }
      if (node !== position) list.insertBefore(node, position)
      position = node.nextSibling
      rows.set(key, { node, signature })
      if (entry.author === 'cc' && entry.refId !== null) replies.set(node, entry.id)
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
    renderedReplies = replies
    observeReplies()
    scheduleSeen()
  }

  /** @param {string} [target] @param {boolean} [keepDay] */
  async function refresh(target, keepDay = false) {
    const token = view
    const stamp = revision
    const selected = day
    try {
      const data = await readDay(selected)
      if (!active || token !== view) return
      if (stamp !== revision) return void refresh(target, keepDay)
      pages.set(data.day, data.entries.filter(entry => entry.day === data.day))
      days = [...data.days].sort()
      pen = data.pen ?? DEFAULT_PEN
      penPending = data.penPending
      if (!changingPaper) paper = data.paper
      const wasToday = day === today
      knowsToday = true
      today = data.today
      timeZone = data.timeZone
      if (!keepDay && wasToday && day !== today) {
        selectDay(today)
        scroll.scrollTop = scroll.scrollHeight
        return void refresh()
      }
      save()
      render()
      if (target) {
        await preparePen()?.ready
        if (active && token === view) locate(target)
      }
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

  /** @param {string} selected */
  function selectDay(selected) {
    day = selected
    confirmed.clear()
    exposedReplies.clear()
    stopObservingReplies()
    view++
    rows.clear()
    list.replaceChildren()
    scroll.scrollTop = 0
    render()
    save()
  }

  /** @param {string} selected @param {string} [target] @param {boolean} [keepDay] */
  function showDay(selected, target, keepDay = false) {
    if (selected !== day) {
      selectDay(selected)
      scroll.scrollTop = selected === today && !target ? scroll.scrollHeight : 0
      if (selected === today && !target) input.focus({ preventScroll: true })
    }
    const located = target && locate(target)
    void refresh(located ? undefined : target, keepDay)
  }

  /** @param {NotebookEntry} entry */
  async function strike(entry) {
    if (striking.has(entry.id)) return
    const selected = entry.day
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

  function syncOfflineDate() {
    if (knowsToday) return
    const localDay = notebookDay()
    if (localDay === today) return
    const wasToday = day === today
    today = localDay
    if (wasToday) selectDay(today)
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
    syncOfflineDate()
    if (day !== today) return
    const body = input.value.trim().replaceAll('\0', '')
    if (!body || Array.from(body).length > 4000) return
    queue.add({ body, clientId: crypto.randomUUID(), day: today, createdAt: Date.now() })
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
  document.addEventListener('visibilitychange', () => {
    // Reobserve on return so even an unchanged intersection is reported again.
    stopObservingReplies()
    observeReplies()
    scheduleSeen()
  })
  window.addEventListener('online', () => {
    if (initialized) void retry()
    if (active) void refresh()
  })

  return {
    /** @param {string} [targetDay] */
    open(targetDay) {
      if (active) {
        if (targetDay) showDay(targetDay, undefined, true)
        return
      }
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
          timeZone = cached.timeZone
          pen = cached.pen ?? DEFAULT_PEN
          penPending = cached.penPending ?? !cached.pen
          if (cached.today) {
            today = cached.today
            knowsToday = true
          }
          pages.set(day, cached.entries.map(entry => ({ ...entry, day: entry.day ?? day })))
        }
      }
      syncOfflineDate()
      if (targetDay && targetDay !== day) selectDay(targetDay)
      render()
      resizeInput()
      if (day === today) input.focus({ preventScroll: true })
      void refresh(undefined, !!targetDay)
      void retry()
      pollTimer = window.setInterval(() => {
        syncOfflineDate()
        void refresh()
      }, 60_000)
    },
    close() {
      if (!active) return
      active = false
      view++
      stopObservingReplies()
      window.clearInterval(pollTimer)
      window.clearTimeout(statusTimer)
    },
  }
}
