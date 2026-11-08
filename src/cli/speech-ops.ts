import { createHash } from 'node:crypto'
import type { Db } from '../lib/db'

const INTERVAL = 20 * 3600_000
const lettersId = createHash('sha1').update('cc-act:letters').digest('hex').slice(0, 8)

/** Explicit identities only. No time/text proximity or allowed => delivery inference. */
export function backfillSpeech(db: Db, pageSize = 200) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('分页大小必须为正整数')
  return db.transaction(() => {
    let cursor = 0, scanned = 0, confirmed = 0
    while (true) {
      const rows = db.query<{ id: number; ref: string | null; chat_id: string; kind: string }, [number, number]>(
        "SELECT id,ref,chat_id,kind FROM speech_log WHERE id>? AND delivery_state='legacy_unknown' AND spoken_at IS NULL ORDER BY id LIMIT ?").all(cursor, pageSize)
      if (!rows.length) break
      for (const row of rows) {
        cursor = row.id; scanned++
        const times: number[] = []
        if ((row.kind === 'letter' || row.kind === 'letter_asked') && row.ref?.startsWith('letter:')) {
          const steps = db.query<{ payload_json: string }, [string, string]>(`SELECT i.payload_json FROM matter_items i
            JOIN matters m ON m.id=i.matter_id WHERE i.matter_id=? AND i.kind='delivery' AND i.status='completed'
            AND (m.owner_chat_id=? OR m.owner_chat_id IS NULL)`).all(lettersId, row.chat_id)
          for (const step of steps) {
            const p = JSON.parse(step.payload_json)
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue
            if (p.letter === row.ref.slice(7) && p.result === 'sent' && (p.via === 'wechat' || p.via === 'app') && Number.isSafeInteger(p.sentAt) && p.sentAt > 0) times.push(p.sentAt)
          }
        }
        // An exact message identity (bare ID or message:ID); imported transcripts are not receipts.
        if (row.ref) {
          const m = db.query<{ ts: string }, [string, string]>("SELECT ts FROM messages WHERE id=? AND chat_id=? AND direction='out' AND source='live'").get(row.ref.startsWith('message:') ? row.ref.slice(8) : row.ref, row.chat_id)
          if (m && Number.isFinite(Date.parse(m.ts))) times.push(Date.parse(m.ts))
        }
        if (times.length) confirmed += db.query("UPDATE speech_log SET spoken_at=?,delivery_state='confirmed' WHERE id=? AND spoken_at IS NULL AND delivery_state='legacy_unknown'").run(times.reduce((a, b) => Math.min(a, b)), row.id).changes
      }
    }
    return { scanned, confirmed, legacyUnknown: scanned - confirmed }
  }).immediate()
}

