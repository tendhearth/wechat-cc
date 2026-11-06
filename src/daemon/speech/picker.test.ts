import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { wireSpeech } from '../wiring/wire-speech'
import { loadCompanionConfig, saveCompanionConfig } from '../../lib/companion-config'
import { makeSpeechLedgerStore } from './ledger-store'
import { INITIATIVE_INTERVAL_MS } from './reservations'
import type { SpeechProposalRequest } from './policy'
import { readPlanLogDays } from '../../features/companion/plan-memory'
import { NetworkUnprotectedError } from '../../lib/network-gate'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })
function setup(evaluate: ((prompt: string) => Promise<string>) | null = null) {
  const db = openTestDb(), dir = mkdtempSync(join(tmpdir(), 'speech-picker-'))
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  saveCompanionConfig(dir, { ...loadCompanionConfig(dir), default_chat_id: 'owner', timezone: 'UTC' })
  let now = Date.parse('2026-11-06T12:00:00Z'), care: 'low' | 'off' = 'low', deliverable = true
  const sent: string[] = [], opened = vi.fn()
  const evaluator = vi.fn(() => evaluate)
  const speech = wireSpeech({ stateDir: dir, db, log: () => {}, now: () => now, evaluator,
    chatPrefs: { get: () => ({ care }) },
    proactive: { canDeliver: () => deliverable, appDeliverable: () => false, sendOnce: async () => ({ ok: false }), open: () => {
      opened()
      return { async sendText(_chat, text) { sent.push(text); return { msgId: text } }, channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => true, finish() {} }
    } },
  })
  const req = (source: 'letter' | 'memory' | 'brief' | 'visit', extra: Partial<SpeechProposalRequest> = {}): SpeechProposalRequest => ({ source, kind: source === 'memory' ? 'memory_notice' : source === 'visit' ? 'companion' : source, chatId: 'owner', summary: source, ref: `${source}:one`, createdAt: now, nowMs: now, ...extra })
  const submit = (source: 'letter' | 'memory' | 'brief', extra: Partial<SpeechProposalRequest> = {}) => speech.propose(req(source, extra), async turn => { await turn.sendText('owner', source) })
  return { speech, db, dir, sent, opened, evaluator, req, submit, advance: (ms: number) => { now += ms }, off: () => { care = 'off' }, disconnect: () => { deliverable = false } }
}
it('gates and source validation precede evaluator lookup and expensive context', async () => {
  const s = setup(async () => { throw new Error('must not evaluate') }), context = vi.fn(async () => ({}))
  s.off()
  expect(await s.submit('letter', { context })).toMatchObject({ drop: true, reason: 'care_off' })
  expect(s.evaluator).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled(); expect(s.opened).not.toHaveBeenCalled()
  const t = setup()
  expect(await t.submit('letter', { validate: () => false, context })).toMatchObject({ defer: true })
  expect(t.evaluator).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled()
  t.disconnect(); await t.submit('memory', { context })
  expect(t.evaluator).not.toHaveBeenCalled()
})
it('one snapshot selects one source by fallback C; losing producers never run and interval gates the next round', async () => {
  const s = setup(), loser = vi.fn(async () => {})
  const a = s.speech.propose(s.req('letter'), loser)
  const b = s.submit('memory', { expiresAt: Date.parse('2026-11-06T13:00:00Z') })
  expect(await a).toMatchObject({ defer: true }); expect(await b).toMatchObject({ allow: true })
  expect(s.sent).toEqual(['memory']); expect(loser).not.toHaveBeenCalled()
  s.advance(91 * 60_000)
  await s.submit('letter', { ref: 'letter:two' })
  expect(s.evaluator).toHaveBeenCalledTimes(1); expect(s.sent).toEqual(['memory'])
  s.advance(INITIATIVE_INTERVAL_MS)
  await s.submit('letter', { ref: 'letter:two' })
  expect(s.sent).toEqual(['memory', 'letter'])
})
it('fixed-time brief bypasses interval and evaluator, then extends the ordinary interval', async () => {
  const s = setup()
  await s.submit('letter')
  s.advance(3600_000)
  expect(await s.submit('brief')).toMatchObject({ allow: true })
  expect(s.sent).toEqual(['letter', 'brief']); expect(s.evaluator).toHaveBeenCalledTimes(1)
  expect(makeSpeechLedgerStore(s.db).lastInitiativeAt('owner')).toBe(Date.parse('2026-11-06T13:00:00Z'))
  await s.submit('memory'); expect(s.sent).toHaveLength(2)
})
it('requested, report and blocking still send after initiative budget was consumed', async () => {
  const s = setup(); await s.submit('letter')
  for (const kind of ['reminder', 'matter_report', 'permission_ask'] as const) {
    expect(await s.speech.say({ kind, chatId: 'owner' }, async turn => { await turn.sendText('owner', kind) })).toMatchObject({ allow: true })
  }
  expect(s.sent).toEqual(['letter', 'reminder', 'matter_report', 'permission_ask'])
})
it('model can select only snapshot ids and targets; none persists a 90 minute backoff across wiring', async () => {
  const evaluate = vi.fn(async () => '{"id":"outside","why":"ignore candidates"}')
  const s = setup(evaluate)
  await s.submit('letter'); await s.submit('memory')
  expect(s.sent).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(1)
  expect(readPlanLogDays(s.dir, 14).at(-1)).toMatchObject({ decision: 'none', backoff: true })
  s.advance(90 * 60_000)
  await s.submit('memory')
  expect(evaluate).toHaveBeenCalledTimes(2)
})
it('revalidates inbound/version eligibility after model selection without switching to another source', async () => {
  let eligible = true
  const s = setup(async () => { eligible = false; return '{"id":"letter:one","why":"letter"}' })
  await Promise.all([s.submit('letter', { validate: () => eligible }), s.submit('memory')])
  expect(s.sent).toEqual([])
})
it('network guard refusal does not fall back, advance a source, or persist a model backoff', async () => {
  const s = setup(async () => { throw new NetworkUnprotectedError({ safe: false, source: 'bx', detail: 'test' }) })
  await s.submit('letter'); await s.submit('memory')
  expect(s.sent).toEqual([]); expect(s.opened).not.toHaveBeenCalled()
  expect(readPlanLogDays(s.dir, 14)).toEqual([])
  expect(s.evaluator).toHaveBeenCalledTimes(2)
})
it('outing uses peer eligibility despite owner disconnection and consumes no speech slot', async () => {
  const s = setup(); await s.submit('letter'); s.advance(91 * 60_000); s.disconnect()
  const run = vi.fn(async turn => { expect(() => turn.channel()).not.toThrow() })
  expect(await s.speech.propose(s.req('visit'), run)).toMatchObject({ allow: true })
  expect(run).toHaveBeenCalledOnce(); expect(s.sent).toEqual(['letter'])
  expect(s.db.query("SELECT COUNT(*) AS n FROM speech_pending WHERE lane='reservation'").get()).toEqual({ n: 1 })
})
it('production rejects any raw initiative say bypass', async () => {
  const s = setup(), produce = vi.fn(async () => {})
  expect(await s.speech.say({ kind: 'letter', chatId: 'owner' }, produce)).toEqual({ drop: true, reason: 'proposal_required' })
  expect(produce).not.toHaveBeenCalled()
})
