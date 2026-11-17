import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { openDb } from '../lib/db'
import { backfillSpeech, auditSpeech, renderSpeechAudit } from './speech-ops'

const opened: ReturnType<typeof openDb>[] = []
const setup = () => { const db = openDb({ path: ':memory:' }); opened.push(db); return db }
afterEach(() => { for (const db of opened.splice(0)) db.close() })
const log = (db: ReturnType<typeof openDb>, ref: string, kind = 'letter', at = 100) => db.query("INSERT INTO speech_log(at,kind,origin,chat_id,outcome,ref) VALUES(?,?,'initiative','owner','allowed',?)").run(at, kind, ref)
function delivery(db: ReturnType<typeof openDb>, id: string, result: string, sentAt?: number) {
  const matter = createHash('sha1').update('cc-act:letters').digest('hex').slice(0, 8)
  db.query("INSERT OR IGNORE INTO matters(id,kind,initiator,title,state,created_at,updated_at) VALUES(?,'act','cc','letters','open',1,1)").run(matter)
  const seq = (db.query('SELECT COUNT(*) AS n FROM matter_items').get() as { n: number }).n + 1
  db.query("INSERT INTO matter_items(matter_id,seq,kind,status,payload_json,created_at,updated_at,cursor) VALUES(?,?,'delivery',?,?,1,1,?)").run(matter, seq, result === 'sent' ? 'completed' : 'failed', JSON.stringify({ letter: id, result, via: 'wechat', ...(sentAt === undefined ? {} : { sentAt }) }), seq)
}

it('backfills only explicit successful evidence across pages; repeated runs preserve the original ledger', () => {
  const db = setup()
  for (let i = 0; i < 7; i++) log(db, `letter:${i}`)
  delivery(db, '0', 'sent', 500); delivery(db, '0', 'sent', 700); delivery(db, '0', 'failed', 900)
  delivery(db, '1', 'waiting'); delivery(db, '2', 'failed', 400)
  delivery(db, '6', 'sent', 800)
  log(db, 'message:out', 'memory_notice')
  db.query("INSERT INTO messages(id,chat_id,ts,direction,text) VALUES('out','owner','2026-01-01T00:00:00Z','out','test')").run()
  expect(backfillSpeech(db, 2)).toEqual({ scanned: 8, confirmed: 3, legacyUnknown: 5 })
  expect(db.query("SELECT spoken_at FROM speech_log WHERE ref='letter:0'").get()).toEqual({ spoken_at: 500 })
  const snapshot = db.query('SELECT * FROM speech_log ORDER BY id').all()
  expect(backfillSpeech(db, 1)).toEqual({ scanned: 5, confirmed: 0, legacyUnknown: 5 })
  expect(db.query('SELECT * FROM speech_log ORDER BY id').all()).toEqual(snapshot)
  expect(db.query('SELECT at,outcome FROM speech_log WHERE id=1').get()).toEqual({ at: 100, outcome: 'allowed' })
})

it('rejects inbound/imported/wrong-recipient and ambiguous evidence, and can pick up later proof', () => {
  const db = setup()
  for (const id of ['in', 'imported', 'other']) log(db, `message:${id}`)
  db.exec("INSERT INTO messages(id,chat_id,ts,direction,text,source) VALUES ('in','owner','2026-01-01','in','','live'),('imported','owner','2026-01-01','out','','backfill'),('other','stranger','2026-01-01','out','','live')")
  log(db, 'letter:partial'); delivery(db, 'partial', 'waiting', 300)
  expect(backfillSpeech(db).confirmed).toBe(0)
  delivery(db, 'partial', 'sent', 600)
  expect(backfillSpeech(db).confirmed).toBe(1)
})

it('rolls back the whole backfill on a partial database write failure', () => {
  const db = setup(); log(db, 'letter:a'); log(db, 'letter:b')
  delivery(db, 'a', 'sent', 100); delivery(db, 'b', 'sent', 200)
  db.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON speech_log WHEN NEW.ref='letter:b' BEGIN SELECT RAISE(ABORT,'injected'); END")
  expect(() => backfillSpeech(db, 1)).toThrow('injected')
  expect(db.query('SELECT COUNT(*) AS n FROM speech_log WHERE spoken_at IS NOT NULL').get()).toEqual({ n: 0 })
  db.exec('DROP TRIGGER fail_backfill')
  expect(backfillSpeech(db, 1).confirmed).toBe(2)
})

