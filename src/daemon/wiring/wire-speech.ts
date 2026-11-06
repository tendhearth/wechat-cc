/**
 * wire-speech.ts —— 造 daemon 里唯一的 SpeechPolicy(第三批 3a,设计稿 2026-10-21-speech-policy-design)。
 *
 * care 档与免打扰跟伙伴一拍读的是同一份:chat-prefs + companion/calibration 的 careLevel(主人没设 ⇒ low,
 * 别的对话没设 ⇒ off)+ 主人时区下的 quietEndsAt。往哪儿送仍是 proactive-channel 的事。账进 speech_log(v84)。
 * 主动开口的各条路逐个迁过来,迁一处就把 scripts/speech-send.guard.test.ts 的数字调下来。
 */
import type { Db } from '../../lib/db'
import { originOf } from '../../domain/speech/kinds'
import { quietEndsAt } from '../../domain/quiet-hours'
import type { ChatPrefsStore } from '../chat-prefs'
import { careLevel } from '../../features/companion'
import { loadCompanionConfig } from '../../lib/companion-config'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { makeSpeechLedgerStore } from '../speech/ledger-store'
import { makeSpeechPolicy, type SpeechPolicy } from '../speech/policy'
import { makeSpeechReservations } from '../speech/reservations'
import { makeSpeechPicker } from '../speech/picker'
import { makeProposalSubmissions } from '../speech/proposal-submissions'
import { readPlanLogDays, appendPlanLog } from '../../features/companion'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeObservationsStore } from '../observations/store'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makePendingNotices } from '../speech/pending-notices'

export function wireSpeech(d: {
  stateDir: string
  db: Db
  chatPrefs: Pick<ChatPrefsStore, 'get'>
  proactive: ProactiveOutbound
  log: (tag: string, line: string) => void
  /** 补说明信片(S2c):微信发文件,成了 ⇒ true。 */
  sendFile?: (chatId: string, path: string) => Promise<boolean>
  evaluator?: () => ((prompt: string) => Promise<string>) | null
  now?: () => number
}): SpeechPolicy {
  const ledger = makeSpeechLedgerStore(d.db, d.now ? { now: d.now } : {})
  const now = d.now ?? Date.now
  const reservations = makeSpeechReservations(d.db)
  reservations.recover()
  return makeSpeechPolicy({
    proposals: (execute, peek) => makeProposalSubmissions((sources, sourceContext) => makeSpeechPicker({
      sources, reservations, execute, peek, now, log: d.log,
      expired: p => ledger.append({ kind: p.kind, origin: originOf(p.kind), chatId: p.recipient, ref: p.ref, outcome: 'dropped', reason: 'expired', channel: null, ts: new Date(now()).toISOString() }),
      evaluator: d.evaluator ?? (() => null),
      lastBackoff: recipient => {
        const last = readPlanLogDays(d.stateDir, 14).filter(e => e.chatId === recipient && (e.backoff || (e.backoff === undefined && e.decision === 'none' && (e.source === 'model' || e.source === 'downgraded')))).at(-1)
        return last ? Date.parse(last.at) : null
      },
      record(recipient, at, choice, why, backoff, candidates, source) {
        const iso = new Date(at).toISOString()
        appendPlanLog(d.stateDir, iso.slice(0, 10), { at: iso, chatId: recipient, candidates, decision: choice ?? 'none', why, source, backoff })
      },
      async context(recipient, candidates) {
        let persona = '', observations: object[] = []
        try { persona = readFileSync(join(d.stateDir, 'memory', recipient, 'persona.md'), 'utf8').slice(0, 300) } catch { /* no persona */ }
        try { observations = (await makeObservationsStore(d.db, recipient).listActive()).slice(-3).map(o => ({ tone: o.tone, body: o.body.slice(0, 80) })) } catch { /* no observations */ }
        return { now: now(), persona, observations, lastInbound: await makeMessagesStore(d.db).latestInboundTs(recipient), lastInitiativeAt: ledger.lastInitiativeAt(recipient), earlierToday: readPlanLogDays(d.stateDir, 2).filter(e => e.chatId === recipient).slice(-5), sources: await sourceContext(candidates) }
      },
    }), now),
    care: (chatId) => careLevel(chatId, d.chatPrefs.get(chatId), loadCompanionConfig(d.stateDir).default_chat_id ?? undefined),
    quietEndsAt: (chatId, nowMs) => quietEndsAt(d.chatPrefs.get(chatId).quiet, nowMs, loadCompanionConfig(d.stateDir).timezone),
    outbound: d.proactive,
    ledger: (e) => ledger.append(e),
    log: d.log,
    // report / blocking 被推后不丢:落盘待说,startPendingFlush 那一拍补说(defer 不是不送)
    // S2b 起在主库 speech_pending;旧的 speech/pending-notices.json 第一次开机时读进来(改名 .migrated)
    pending: makePendingNotices({ db: d.db, stateDir: d.stateDir, log: d.log, ...(d.now ? { now: d.now } : {}) }),
    ...(d.sendFile ? { sendFile: d.sendFile } : {}),
    ...(d.now ? { now: d.now } : {}),
  })
}
