import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { makeChatPrefs } from '../chat-prefs'
import { saveCompanionConfig, loadCompanionConfig } from '../companion/config'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { makeSpeechLedgerStore } from '../speech/ledger-store'
import { wireSpeech } from './wire-speech'

const OWNER = 'owner@im.wechat'
const outbound = (): ProactiveOutbound => ({
  appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
  open: () => ({ sendText: async () => ({ msgId: 'm' }), channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }),
})

describe('wireSpeech —— care 档、免打扰跟伙伴一拍读同一份;账记进 speech_log', () => {
  it('主人没设 care ⇒ low,照说;设了「别烦我」⇒ initiative 被拒、blocking 照说;免打扰按主人时区推后;每次判定都进账', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-speech-'))
    const db = openTestDb()
    try {
      saveCompanionConfig(dir, { ...loadCompanionConfig(dir), default_chat_id: OWNER, timezone: 'Asia/Shanghai' })
      const chatPrefs = makeChatPrefs(dir)
      let now = Date.parse('2026-10-21T02:00:00.000Z') // 上海 10:00
      const speech = wireSpeech({ stateDir: dir, db, chatPrefs, proactive: outbound(), log: () => {}, now: () => now })
      expect(await speech.say({ kind: 'companion', chatId: OWNER }, async () => {})).toMatchObject({ allow: true })
      chatPrefs.set(OWNER, { care: 'off' })
      expect(await speech.say({ kind: 'guest_visit', chatId: OWNER }, async () => {})).toEqual({ drop: true, reason: 'care_off' })
      expect(await speech.say({ kind: 'permission_ask', chatId: OWNER }, async () => {})).toMatchObject({ allow: true })
      chatPrefs.set(OWNER, { care: 'low', quiet: { from: '09:00', to: '12:00' } })
      expect(await speech.say({ kind: 'matter_report', chatId: OWNER }, async () => {})).toEqual({ defer: true, until: '2026-10-21T04:00:00.000Z', reason: 'quiet_hours' })
      // 别的对话没设 care ⇒ off(伙伴一拍的口径:只有主人默认开)
      expect(await speech.say({ kind: 'companion', chatId: 'friend@im.wechat' }, async () => {})).toEqual({ drop: true, reason: 'care_off' })
      now += 1
      expect(makeSpeechLedgerStore(db).recent(OWNER, 0).map(e => e.outcome)).toEqual(['deferred', 'allowed', 'dropped', 'allowed'])
    } finally { db.close() }
  })
})