export function auditSpeech(db: Db, days = 7, now = Date.now()) {
  if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error('天数必须大于 0 且不超过 90')
  return db.transaction(() => {
    const since = now - days * 86400_000
    const coverage = db.query<{ started_at: number }, []>('SELECT started_at FROM speech_audit_coverage WHERE id=1').get()?.started_at ?? null
    const observed = db.query<{ source: string; outcome: string; count: number }, [number, number]>(`SELECT source,outcome,COUNT(*) AS count FROM speech_audit_events WHERE at>=? AND at<=? GROUP BY source,outcome ORDER BY source,outcome`).all(since, now)
    const sources = [...new Set(observed.map(x => x.source))].sort().flatMap(source =>
      ['allowed', 'blocked', 'deferred'].map(outcome => ({ source, outcome, count: observed.find(x => x.source === source && x.outcome === outcome)?.count ?? 0 })))
    const unknown = db.query<{ source: string; kind: string; count: number; active: number }, [number, number, number, number]>(`SELECT CASE WHEN json_valid(body) THEN COALESCE(json_extract(body,'$.source'),kind) ELSE kind END AS source,kind,SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS count,SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS active FROM speech_pending WHERE lane='reservation' AND status='unknown' AND created_at>=? AND created_at<=? GROUP BY source,kind`).all(since, now - INTERVAL, Math.min(since, now - INTERVAL), now)
    const legacyUnknown = db.query<{ count: number }, [number, number]>("SELECT COUNT(*) AS count FROM speech_log WHERE delivery_state='legacy_unknown' AND at>=? AND at<=?").get(since, now)!.count
    // Include the predecessor before the window and unknown reservations in the interval check.
    const facts = db.query<{ id: number; chat_id: string; kind: string; ref: string | null; t: number; unknown: number }, [number]>(`SELECT id,chat_id,kind,ref,spoken_at AS t,0 AS unknown FROM speech_log WHERE origin='initiative' AND spoken_at IS NOT NULL AND spoken_at<=?
      UNION ALL SELECT 0,chat_id,kind,ref,created_at,1 FROM speech_pending WHERE lane='reservation' AND status='unknown' ORDER BY t,id`).all(now)
    const last = new Map<string, number>(), seenRefs = new Set<string>(), violations: { kind: string; at: number; gapMs: number }[] = []
    for (const f of facts) {
      if (f.t > now) continue
      const prev = last.get(f.chat_id)
      const key = f.ref === null ? null : JSON.stringify([f.chat_id, f.ref])
      const repeated = key !== null && seenRefs.has(key)
      if (key !== null) seenRefs.add(key)
      if (!f.unknown && !repeated && f.t >= since && prev !== undefined && f.t - prev < INTERVAL && f.kind !== 'brief' && f.kind !== 'recap') violations.push({ kind: f.kind, at: f.t, gapMs: f.t - prev })
      last.set(f.chat_id, f.t)
    }
    // Continuations may release a replacement reservation; retained picker evidence
    // still proves this ref passed through the picker. Missing both is a suspected bypass,
    // not proof that an uninstrumented external send did not happen.
    const unmatched = db.query<{ kind: string; count: number }, [number, number]>(`SELECT l.kind,COUNT(*) AS count FROM speech_log l WHERE l.origin='initiative' AND l.spoken_at>=? AND l.spoken_at<=? AND NOT EXISTS(SELECT 1 FROM speech_pending p WHERE p.lane='reservation' AND p.ref=l.ref AND p.chat_id=l.chat_id) AND NOT EXISTS(SELECT 1 FROM speech_audit_events e WHERE e.ref=l.ref AND e.chat_id=l.chat_id AND e.outcome='allowed') GROUP BY l.kind`).all(Math.max(since, coverage ?? now), now)
    return { since, until: now, coverageStartedAt: coverage, completeWindow: coverage !== null && coverage <= since, sources, unknown, legacyUnknown, intervalViolations: violations, suspectedBypass: unmatched, limitations: ['统计为提议尝试次数（重复提议分别计数）；旧 speech_log 会合账，不能还原历史 picker 次数。', '直发检查只覆盖已记送达账的 initiative；未入账外发无法由数据库证明为零。'] }
  })()
}

export function renderSpeechAudit(r: ReturnType<typeof auditSpeech>): string {
  return [
    `开口影子对账：${new Date(r.since).toISOString()} 至 ${new Date(r.until).toISOString()}`,
    `观察窗口：${r.completeWindow ? '完整' : '不足，不能下七天结论'}`,
    ...[...new Set(r.sources.map(s => s.source))].map(source => `${source}：` + r.sources.filter(s => s.source === source).map(s => `${s.outcome === 'allowed' ? '放行' : s.outcome === 'blocked' ? '拦下' : '延后'} ${s.count}`).join('，')),
    `20 小时间隔违规：${r.intervalViolations.length}（早报、周报豁免）`,
    `未知送达预留：${r.unknown.reduce((n, x) => n + x.count, 0)}；仍占间隔：${r.unknown.reduce((n, x) => n + x.active, 0)}`,
    ...r.unknown.map(x => `${x.source} 未知送达：${x.count}，仍占间隔：${x.active}`),
    `历史证据不足：${r.legacyUnknown}（不伪造送达、不作为预留）`,
    `疑似直发绕过：${r.suspectedBypass.reduce((n, x) => n + x.count, 0)}（预期 0）`,
    ...r.limitations,
  ].join('\n')
}