it('audits predecessor across window boundary, scheduled exemption, unknown occupation and missing reservations without writing', () => {
  const db = setup(), now = 10 * 86400_000
  db.query('INSERT INTO speech_audit_coverage VALUES(1,?)').run(now - 8 * 86400_000)
  for (const [ref, kind, at] of [['a', 'letter', now - 86400_000 - 1000], ['b', 'memory_notice', now - 86400_000 + 1000], ['c', 'brief', now - 86400_000 + 2000]] as const) {
    log(db, ref, kind, at)
    db.query("UPDATE speech_log SET spoken_at=at,delivery_state='confirmed' WHERE ref=?").run(ref)
  }
  db.query("INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at,status) VALUES('u','reservation','owner','sticker','{}','u',?,?,?,'unknown')").run(now - 1000, now, now + 1000)
  db.exec("INSERT INTO speech_audit_events(at,source,chat_id,ref,outcome) VALUES(864000000,'memory','owner','a','allowed'),(864000000,'memory','owner','b','deferred'),(864000000,'letter','owner','c','blocked')")
  const before = db.query('SELECT total_changes() AS n').get()
  const r = auditSpeech(db, 1, now)
  expect(r.completeWindow).toBe(true)
  expect(r.intervalViolations).toHaveLength(1)
  expect(r.unknown[0]).toMatchObject({ count: 1, active: 1 })
  expect(r.sources.filter(s => s.count > 0)).toHaveLength(3)
  expect(r.suspectedBypass.reduce((n, x) => n + x.count, 0)).toBe(2)
  expect(renderSpeechAudit(r)).toContain('疑似直发绕过：2')
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(before)
  expect(auditSpeech(setup(), 7, now).completeWindow).toBe(false)
  expect(() => auditSpeech(db, NaN)).toThrow()
})

it('accepts a bare exact message ID and preserves already confirmed first delivery', () => {
  const db = setup(); log(db, 'exact-message-id', 'sticker'); log(db, 'letter:already')
  db.query("INSERT INTO messages(id,chat_id,ts,direction,text) VALUES('exact-message-id','owner','2026-01-01T00:00:00Z','out','')").run()
  db.query("UPDATE speech_log SET spoken_at=50,delivery_state='confirmed' WHERE ref='letter:already'").run()
  delivery(db, 'already', 'sent', 600)
  expect(backfillSpeech(db).confirmed).toBe(1)
  expect(db.query("SELECT spoken_at FROM speech_log WHERE ref='letter:already'").get()).toEqual({ spoken_at: 50 })
})

it('unknown reservations occupy the interval across sources while other recipients and requested sends stay independent', () => {
  const db = setup(), now = 10 * 86400_000
  db.query("INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at,status) VALUES('u','reservation','owner','sticker',?, 'u',?,?,?,'unknown')").run(JSON.stringify({ source: 'sticker' }), now - 3600_000, now, now + 1000)
  log(db, 'memory:after-unknown', 'memory_notice', now)
  db.exec("UPDATE speech_log SET spoken_at=at,delivery_state='confirmed'; INSERT INTO speech_log(at,kind,origin,chat_id,outcome,ref,spoken_at,delivery_state) VALUES(864000000,'letter','initiative','other','allowed','other',864000000,'confirmed'),(864000000,'reminder','requested','owner','allowed','requested',864000000,'confirmed')")
  const r = auditSpeech(db, 7, now)
  expect(r.intervalViolations).toEqual([{ kind: 'memory_notice', at: now, gapMs: 3600_000 }])
  expect(r.unknown).toEqual([{ source: 'sticker', kind: 'sticker', count: 1, active: 1 }])
  expect(auditSpeech(db, 0.01, now).unknown).toEqual([{ source: 'sticker', kind: 'sticker', count: 0, active: 1 }])
})

