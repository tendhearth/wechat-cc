/**
 * wire-speech.ts —— 造 daemon 里唯一的 SpeechPolicy(第三批 3a,设计稿 2026-10-21-speech-policy-design)。
 *
 * care 档与免打扰跟伙伴一拍读的是同一份:chat-prefs + companion/calibration 的 careLevel(主人没设 ⇒ low,
 * 别的对话没设 ⇒ off)+ 主人时区下的 quietEndsAt。往哪儿送仍是 proactive-channel 的事。账进 speech_log(v84)。
 * 主动开口的各条路逐个迁过来,迁一处就把 scripts/speech-send.guard.test.ts 的数字调下来。
 */
import type { Db } from '../../lib/db'
import { quietEndsAt } from '../../core/quiet-hours'
import type { ChatPrefsStore } from '../chat-prefs'
import { careLevel } from '../companion/calibration'
import { loadCompanionConfig } from '../companion/config'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { makeSpeechLedgerStore } from '../speech/ledger-store'
import { makeSpeechPolicy, type SpeechPolicy } from '../speech/policy'
import { makePendingNotices } from '../speech/pending-notices'

export function wireSpeech(d: {
  stateDir: string
  db: Db
  chatPrefs: Pick<ChatPrefsStore, 'get'>
  proactive: ProactiveOutbound
  log: (tag: string, line: string) => void
  now?: () => number
}): SpeechPolicy {
  const ledger = makeSpeechLedgerStore(d.db, d.now ? { now: d.now } : {})
  return makeSpeechPolicy({
    care: (chatId) => careLevel(chatId, d.chatPrefs.get(chatId), loadCompanionConfig(d.stateDir).default_chat_id ?? undefined),
    quietEndsAt: (chatId, nowMs) => quietEndsAt(d.chatPrefs.get(chatId).quiet, nowMs, loadCompanionConfig(d.stateDir).timezone),
    outbound: d.proactive,
    ledger: (e) => ledger.append(e),
    log: d.log,
    // report / blocking 被推后不丢:落盘待说,startPendingFlush 那一拍补说(defer 不是不送)
    pending: makePendingNotices({ stateDir: d.stateDir, log: d.log, ...(d.now ? { now: d.now } : {}) }),
    ...(d.now ? { now: d.now } : {}),
  })
}
