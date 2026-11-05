import { describe, expect, it } from 'vitest'
import { openSqlite } from '../../lib/runtime/sqlite'
import { migrations, runMigrations, type Db } from '../../lib/db'
import { makeTurnRecordStore } from '../../test-support/legacy-turn-records'
import { makeChatTurnRecords } from './chat-turn-records'
import { makeMatterStore } from './matters-store'
import { makeMatterLog } from './matter-log'
import { makeChatTurnLog } from './chat-turns'
import type { TurnRecord } from '../../domain/turn-record'

/**
 * 回合记录换了家(M3b):以前读 turn_records,现在读这件对话的轮。出口形状必须一字不差 ——
 * 同一批回合,旧 store 写进 turn_records、v97 搬过来,新读口读出来要和旧读口读出来的一样(只有 id 不同)。
 */
const OWNER = 'owner@im.wechat', GUEST = 'guest@im.wechat'
const rec = (over: Partial<TurnRecord>): TurnRecord => ({
  chatId: OWNER, provider: 'claude', alias: '_default', mode: 'solo', startedAt: 1_000, endedAt: 4_000, durationMs: 3_000,
  outcome: 'completed', replyToolCalled: false, toolCalls: [], textChunks: 1, ...over,
})
/** v96 的库里 matters 还有 status 列(v102 才删),今天的 store 写不进去 ⇒ 照当时的形状直接插那件对话(id 固定)。 */
function oldChat(db: Db, chatId: string, id = '0000c0de'): string {
  db.query("INSERT INTO matters(id,kind,title,status,owner_chat_id,created_at,updated_at) VALUES(?,'chat','聊天','open',?,1,1)").run(id, chatId)
  db.query("INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,'wechat',?,1)").run(id, chatId)
  return id
}
function seeded() {
  const db = openSqlite(':memory:') as unknown as Db
  db.exec('PRAGMA foreign_keys = ON;')
  for (const m of migrations.slice(0, 96)) m(db)
  db.exec('PRAGMA user_version = 96;')
  oldChat(db, OWNER)   // 主人那件对话已经在;访客那条没有 ⇒ 迁移补一件
  const old = makeTurnRecordStore(db)
  old.append(rec({ startedAt: 1_000, endedAt: 4_000, toolCalls: ['wechat/reply', 'Bash'], replyToolCalled: true, textChunks: 3, delivery: 'text', bubbles: 2, attachments: 1, narrationSegments: 1 }))
  old.append(rec({ startedAt: 5_000, endedAt: 9_000, durationMs: 4_000, outcome: 'timeout', error: 'turn timed out', textChunks: 0, provider: 'codex', mode: 'parallel' }))
  old.append(rec({ chatId: GUEST, startedAt: 6_000, endedAt: 7_000, durationMs: 1_000, outcome: 'auth_failed', error: 'login expired', textChunks: 0 }))
  const before = { all: old.recent(50), owner: old.recentForChat(OWNER, 50), guest: old.recentForChat(GUEST, 50) }
  runMigrations(db, migrations)
  return { db, before }
}
const noId = (rs: readonly { id: string }[]) => rs.map(({ id: _id, ...r }) => r)

