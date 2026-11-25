import type { NotebookEntryT, NotebookPaperT } from '@wechat-cc/protocol'
import type { Lang } from '../i18n'
import { uuid } from '../net/uuid'
import type { Backend } from './types'

export function demoNotebook(now: () => number, lang: () => Lang) {
  const offsetDay = (offset: number) => new Date(now() - offset * 86_400_000).toISOString().slice(0, 10)
  let paper: NotebookPaperT = 'ruled'
  let written: NotebookEntryT[] = []
  let resetCount = 0
  const strikes = new Map<string, number | null>()
  const seen = new Set<string>()
  const demoId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  function examples(): NotebookEntryT[] {
    const row = (n: number, offset: number, author: NotebookEntryT['author'], zh: string, en: string,
      extra: Partial<NotebookEntryT> = {}): NotebookEntryT => {
      const day = offsetDay(offset)
      return { id: demoId(n), day, author, body: lang() === 'en' ? en : zh,
        createdAt: Date.parse(`${day}T00:00:00Z`) + n, refId: null, struckAt: null, origin: 'desktop', clientId: null, ...extra }
    }
    return [
      row(1, 8, 'owner', '记得带上本子，去河边坐一会儿。', 'Take the notebook and sit by the river.'),
      row(2, 1, 'owner', '窗边那盆薄荷长出新叶了。', 'The mint by the window has new leaves.'),
      row(3, 1, 'owner', '周六去买一盆新的。', 'Buy another pot on Saturday.', { struckAt: now() }),
      row(4, 0, 'owner', '今天走回家，河上有一层雾。', 'I walked home today. A layer of mist hung over the river.'),
      row(5, 0, 'cc', '你上回说想在河边坐一会儿。我也记得。', 'You wanted to sit by the river the other day. I remember.', {
        id: demoId(5 + resetCount * 10), refId: demoId(1), refDay: offsetDay(8),
      }),
    ]
  }
  const backend: Pick<Backend, 'notebookPage' | 'notebookUnseen' | 'notebookSeen' | 'notebookWrite' | 'notebookStrike' | 'notebookPaper'> = {
    async notebookPage(query) {
      const today = offsetDay(0), day = query.day ?? today
      const all = [...examples(), ...written]
      const entries = all.filter(row => row.day === day).sort((a, b) => a.createdAt - b.createdAt)
      return { today, day, days: [...new Set(all.map(row => row.day))],
        entries: entries.slice(query.after ? entries.findIndex(row => row.id === query.after) + 1 : 0)
          .map(row => strikes.has(row.id) ? { ...row, struckAt: strikes.get(row.id) ?? null } : row),
        paper, pen: { font: 'kai', ink: 'blueBlack', reason: '' }, penPending: false }
    },
    async notebookUnseen() {
      return examples().find(row => row.author === 'cc' && row.refId !== null && !seen.has(row.id))?.day
    },
    async notebookSeen(ids) { for (const id of ids) seen.add(id) },
    async notebookWrite({ body, clientId }) {
      const previous = written.find(row => row.clientId === clientId)
      if (previous) return previous
      const entry: NotebookEntryT = { id: uuid(), body, clientId, author: 'owner', day: offsetDay(0),
        createdAt: now(), refId: null, struckAt: null, origin: 'app' }
      written.push(entry)
      return entry
    },
    async notebookStrike(id, struck) { strikes.set(id, struck ? now() : null) },
    async notebookPaper(next) { paper = next; return paper },
  }
  return { backend, reset() { paper = 'ruled'; written = []; strikes.clear(); seen.clear(); resetCount++ } }
}
