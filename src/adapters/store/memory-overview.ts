import type { Db } from '../../lib/db'
import { overviewForOthers } from '../../lib/memory-owner'
import { makeMemoryFactsStore } from './memory-facts'

/**
 * 对外(串门「CC 眼中的主人」)用的那份总览(架构终态 G8):从主库的缓存读,不读 _overview.md 文件。
 * 过期是因为收回 ⇒ 不给(那句话可能正好在里面);只是源里多了东西 ⇒ 开头贴一句「哪天整理的、之后又有变化」;
 * 一律经 overviewForOthers 去掉主人原话那一节。没有 ⇒ ''。
 */
export function overviewForOthersFromTable(db: Db, chatId: string): string {
  const f = makeMemoryFactsStore(db).fence(chatId)
  const body = f.body('overview')
  if (!body) return ''
  const status = f.status('overview')
  if (status === 'retracted') return ''
  const at = f.generatedAt('overview')
  const day = at ? new Date(at).toISOString().slice(0, 10) : ''
  const label = status === 'added' ? `> (这份整体理解是${day ? ` ${day} ` : '之前'}整理的,之后记忆又有变化,可能不全。)\n\n` : ''
  return overviewForOthers(label + body)
}

