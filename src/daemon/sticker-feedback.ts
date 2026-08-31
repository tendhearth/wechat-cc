import { join } from 'node:path'
import { makeStateStore } from './state-store'

export type StickerFeedbackSignal = 'positive' | 'negative'

export interface StickerFeedback {
  remember(chatId: string, file: string): void
  last(chatId: string): string | null
  rate(chatId: string, signal: StickerFeedbackSignal, file?: string): string | null
  weight(chatId: string, file: string): number
}

type RecordValue = { file: string; score: number; updatedAt: number }

export function makeStickerFeedback(stateDir: string): StickerFeedback {
  const store = makeStateStore(join(stateDir, 'stickers', 'feedback.json'), { debounceMs: 0 })
  return {
    remember(chatId, file) {
      store.set(`last:${chatId}`, file)
      const key = `${chatId}:${file}`
      const old = parse(store.get(key))
      store.set(key, JSON.stringify({ file, score: old?.score ?? 0, updatedAt: Date.now() } satisfies RecordValue))
    },
    last(chatId) { return store.get(`last:${chatId}`) ?? null },
    rate(chatId, signal, file) {
      const target = file ?? store.get(`last:${chatId}`)
      if (!target) return null
      const key = `${chatId}:${target}`
      const old = parse(store.get(key))
      const score = Math.max(-5, Math.min(5, (old?.score ?? 0) + (signal === 'positive' ? 1 : -2)))
      store.set(key, JSON.stringify({ file: target, score, updatedAt: Date.now() } satisfies RecordValue))
      return target
    },
    weight(chatId, file) {
      const record = parse(store.get(`${chatId}:${file}`))
      return record ? Math.max(0.1, 1 + record.score * 0.35) : 1
    },
  }
}

function parse(raw: string | undefined): RecordValue | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    return typeof v.file === 'string' && typeof v.score === 'number' && typeof v.updatedAt === 'number'
      ? { file: v.file, score: v.score, updatedAt: v.updatedAt } : null
  } catch { return null }
}
