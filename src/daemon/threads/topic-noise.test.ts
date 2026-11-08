import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeAppChannel } from '../companion/app-channel'
import { makeProactiveOutbound } from '../companion/proactive-channel'
import { makeSpeechPolicy } from '../speech/policy'
import { makePendingNotices } from '../speech/pending-notices'

describe('speech provenance survives delivery and deferred merging', () => {
  it.each([false, true])('upgrade_notice is marked on persisted messages; App fallback=%s', async fallback => {
    const db = openTestDb(), messages = makeMessagesStore(db)
    try {
      let seq = 0
      const app = makeAppChannel({ ownerChatId: () => 'owner', pushDevices: () => ['d'], onlineDevices: () => new Set(), relayOnline: () => true, append: r => messages.append(r), touched: () => {}, push: () => ({ sent: 1, online: 0 }), log: () => {} })
      const outbound = makeProactiveOutbound({ wechatDegraded: () => fallback, wechatClosedSince: () => null, app: () => app, log: () => {},
        sendWechat: async (chatId, text, metadata) => { await messages.append({ id: String(++seq), chatId, text, direction: 'out', kind: 'text', ts: new Date().toISOString(), source: metadata?.source ?? 'live' }); return { msgId: String(seq) } },
      })
      let quiet = true
      const pending = makePendingNotices({ db, log: () => {} })
      const speech = makeSpeechPolicy({ outbound, pending, care: () => 'low', quietEndsAt: () => quiet ? Date.now() + 60_000 : null, log: () => {} })
      await speech.tell('upgrade_notice', 'owner', 'auto upgrade marker')
      await speech.tell('matter_report', 'owner', 'owner project marker')
      quiet = false
      await speech.flushPending()
      await speech.flushPending()
      const rows = await messages.listRange('owner', { limit: 20 })
      expect(rows.find(r => r.text.includes('auto upgrade marker'))?.source).toBe('speech:upgrade_notice')
      const work = rows.find(r => r.text.includes('owner project marker'))
      expect(work).toBeDefined()
      expect(work!.source).not.toBe('speech:upgrade_notice')
      expect(work!.text).not.toContain('auto upgrade marker')
    } finally { db.close() }
  })
})