it('counts a confirmed receipt and its crash-recovered unknown reservation as one logical speech', () => {
  const db = setup(), now = 10 * 86400_000
  log(db, 'letter:crash', 'letter', now)
  db.exec("UPDATE speech_log SET spoken_at=at,delivery_state='confirmed'")
  db.query("INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at,status) VALUES('crash','reservation','owner','letter','{}','letter:crash',?,?,?,'unknown')").run(now - 2, now, now + 1000)
  log(db, 'brief:between', 'brief', now - 1)
  db.query("UPDATE speech_log SET spoken_at=at,delivery_state='confirmed' WHERE ref='brief:between'").run()
  expect(auditSpeech(db, 7, now).intervalViolations).toEqual([])
})

it('keeps picker evidence after a failed continuation releases its replacement reservation', async () => {
  const { makeSpeechReservations } = await import('../daemon/speech/reservations')
  const db = setup(), now = 10 * 86400_000, first = now - 21 * 3600_000
  db.query('INSERT INTO speech_audit_coverage VALUES(1,?)').run(first - 1000)
  const reservations = makeSpeechReservations(db)
  expect(reservations.reserve({ ref: 'letter:resume', recipient: 'owner', kind: 'letter', now: first, payload: {} })).toEqual({ ok: true })
  log(db, 'letter:resume', 'letter', first)
  db.exec("UPDATE speech_log SET spoken_at=at,delivery_state='confirmed'")
  reservations.settle('letter:resume', 'confirmed')
  db.query("INSERT INTO speech_audit_events(at,source,chat_id,ref,outcome) VALUES(?,'letter','owner','letter:resume','allowed')").run(first)
  expect(reservations.reserve({ ref: 'letter:resume', recipient: 'owner', kind: 'letter', now, payload: {}, resumeConfirmed: true })).toEqual({ ok: true })
  reservations.settle('letter:resume', 'not_sent')
  expect(db.query('SELECT id FROM speech_pending').all()).toEqual([])
  expect(auditSpeech(db, 7, now).suspectedBypass).toEqual([])
})

it('does not infer delivery of a multi-page archived letter from a partial page watermark', () => {
  const db = setup(); log(db, 'letter:multi')
  delivery(db, 'multi', 'waiting')
  db.exec("UPDATE matter_items SET payload_json=json_set(payload_json,'$.sentPages',1,'$.pages',3)")
  // A page watermark has no confirmed timestamp or explicit message identity.
  expect(backfillSpeech(db).confirmed).toBe(0)
  expect(db.query("SELECT spoken_at,delivery_state FROM speech_log WHERE ref='letter:multi'").get()).toEqual({ spoken_at: null, delivery_state: 'legacy_unknown' })
  delivery(db, 'multi', 'sent', 300)
  delivery(db, 'multi', 'failed', 500)
  expect(backfillSpeech(db).confirmed).toBe(1)
  expect(db.query("SELECT spoken_at FROM speech_log WHERE ref='letter:multi'").get()).toEqual({ spoken_at: 300 })
})

it('tagged companion WeChat receipts preserve live-only backfill semantics and exact identities',()=>{
 const db=setup()
 for(const id of ['wx1','wx2','app:companion:1:0:out','incoming','wrong','imported'])log(db,id==='wx2'?`message:${id}`:id,'companion')
 for(const [id,chat,direction,source] of [['wx1','owner','out','speech:companion'],['wx2','owner','out','speech:companion'],['app:companion:1:0:out','owner','out','speech:companion'],['incoming','owner','in','speech:companion'],['wrong','other','out','speech:companion'],['imported','owner','out','backfill:claude']] as const)db.query('INSERT INTO messages(id,chat_id,ts,direction,text,source) VALUES(?,?,?,?,?,?)').run(id,chat,'2026-11-13T00:00:00Z',direction,'',source)
 expect(backfillSpeech(db)).toEqual({scanned:6,confirmed:2,legacyUnknown:4})
 expect(backfillSpeech(db)).toEqual({scanned:4,confirmed:0,legacyUnknown:4})
})
