#!/usr/bin/env bun
/**
 * M6e 对账(设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md §M6e):旧 status 的 replied
 * 按列(matters.status = 'replied')算 vs 按步(最近一轮上的 ready:<turnId>)算,在**库的副本**上逐行对一遍。
 * 删列那个 PR(v102)换读法之前跑它:replied 两边逐行一样才换。v102 以后的库没有列了 ⇒ 列那一半记 null,只数步。
 *
 *   sqlite3 ~/.claude/channels/wechat/wechat-cc.db ".backup /some/scratch/copy.db"
 *   bun scripts/m6e-replied-audit.ts /some/scratch/copy.db [--json]
 *
 * 只读打开(readonly),绝不碰在用的库 —— 传进来的路径在 ~/.claude/channels 下面直接拒。
 */
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { openSqlite } from '../src/lib/runtime/sqlite'
import { LEGACY_STATUS_INPUTS_SQL, legacyStatusSql } from '../src/adapters/store/matters-store'

export interface RepliedAudit {
  matters: number
  /** 列里记着 'replied' 的行(不管现算出来是不是)。删列迁移要回填的上限。库已经过了 v102(没有列)⇒ null。 */
  columnReplied: number | null
  /** ready 步的总行数。 */
  readySteps: number
  /** 最近一轮上有 ready 步的事。 */
  latestTurnReady: number
  /** 旧 status 按列现算 = replied(没有列 ⇒ null)。 */
  legacyRepliedByColumn: number | null
  /** 旧 status 按步现算 = replied。 */
  legacyRepliedByStep: number
  /** 两种算法不一样的行(id、种类、两边的结果、四个输入)。 */
  mismatches: { id: string; kind: string; byColumn: string; byStep: string; state: string; latestTurn: string | null; taskStatus: string | null; storedReplied: number; latestReady: number }[]
}

export function auditReplied(path: string): RepliedAudit {
  const db = openSqlite(path, { readonly: true })
  try {
    const q = <T>(sql: string) => db.query<T, []>(sql)
    const hasColumn = q<{ name: string }>('PRAGMA table_info(matters)').all().some(c => c.name === 'status')
    const stored = hasColumn ? "(d.status='replied')" : '0'
    const rows = q<{ id: string; kind: string; state: string; latest_turn: string | null; task_status: string | null; stored_replied: number; latest_ready: number; by_column: string; by_step: string }>(
      `SELECT e.*,${legacyStatusSql('stored_replied')} AS by_column,${legacyStatusSql('latest_ready')} AS by_step
         FROM (SELECT d.*,${stored} AS stored_replied FROM (${LEGACY_STATUS_INPUTS_SQL}) d) e ORDER BY e.id`).all()
    const readySteps = q<{ n: number }>("SELECT COUNT(*) AS n FROM matter_items WHERE kind='system' AND item_key LIKE 'ready:%'").get()!.n
    return {
      matters: rows.length,
      columnReplied: hasColumn ? rows.filter(r => r.stored_replied).length : null,
      readySteps,
      latestTurnReady: rows.filter(r => r.latest_ready).length,
      legacyRepliedByColumn: hasColumn ? rows.filter(r => r.by_column === 'replied').length : null,
      legacyRepliedByStep: rows.filter(r => r.by_step === 'replied').length,
      mismatches: rows.filter(r => hasColumn && r.by_column !== r.by_step).map(r => ({ id: r.id, kind: r.kind, byColumn: r.by_column, byStep: r.by_step, state: r.state, latestTurn: r.latest_turn, taskStatus: r.task_status, storedReplied: r.stored_replied, latestReady: r.latest_ready })),
    }
  } finally { db.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const path = args.find(a => !a.startsWith('--'))
  if (!path) { console.error('usage: bun scripts/m6e-replied-audit.ts <copy.db> [--json]'); process.exit(2) }
  const abs = resolve(path)
  if (abs.startsWith(resolve(homedir(), '.claude', 'channels'))) { console.error('refusing to open a live state dir; make a copy first (sqlite3 <db> ".backup <scratch>/copy.db")'); process.exit(2) }
  const r = auditReplied(abs)
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
  console.log(`matters: ${r.matters}`)
  console.log(`column 'replied' rows: ${r.columnReplied ?? '(no status column — past v102)'}`)
  console.log(`ready steps: ${r.readySteps} (latest turn ready: ${r.latestTurnReady})`)
  console.log(`legacy replied — by column: ${r.legacyRepliedByColumn}, by step: ${r.legacyRepliedByStep}`)
  console.log(`mismatches: ${r.mismatches.length}`)
  for (const m of r.mismatches) console.log(`  ${m.id} ${m.kind} column=${m.byColumn} step=${m.byStep} state=${m.state} turn=${m.latestTurn} task=${m.taskStatus} stored=${m.storedReplied} ready=${m.latestReady}`)
}
