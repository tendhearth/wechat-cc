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

it('explicitly unknown production occupies the interval without forging a delivery or replaying the same event', async () => {
  const s = setup()
  expect(await s.speech.propose(s.req('letter'), async () => 'unknown')).toMatchObject({ defer: true, reason: 'delivery_unknown' })
  expect(s.db.query("SELECT status FROM speech_pending WHERE ref='letter:one'").get()).toEqual({ status: 'unknown' })
  expect(makeSpeechLedgerStore(s.db).lastInitiativeAt('owner')).toBeNull()
  await s.submit('memory'); expect(s.sent).toEqual([])
  s.advance(INITIATIVE_INTERVAL_MS)
  expect(await s.submit('letter')).toMatchObject({ defer: true, reason: 'duplicate' })
  expect(s.sent).toEqual([])
  expect(s.evaluator).toHaveBeenCalledTimes(1) // duplicate/unknown gate before evaluator lookup, even after the interval
})
it('lazy target/context preparation stays behind gates and changed target snapshots cannot execute', async () => {
  const targets = vi.fn(() => ['peer-a']), context = vi.fn(async () => ({}))
  const off = setup(); off.off()
  await off.speech.propose(off.req('visit', { getTargets: targets, context }), async () => {})
  expect(targets).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled()
  const run = vi.fn(async () => {})
  const s = setup(async () => { targets.mockReturnValue(['peer-b']); return '{"id":"visit:one","why":"visit","target":"peer-a"}' })
  await s.speech.propose(s.req('visit', { getTargets: targets, context }), run)
  expect(context).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled()
})
it('known partial letters resume only after the interval, preserve the first receipt and never duplicate completed pages in the picker', async () => {
  const s = setup()
  await s.submit('letter')
  expect(await s.submit('letter', { payloadRef: { sentPages: 1 } })).toMatchObject({ defer: true })
  s.advance(INITIATIVE_INTERVAL_MS)
  expect(await s.submit('letter', { payloadRef: { sentPages: 1 } })).toMatchObject({ allow: true })
  expect(s.sent).toEqual(['letter', 'letter'])
  expect(makeSpeechLedgerStore(s.db).lastInitiativeAt('owner')).toBe(Date.parse('2026-11-06T12:00:00Z'))
})

it('honors a legacy persisted none decision after upgrade before resolving an evaluator', async () => {
  const { appendPlanLog } = await import('../../features/companion/plan-memory')
  const s = setup()
  appendPlanLog(s.dir, '2026-11-06', { at: '2026-11-06T11:30:00Z', chatId: 'owner', candidates: ['hunt'], decision: 'none', why: 'old decision', source: 'model' })
  await s.submit('memory')
  expect(s.evaluator).not.toHaveBeenCalled(); expect(s.sent).toEqual([])
  s.advance(90 * 60_000)
  await s.submit('memory')
  expect(s.sent).toEqual(['memory'])
})

it('a fixed proposal that expires behind a serialized send is recorded expired without producing', async () => {
  const s = setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = s.speech.propose(s.req('letter'), async turn => { await barrier; await turn.sendText('owner', 'letter') })
  await expect.poll(() => s.db.query("SELECT status FROM speech_pending WHERE ref='letter:one'").get()).toEqual({ status: 'sending' })
  const produce = vi.fn(async () => {})
  const fixed = s.speech.propose(s.req('brief', { expiresAt: Date.parse('2026-11-06T12:01:00Z') }), produce)
  s.advance(2 * 60_000); release()
  await first
  expect(await fixed).toEqual({ defer: true, reason: 'expired' })
  expect(produce).not.toHaveBeenCalled()
  expect(s.db.query("SELECT reason,spoken_at FROM speech_log WHERE ref='brief:one'").get()).toEqual({ reason: 'expired', spoken_at: null })
})

it('a peer outing does not hold the owner send slot and its returned postcard can enter the same picker', async () => {
  const { queuePostcardProposal } = await import('../../features/social/postcard-proposal')
  const s = setup(async prompt => {
    const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { candidates: Array<{ id: string }> }
    return JSON.stringify({ id: data.candidates[0]!.id, why: 'one eligible source' })
  })
  let release!: () => void, started = false
  const barrier = new Promise<void>(resolve => { release = resolve })
  const outing = s.speech.propose(s.req('visit'), async () => {
    started = true
    await barrier
    queuePostcardProposal({ speech: s.speech, recipient: 'owner', story: 'returned story', ref: 'visit:return', raster: () => null, log: () => {} })
  })
  let fixed: Promise<unknown> | undefined
  try {
    await expect.poll(() => started).toBe(true)
    fixed = s.submit('brief')
    await expect.poll(() => s.sent, { timeout: 500 }).toEqual(['brief'])
    expect(await fixed).toMatchObject({ allow: true })
    expect(s.sent).toEqual(['brief']) // before the peer action completes
  } finally { release(); await outing; await fixed }
  // Brief consumed the budget, so the returned story is retained, not sent or
  // awaited recursively by the action currently being completed.
  await expect.poll(() => s.db.query("SELECT body FROM speech_pending WHERE lane='say'").all()).toEqual([{ body: 'returned story' }])
  expect(s.sent).toEqual(['brief'])
})

it('a fixed proposal rechecks care after waiting for an owner send and returns the policy drop, not a production failure', async () => {
  const s = setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = s.speech.propose(s.req('letter'), async turn => { await barrier; await turn.sendText('owner', 'letter') })
  await expect.poll(() => s.db.query("SELECT status FROM speech_pending WHERE ref='letter:one'").get()).toEqual({ status: 'sending' })
  const produce = vi.fn(async () => {})
  const fixed = s.speech.propose(s.req('brief'), produce)
  s.off(); release(); await first
  expect(await fixed).toEqual({ drop: true, reason: 'care_off' })
  expect(produce).not.toHaveBeenCalled()
  expect(s.db.query("SELECT outcome,reason,spoken_at FROM speech_log WHERE ref='brief:one'").get()).toEqual({ outcome: 'dropped', reason: 'care_off', spoken_at: null })
})

it('persists one audit event per picker attempt, including early gate rejection and losing candidates', async () => {
  const s = setup()
  await Promise.all([s.submit('letter'), s.submit('memory', { expiresAt: Date.parse('2026-11-06T13:00:00Z') })])
  s.off(); await s.submit('brief')
  expect(s.db.query('SELECT source,outcome FROM speech_audit_events ORDER BY id').all()).toEqual([
    { source: 'memory', outcome: 'allowed' },
    { source: 'letter', outcome: 'deferred' },
    { source: 'brief', outcome: 'blocked' },
  ])
  expect(s.db.query('SELECT COUNT(*) AS n FROM speech_audit_coverage').get()).toEqual({ n: 1 })
})
