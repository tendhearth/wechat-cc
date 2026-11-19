// @ts-check
/** @typedef {{ clientId: string, body: string, day: string, createdAt: number }} NotebookPending */
/** @typedef {import('@wechat-cc/protocol').NotebookEntryT} NotebookEntry */
/** @typedef {import('@wechat-cc/protocol').NotebookPenT} NotebookPen */

export const NOTEBOOK_QUEUE_KEY = 'tendhearth.notebook.queue.v1'
export const NOTEBOOK_CACHE_KEY = 'tendhearth.notebook.page.v1'

/** @param {Storage | null} storage @param {string} key */
export function readNotebookStorage(storage, key) {
  try { return JSON.parse(storage?.getItem(key) ?? 'null') } catch { return null }
}

/** @param {Storage | null} storage @param {string} key @param {unknown} value */
export function writeNotebookStorage(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)) } catch { /* Keep writing in memory. */ }
}

/** @param {Date} [date] */
export function notebookDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** @param {string} day @param {string} [today] */
export function notebookDateLabel(day, today) {
  if (day === today) return '今天'
  const [, month, date] = day.split('-')
  return `${Number(month)} 月 ${Number(date)} 日`
}

/** @param {number} timestamp */
export function notebookPeriod(timestamp) {
  const hour = new Date(timestamp).getHours()
  if (hour < 5 || hour >= 20) return '夜里'
  if (hour < 8) return '清晨'
  if (hour < 12) return '上午'
  if (hour < 17) return '下午'
  return '傍晚'
}

const fonts = {
  kai: "'Kaiti SC', 'STKaiti', 'KaiTi', var(--th-font-serif)",
  fangsong: "'STFangsong', 'FangSong', var(--th-font-serif)",
  xingkai: "'Xingkai SC', 'STXingkai', var(--th-font-serif)",
  songItalic: 'var(--th-font-serif)',
}
const inks = {
  blueBlack: 'var(--th-notebook-blue-black)',
  darkGreen: 'var(--th-notebook-dark-green)',
  ochre: 'var(--th-notebook-ochre)',
  greyPurple: 'var(--th-notebook-grey-purple)',
}

/** @param {Pick<NotebookPen, 'font' | 'ink'>} pen */
export function notebookPenStyle(pen) {
  return {
    fontFamily: fonts[pen.font] ?? 'var(--th-font-serif)',
    fontStyle: pen.font === 'songItalic' ? 'italic' : 'normal',
    color: inks[pen.ink] ?? inks.blueBlack,
  }
}

/**
 * @param {Storage | null} storage
 * @param {(body: {body: string, clientId: string}) => Promise<NotebookEntry>} send
 * @param {(pending: NotebookPending, entry: NotebookEntry) => void} acknowledge
 */
export function createNotebookQueue(storage, send, acknowledge) {
  const cached = readNotebookStorage(storage, NOTEBOOK_QUEUE_KEY)
  /** @type {NotebookPending[]} */
  const pending = Array.isArray(cached) ? cached : []
  const persist = () => writeNotebookStorage(storage, NOTEBOOK_QUEUE_KEY, pending)
  let running = false

  return {
    entries: () => pending.slice(),
    /** @param {NotebookPending} entry */
    add(entry) {
      pending.push(entry)
      persist()
    },
    async flush() {
      if (running) return
      running = true
      const attempted = new Set()
      try {
        // Failed rows stay in the queue while later rows get their own attempt.
        let row
        while ((row = pending.find(item => !attempted.has(item.clientId)))) {
          attempted.add(row.clientId)
          try {
            const entry = await send({ body: row.body, clientId: row.clientId })
            if (entry?.clientId !== row.clientId) continue
            acknowledge(row, entry)
            pending.splice(pending.indexOf(row), 1)
            persist()
          } catch { /* Retry with the same clientId. */ }
        }
      } finally {
        running = false
      }
    },
  }
}
