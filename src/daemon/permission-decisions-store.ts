/**
 * permission-decisions-store.ts — 放行规则的留痕表(v78):CC 替主人拿的每个权限决定一行。
 * 命令摘要先打码(同「看 码」那套形状)再截 200 字;日志与这张表都不留密钥原文。
 */
import type { Db } from '../lib/db'
import { redactSecrets } from '../core/cli-transcript'

export interface PermissionDecisionRow {
  id: number
  at: number
  surface: 'terminal' | 'workbench' | 'chat'
  provider: string
  project: string | null
  tool: string
  summary: string
  verdict: 'allow' | 'deny'
  by: 'rule' | 'review' | 'floor'
  ruleId: string | null
  reason: string
  scope: string
}

export const DECISION_RETAIN_MS = 30 * 24 * 3600_000
export const DECISION_SUMMARY_MAX = 200

const SELECT = 'SELECT id,at,surface,provider,project,tool,summary,verdict,by_ AS by,rule_id AS ruleId,reason,scope FROM permission_decisions'

const clip = (s: string) => { const a = [...redactSecrets(s)]; return a.length <= DECISION_SUMMARY_MAX ? a.join('') : a.slice(0, DECISION_SUMMARY_MAX).join('') }

export function makePermissionDecisionsStore(db: Db) {
  return {
    record(r: Omit<PermissionDecisionRow, 'id'>): void {
      db.query('INSERT INTO permission_decisions(at,surface,provider,project,tool,summary,verdict,by_,rule_id,reason,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.at, r.surface, r.provider, r.project, r.tool, clip(r.summary), r.verdict, r.by, r.ruleId, clip(r.reason), r.scope)
    },
    since(at: number, limit = 100): PermissionDecisionRow[] {
      return db.query<PermissionDecisionRow, [number, number]>(`${SELECT} WHERE at>=? ORDER BY at DESC,id DESC LIMIT ?`).all(at, limit)
    },
    countsSince(at: number): { rule: number; review: number } {
      const rows = db.query<{ by: string; n: number }, [number]>("SELECT by_ AS by,COUNT(*) AS n FROM permission_decisions WHERE at>=? AND verdict='allow' GROUP BY by_").all(at)
      const n = (k: string) => rows.find(r => r.by === k)?.n ?? 0
      return { rule: n('rule'), review: n('review') }
    },
    prune(now: number): number {
      return db.query('DELETE FROM permission_decisions WHERE at<?').run(now - DECISION_RETAIN_MS).changes
    },
  }
}

export type PermissionDecisionsStore = ReturnType<typeof makePermissionDecisionsStore>
