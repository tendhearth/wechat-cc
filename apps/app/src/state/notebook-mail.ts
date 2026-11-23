import type { NotebookEntryT } from '@wechat-cc/protocol'
import type { Backend } from '../backend/types'

export function canCheckNotebookMail(paired: boolean, online: boolean, foreground: boolean, home: boolean) {
  return paired && online && foreground && home
}

export function isNotebookReply(entry: Pick<NotebookEntryT, 'author' | 'refId'>) {
  return entry.author === 'cc' && entry.refId !== null
}

export function notebookReplyVisible(top: number, height: number, scrollTop: number, viewportHeight: number) {
  const visible = Math.min(top + height, scrollTop + viewportHeight) - Math.max(top, scrollTop)
  return height > 0 && visible >= height / 2
}

type MailBackend = Pick<Backend, 'connection' | 'notebookUnseen' | 'notebookSeen'>

export function makeNotebookMail(backend: MailBackend) {
  const sent = new Set<string>()
  const pending = new Set<string>()
  const listeners = new Set<() => void>()
  let day: string | undefined
  let reading: { scope: () => boolean; task: Promise<void> } | undefined
  let sending = false

  function refresh(allowed: () => boolean, afterSeen = false) {
    if (!allowed() || backend.connection().state !== 'online') return
    if (reading?.scope === allowed && !afterSeen) return reading.task
    const task = Promise.resolve().then(async () => {
      let next: string | undefined
      if (!allowed() || backend.connection().state !== 'online') return
      try { next = await backend.notebookUnseen() } catch { /* No indicator for an unreadable response. */ }
      if (reading?.task === task && day !== next) {
        day = next
        for (const listener of listeners) listener()
      }
    }).finally(() => { if (reading?.task === task) reading = undefined })
    reading = { scope: allowed, task }
    return task
  }

  async function flush(visible: () => boolean, foreground: () => boolean) {
    if (sending) return
    sending = true
    try {
      while (pending.size && visible() && foreground() && backend.connection().state === 'online') {
        const ids = [...pending].slice(0, 50)
        await backend.notebookSeen(ids)
        for (const id of ids) {
          pending.delete(id)
          sent.add(id)
        }
        // A confirmation invalidates any older read, including one just made on return to Home.
        void refresh(foreground, true)
      }
    } catch { /* Keep the IDs for the next attempt while the notebook is visible. */ }
    finally { sending = false }
  }

  return {
    day: () => day,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    flush,
    observe(ids: readonly string[], visible: () => boolean, foreground: () => boolean) {
      if (!visible() || !foreground()) return
      const fresh = ids.filter(id => !pending.has(id) && !sent.has(id))
      if (!fresh.length) return
      for (const id of fresh) pending.add(id)
      return flush(visible, foreground)
    },
  }
}

const mailboxes = new WeakMap<Backend, ReturnType<typeof makeNotebookMail>>()

export function notebookMail(backend: Backend) {
  const existing = mailboxes.get(backend)
  if (existing) return existing
  const mail = makeNotebookMail(backend)
  mailboxes.set(backend, mail)
  return mail
}
