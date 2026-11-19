import type { NotebookChatReadResponseT, NotebookPageResponseT } from '@wechat-cc/protocol'
import type { NotebookEntry, NotebookPaper, NotebookPen, NotebookRow } from '../domain/notebook'

export interface NotebookSettings {
  pen: NotebookPen
  paper: NotebookPaper
  initiative: { lastAt: number; day: string; attempts: number; failures: number; retryAt: number }
}
export interface NotebookStore {
  get<K extends keyof NotebookSettings>(key: K): NotebookSettings[K] | null
  set<K extends keyof NotebookSettings>(key: K, value: NotebookSettings[K]): void
  append(entry: Omit<NotebookRow, 'id' | 'struckAt'>): NotebookRow
  strike(id: string, at: number | null): 'ok' | 'missing' | 'cc'
  byId(id: string): NotebookRow | null
  referenceTimestamps(ids: readonly string[]): { id: string; createdAt: number }[]
  occupiedDays(timezone: string): readonly string[]
  list(options?: { since?: number; until?: number; limit?: number; query?: string; olderThan?: string; ownerOnly?: boolean }): NotebookRow[]
  atomic<T>(fn: () => T): T
}

export interface NotebookCaller {
  tier: string
  origin: string
  chatId?: string
  sharedTurn?: string
  turnChatId?: string
}
export interface Notebook {
  open(origin: 'desktop' | 'app', fonts?: string): Promise<void> | undefined
  page(day?: string): NotebookPageResponseT
  write(body: string, clientId: string, origin: 'desktop' | 'app'): NotebookEntry
  strike(id: string, struck: boolean): 'ok' | 'missing' | 'cc'
  paper(paper: NotebookPaper): NotebookPaper
  isOwner(caller: NotebookCaller): boolean
  jot(text: string): NotebookEntry
  read(days: number, query?: string, after?: string): NotebookChatReadResponseT
  tick(): Promise<void>
}
