/** 每晚整理的素材来源(薄适配,真库):观察、里程碑、上次整理以来的聊天、可选的本机 Claude 记忆。 */
import type { Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { summarizeProjectMemories } from '../../lib/memory-synthesis'
import { loadCompanionConfig } from '../companion/config'
import { makeMilestonesStore } from '../milestones/store'
import { makeObservationsStore } from '../observations/store'
import type { NightlySources } from './nightly'

const FIRST_RUN_LOOKBACK_MS = 3 * 86_400_000

export function makeNightlySources(o: { db: Db; stateDir: string; ownerChatId: () => string | null }): NightlySources {
  return {
    async observationsSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      return (await makeObservationsStore(o.db, c).listActive()).filter(r => !since || r.ts > since).map(r => `- ${r.ts.slice(0, 10)} ${r.body}`)
    },
    async milestonesSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      return (await makeMilestonesStore(o.db, c).list()).filter(r => !since || r.ts > since).map(r => `- ${r.ts.slice(0, 10)} ${r.body}`)
    },
    async messagesSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      const from = since ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString()
      // listRange 取最新 400 条(升序),再按 from 截 —— 素材超额时保留最新的聊天,而不是最旧的
      // (listSince 是 ASC LIMIT,会丢掉最新的;sinceIso 只前进,丢了就永远看不到)。
      const rows = (await makeMessagesStore(o.db).listRange(c, { limit: 400 })).filter(m => m.ts > from)
      return rows.filter(m => m.kind === 'text' && m.text.trim()).map(m => `${m.direction === 'in' ? '主人' : 'CC'}:${m.text.slice(0, 300)}`).slice(-200)
    },
    projectMemory() {
      if (!loadCompanionConfig(o.stateDir).import_local_history) return ''
      return summarizeProjectMemories().map(p => `# ${p.name}\n${p.files.map(f => f.content).join('\n')}`).join('\n\n').slice(0, 6000)
    },
  }
}
