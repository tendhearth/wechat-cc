import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { NotebookBody, type NotebookEntryT, type NotebookPageResponseT, type NotebookPaperT } from '@wechat-cc/protocol'
import type { Backend } from '../backend/types'
import { clearNotebookStorage, notebookStorage } from '../net/notebook-storage'
import { uuid } from '../net/uuid'
import { acknowledgeNotebookLine, flushNotebookQueue, notebookLineKey, readNotebookPage, type PendingLine } from '../view/notebook'
import { useBackendCtx } from './BackendProvider'

let notebookId = 0
let activeBackend: Backend | undefined
const notebooks = new WeakMap<Backend, ReturnType<typeof makeNotebook>>()

function makeNotebook(backend: Backend, scope: string | null) {
  const current = () => backend === activeBackend
  const disk = backend.mode === 'live' && scope ? notebookStorage(scope, current) : undefined
  let pending: PendingLine[] = []
  let pages = new Map<string, NotebookPageResponseT>()
  let metadata: NotebookPageResponseT | undefined
  let selected: string | undefined
  let draft = ''
  let revision = 0
  let reading: Promise<void> | undefined
  let readingSelection: string | undefined
  let flushing = false
  let changing = false
  let locallyChanged = false
  const receipts = new Map<string, NotebookEntryT>()
  const listeners = new Set<() => void>()

  function snapshot() {
    const today = metadata?.today
    const day = selected ?? today
    const entries = pages.get(day ?? '')?.entries ?? []
    const visibleReceipts = [...receipts.values()].filter(row => day === undefined || row.day === day)
    const seen = new Set(entries.map(notebookLineKey))
    return { today, day, draft, pending, entries: [...entries, ...visibleReceipts.filter(row => !seen.has(notebookLineKey(row)))],
      paper: metadata?.paper ?? 'ruled', pen: metadata?.pen, penPending: metadata?.penPending ?? false, days: [...new Set([
        ...(metadata?.days ?? []), ...[...receipts.values()].map(row => row.day), ...pending.flatMap(row => row.day ? [row.day] : []),
      ])] }
  }
  let value = snapshot()
  function publish() { value = snapshot(); for (const listener of listeners) listener() }

  const cacheReady = disk?.loadPage().then(page => {
    if (!page || !current()) return
    metadata = page
    pages.set(page.day, page)
    if (!locallyChanged && page.day !== page.today) selected = page.day
    publish()
  }).catch(() => {})
  let queueReady: Promise<void> | undefined
  function loadQueue() {
    if (!disk) return
    return queueReady ??= disk.loadQueue().then(rows => {
      if (!rows || !current()) return
      pending = [...rows, ...pending]
      publish()
    }).catch(error => { queueReady = undefined; throw error })
  }
  void loadQueue()?.catch(() => {})
  const saveQueue = async () => { await loadQueue(); await disk?.saveQueue(pending) }
  const savePage = () => {
    const page = pages.get(value.day ?? '')
    if (page && metadata) void disk?.savePage({ ...metadata, day: page.day, entries: page.entries }).catch(() => {})
  }

  async function refresh() {
    await cacheReady
    if (!current()) return
    if (reading && readingSelection === selected) return reading
    const target = selected
    const stamp = revision
    readingSelection = target
    let rolledOver = false
    const task = readNotebookPage(query => backend.notebookPage(query), target).then(page => {
      if (!current() || selected !== target || stamp !== revision) return
      pages.set(page.day, page)
      const confirmed = new Set(page.entries.filter(entry => entry.author === 'owner').map(notebookLineKey))
      for (const entry of page.entries) receipts.delete(notebookLineKey(entry))
      const remaining = pending.filter(row => !confirmed.has(row.clientId))
      const needsSave = remaining.length !== pending.length || remaining.some(row => !row.day)
      if (needsSave) {
        pending = remaining.map(row => row.day ? row : { ...row, day: page.today })
        void saveQueue().catch(() => {})
      }
      metadata = page
      rolledOver = target === undefined && page.day !== page.today
      publish()
      savePage()
    }).catch(() => {})
    reading = task
    await task
    if (reading === task) reading = undefined
    if (current() && selected === target && (rolledOver || stamp !== revision)) void refresh()
  }

  async function flush(active: () => boolean) {
    if (flushing || !current()) return
    flushing = true
    try {
      await loadQueue()
      const attempted = new Set<string>()
      while (current() && active()) {
        const rows = pending.filter(row => !attempted.has(row.clientId))
        if (!rows.length) break
        await disk?.saveQueue(pending)
        if (backend.connection().state !== 'online') break
        for (const row of rows) attempted.add(row.clientId)
        await flushNotebookQueue(rows, input => backend.notebookWrite(input), entry => {
          if (!current() || !pending.some(row => row.clientId === entry.clientId)) return
          revision++
          receipts.set(notebookLineKey(entry), entry)
          const acknowledged = acknowledgeNotebookLine(pending, pages, entry)
          pending = acknowledged.pending
          pages = acknowledged.pages
          publish()
          savePage()
          if (entry.day !== metadata?.today) void refresh()
        }, () => current() && active() && backend.connection().state === 'online')
        await saveQueue()
      }
    } catch { /* Local storage or transport will be retried while the page is open. */ }
    finally { flushing = false }
  }

  return {
    id: ++notebookId,
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh, flush,
    select(day?: string) {
      locallyChanged = true
      selected = day === metadata?.today ? undefined : day
      revision++
      publish()
      savePage()
      void refresh()
    },
    setDraft(text: string) { locallyChanged = true; draft = text; publish() },
    write(active: () => boolean) {
      const body = draft
      if (value.day !== value.today || !NotebookBody.safeParse(body).success) return
      locallyChanged = true
      pending = [...pending, { clientId: uuid(), body, day: metadata?.today, createdAt: Date.now() }]
      draft = ''
      publish()
      void saveQueue().catch(() => {})
      void flush(active)
    },
    async paper(paper: NotebookPaperT) {
      if (changing) return
      changing = true
      try {
        const result = await backend.notebookPaper(paper)
        if (current() && metadata) { revision++; metadata = { ...metadata, paper: result }; publish(); savePage() }
        else void refresh()
      } catch { /* Keep the last known paper. */ }
      finally { changing = false }
    },
    async strike(entry: NotebookEntryT) {
      const struck = entry.struckAt === null
      try {
        await backend.notebookStrike(entry.id, struck)
        if (!current()) return
        revision++
        const page = pages.get(entry.day)
        if (page) pages.set(entry.day, { ...page, entries: page.entries.map(row => row.id === entry.id ? { ...row, struckAt: struck ? Date.now() : null } : row) })
        const key = notebookLineKey(entry)
        if (receipts.has(key)) receipts.set(key, { ...entry, struckAt: struck ? Date.now() : null })
        publish()
        savePage()
        void refresh()
      } catch { /* Keep the last known entry. */ }
    },
  }
}

export function NotebookCache() {
  const { backend, inputScope } = useBackendCtx()
  useLayoutEffect(() => {
    activeBackend = backend
    if (backend.mode === 'demo') void clearNotebookStorage(() => activeBackend === backend).catch(() => {})
    if (!notebooks.has(backend)) notebooks.set(backend, makeNotebook(backend, inputScope))
    return () => { if (activeBackend === backend) activeBackend = undefined }
  }, [backend, inputScope])
  return null
}

export function useNotebook() {
  const { backend, inputScope } = useBackendCtx()
  const notebook = useMemo(() => {
    const known = notebooks.get(backend)
    if (known) return known
    const created = makeNotebook(backend, inputScope)
    notebooks.set(backend, created)
    return created
  }, [backend, inputScope])
  return { notebook, value: useSyncExternalStore(notebook.subscribe, notebook.getSnapshot, notebook.getSnapshot) }
}
