import type { NotebookEntryT, NotebookPageQueryT, NotebookPageResponseT, NotebookPenT } from '@wechat-cc/protocol'
import { t, type Lang } from '../i18n'
import { notebookInks } from '../ui/tokens'

export const NOTEBOOK_FONT_KEYS = 'kai,hand,fangsong,songItalic'
const families = { kai: 'THPenKai-Regular', hand: 'THPenHand-Regular', fangsong: 'THPenFangsong-Regular', songItalic: undefined } as const
export function notebookPen(pen: NotebookPenT) {
  return { family: families[pen.font], color: notebookInks[pen.ink] }
}

const englishMonth = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' })
export function notebookDate(day: string | undefined, lang: Lang, today?: string) {
  if (!day || day === today) return t(lang, 'notebook.today')
  const [, month, date] = day.split('-')
  return t(lang, 'notebook.date', { month: lang === 'en' ? englishMonth.format(new Date(`${day}T00:00:00Z`)) : Number(month), day: Number(date) })
}

export function notebookPeriod(timestamp: number, timeZone?: string) {
  const hour = timeZone === undefined ? new Date(timestamp).getHours()
    : Number(new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(timestamp))
  if (hour < 5 || hour >= 20) return 'night'
  if (hour < 8) return 'dawn'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

export function notebookSignature(entry: NotebookEntryT, next: NotebookEntryT | undefined, lang: Lang, timeZone?: string) {
  if (entry.author !== 'cc') return null
  const period = notebookPeriod(entry.createdAt, timeZone)
  if (next?.author === 'cc' && next.day === entry.day && notebookPeriod(next.createdAt, timeZone) === period) return null
  return t(lang, 'notebook.signature', { period: t(lang, `notebook.${period}`) })
}

export function notebookNeighbors(day: string | undefined, days: readonly string[]) {
  if (!day) return {}
  const ordered = [...new Set(days)].sort()
  return { previous: ordered.filter(date => date < day).pop(), next: ordered.find(date => date > day) }
}

export async function readNotebookPage(read: (query: NotebookPageQueryT) => Promise<NotebookPageResponseT>, day?: string) {
  const first = await read({ day, fonts: NOTEBOOK_FONT_KEYS })
  const entries = new Map(first.entries.map(entry => [entry.id, entry]))
  const cursors = new Set<string>()
  let last = first
  while (last.nextAfter) {
    const after = last.nextAfter
    if (cursors.has(after)) throw new Error('notebook_cursor_repeated')
    cursors.add(after)
    last = await read({ day: first.day, after, fonts: NOTEBOOK_FONT_KEYS })
    if (last.day !== first.day) throw new Error('notebook_page_changed')
    for (const entry of last.entries) entries.set(entry.id, entry)
  }
  return { ...last, entries: [...entries.values()] }
}

export type PendingLine = { clientId: string; body: string; day?: string; createdAt: number }
export const notebookLineKey = (entry: NotebookEntryT) => entry.clientId ?? entry.id
export const NOTEBOOK_UNSAVED_MS = 5000

export function notebookLines(entries: readonly NotebookEntryT[], pending: readonly PendingLine[], day?: string, today?: string) {
  const saved = new Set(entries.map(notebookLineKey))
  const unsaved = pending.filter(row => (row.day ?? today) === day && !saved.has(row.clientId))
  return [...entries, ...unsaved.map((row): NotebookEntryT => ({
    ...row, id: row.clientId, day: day ?? '', author: 'owner', origin: 'app', struckAt: null, refId: null,
  }))].sort((a, b) => a.createdAt - b.createdAt)
}

export async function flushNotebookQueue(
  rows: readonly PendingLine[],
  send: (input: { body: string; clientId: string }) => Promise<NotebookEntryT>,
  acknowledge: (entry: NotebookEntryT) => void | Promise<void>,
  active: () => boolean = () => true,
) {
  for (const { body, clientId } of rows) {
    if (!active()) return
    try {
      const entry = await send({ body, clientId })
      if (entry.clientId === clientId) await acknowledge(entry)
    } catch { /* The next flush will reuse the same clientId. */ }
  }
}

export function acknowledgeNotebookLine(pending: readonly PendingLine[], pages: ReadonlyMap<string, NotebookPageResponseT>, entry: NotebookEntryT) {
  const next = new Map(pages)
  const page = next.get(entry.day)
  if (page) next.set(entry.day, {
    ...page, entries: [...page.entries.filter(row => notebookLineKey(row) !== notebookLineKey(entry)), entry],
  })
  return { pending: pending.filter(row => row.clientId !== entry.clientId), pages: next }
}