describe('chat-turn-records(M3b):从这件对话的轮读回合记录', () => {
  it('v97 搬过来以后,新读口和旧读口读出来一字不差(全部 / 按对话);访客那条对话补了一件事', () => {
    const { db, before } = seeded()
    const now = makeChatTurnRecords(db)
    expect(noId(now.recent(50))).toEqual(noId(before.all))
    expect(noId(now.recentForChat(OWNER, 50))).toEqual(noId(before.owner))
    expect(noId(now.recentForChat(GUEST, 50))).toEqual(noId(before.guest))
    expect(makeMatterStore(db).findChat(GUEST)).not.toBeNull()
    expect(now.recent(1)).toHaveLength(1)
  })
  it('重放不重复搬;M3a 并行写过的那一轮(同一件事、同一开始时刻、同一家)不再搬一遍', () => {
    const { db } = seeded()
    db.exec('PRAGMA user_version = 96')
    runMigrations(db, migrations)
    expect(makeChatTurnRecords(db).recent(50)).toHaveLength(3)
    const d2 = openSqlite(':memory:') as unknown as Db
    d2.exec('PRAGMA foreign_keys = ON;'); for (const m of migrations.slice(0, 96)) m(d2); d2.exec('PRAGMA user_version = 96;')
    const chatId = oldChat(d2, OWNER)
    // M3a 那时写下的样子:policy 里只有 alias / mode,没有结局与其余几项
    const log2 = makeMatterLog(d2)
    const live = log2.startTurn({ matterId: chatId, executor: 'claude', startedAt: 1_000, policy: { alias: '_default' } })
    log2.updateTurn(live.id, { policy: { alias: '_default', mode: 'solo' } })
    log2.finishTurn(live.id, { status: 'completed', endedAt: 4_000 })
    makeTurnRecordStore(d2).append(rec({}))
    runMigrations(d2, migrations)
    // 不重复搬;那一轮当时没记的几项用 turn_records 那一行补上 ⇒ 读出来和旧读口一样
    expect(noId(makeChatTurnRecords(d2).recent(50))).toEqual([{ chatId: OWNER, provider: 'claude', alias: '_default', mode: 'solo', startedAt: 1_000, endedAt: 4_000, durationMs: 3_000, outcome: 'completed', replyToolCalled: false, textChunks: 1, toolCalls: [] }])
  })
  it('同一个对话同一家同一毫秒的两轮(runner 支持):迁移一对一配对,各补各的,哪一行都不丢(Codex 评审 P2)', () => {
    const db = openSqlite(':memory:') as unknown as Db
    db.exec('PRAGMA foreign_keys = ON;'); for (const m of migrations.slice(0, 96)) m(db); db.exec('PRAGMA user_version = 96;')
    const mid = oldChat(db, OWNER)
    const log = makeMatterLog(db)
    // M3a 那时并行写下的两轮(只有 alias / mode)+ turn_records 里对应的两行,外加一行没并行写过的
    for (const end of [4_000, 6_000]) { const t = log.startTurn({ matterId: mid, executor: 'claude', startedAt: 1_000, policy: { alias: '_default', mode: 'solo' } }); log.finishTurn(t.id, { status: 'completed', endedAt: end }) }
    const old = makeTurnRecordStore(db)
    old.append(rec({ endedAt: 4_000, durationMs: 3_000, textChunks: 2, toolCalls: ['a'] }))
    old.append(rec({ endedAt: 6_000, durationMs: 5_000, outcome: 'error', error: 'boom', textChunks: 0, toolCalls: ['b'] }))
    old.append(rec({ startedAt: 1_000, endedAt: 8_000, durationMs: 7_000, textChunks: 4, toolCalls: ['c'] }))
    const before = old.recent(50)
    runMigrations(db, migrations)
    expect(noId(makeChatTurnRecords(db).recent(50))).toEqual(noId(before))
  })
  it('新写的轮(runner 经 chat-turns)读出来也是同一个形状;还在跑的不出现', () => {
    const db = openSqlite(':memory:') as unknown as Db
    db.exec('PRAGMA foreign_keys = ON;'); runMigrations(db, migrations)
    const ms = makeMatterStore(db); ms.ensureChat(OWNER)
    const turns = makeChatTurnLog({ db, log: makeMatterLog(db), matters: ms })
    const h = turns.begin({ chatId: OWNER, provider: 'claude', alias: 'proj', startedAt: 1_000 })!
    h.end({ mode: 'solo', outcome: 'completed', endedAt: 3_500, summary: { replyToolCalled: true, toolCalls: ['wechat/reply'], textChunks: 2, narrationSegments: 0 }, report: { delivery: 'text', bubbles: 1, attachmentsSent: 0, msgIds: [], failures: [] } as never })
    turns.begin({ chatId: OWNER, provider: 'codex', alias: 'proj', startedAt: 5_000 })
    expect(noId(makeChatTurnRecords(db).recent(50))).toEqual([{ chatId: OWNER, provider: 'claude', alias: 'proj', mode: 'solo', startedAt: 1_000, endedAt: 3_500, durationMs: 2_500, outcome: 'completed', replyToolCalled: true, textChunks: 2, toolCalls: ['wechat/reply'], delivery: 'text', bubbles: 1, attachments: 0, narrationSegments: 0 }])
  })
})
