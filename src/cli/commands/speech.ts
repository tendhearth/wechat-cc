import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { openSqlite } from '../../lib/runtime/sqlite'
import { auditSpeech, backfillSpeech, renderSpeechAudit } from '../speech-ops'

const args = {
  db: { type: 'string' as const, description: '数据库路径（默认状态目录中的 wechat-cc.db）' },
  json: { type: 'boolean' as const, default: false },
}
export const speechCmd = defineCommand({
  meta: { name: 'speech', description: '历史送达证据与只读影子对账' },
  subCommands: {
    backfill: defineCommand({
      meta: { name: 'backfill', description: '幂等关联可证明的历史送达，保留原账' },
      args,
      run({ args }) {
        const db = openSqlite(args.db ?? join(STATE_DIR, 'wechat-cc.db'), { readwrite: true, create: false })
        try {
          const result = backfillSpeech(db)
          console.log(args.json ? JSON.stringify(result) : `已检查 ${result.scanned}，确认送达 ${result.confirmed}，证据不足 ${result.legacyUnknown}`)
        } finally { db.close() }
      },
    }),
    audit: defineCommand({
      meta: { name: 'audit', description: '只读统计开口挑选、间隔、未知预留与疑似绕过' },
      args: { ...args, days: { type: 'string', default: '7', description: '观察天数（最多 90）' } },
      run({ args }) {
        const db = openSqlite(args.db ?? join(STATE_DIR, 'wechat-cc.db'), { readonly: true, create: false })
        try {
          const result = auditSpeech(db, Number(args.days))
          console.log(args.json ? JSON.stringify(result) : renderSpeechAudit(result))
        } finally { db.close() }
      },
    }),
  },
})
