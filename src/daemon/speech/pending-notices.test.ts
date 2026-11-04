import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makePendingNotices, MAX_PENDING_PER_CHAT, mergePending } from './pending-notices'

const OWNER = 'owner@im.wechat'
const T0 = Date.parse('2026-11-04T10:00:00.000Z')

describe('待说队列在主库 speech_pending(S2b)', () => {
  it('进、按对话分组、说完删掉;另一份(重启)看得见同一批', () => {
    const db = openTestDb()
    const a = makePendingNotices({ db, log: () => {}, now: () => T0 })
    a.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: '定时停了' })
    a.add({ id: 'b', kind: 'social_mail', chatId: 'other', text: '来信' })
    a.add({ id: 'c', kind: 'boot_notice', chatId: OWNER, text: '开机有几样没起来' })
    const b = makePendingNotices({ db, log: () => {}, now: () => T0 })
    const g = b.groups(T0)
    expect(g.map(x => [x.chatId, x.items.map(i => i.id)])).toEqual([[OWNER, ['a', 'c']], ['other', ['b']]])
    b.remove(OWNER, ['a', 'c'], 0)
    expect(b.groups(T0).map(x => x.chatId)).toEqual(['other'])
  })

  it(`超过每条对话 ${MAX_PENDING_PER_CHAT} 条 ⇒ 最老的变 overflow,说的时候带「还有 N 件更早的」,说过就删`, () => {
    const db = openTestDb()
    const logs: string[] = []
    const p = makePendingNotices({ db, log: (_t, l) => logs.push(l), now: () => T0 })
    for (let i = 1; i <= 23; i++) p.add({ id: `n${i}`, kind: 'social_mail', chatId: OWNER, text: `第 ${i} 封`, at: new Date(T0 + i).toISOString() })
    expect(logs.some(l => l.includes('dropped the oldest'))).toBe(true)
    const [g] = p.groups(T0 + 100)
    expect(g!.items).toHaveLength(MAX_PENDING_PER_CHAT)
    expect(g!.items[0]!.text).toBe('第 4 封')
    expect(g!.dropped).toBe(3)
    expect(mergePending(g!.items, g!.dropped)).toContain('还有 3 件更早的')
    p.remove(OWNER, g!.items.map(i => i.id), g!.dropped)
    expect(p.groups(T0 + 100)).toEqual([])
    expect(db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
  })

  it('补说失败 ⇒ 退避记在行上(共用 backoffMs,1 → 2 分钟),这条对话在退避里新进来的也一起等;重启不归零', () => {
    const db = openTestDb()
    const p = makePendingNotices({ db, log: () => {} })
    p.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: 'x', at: new Date(T0).toISOString() })
    expect(p.failed(OWNER, ['a'], T0)).toBe(1)
    expect(db.query("SELECT attempts, first_failed_at, next_at FROM speech_pending WHERE id='a'").get()).toEqual({ attempts: 1, first_failed_at: T0, next_at: T0 + 60_000 })
    p.add({ id: 'b', kind: 'boot_notice', chatId: OWNER, text: 'y', at: new Date(T0 + 1).toISOString() })
    expect(p.groups(T0 + 59_999)).toEqual([])
    const again = makePendingNotices({ db, log: () => {} })   // 重启
    expect(again.groups(T0 + 59_999)).toEqual([])
    expect(again.groups(T0 + 60_000)[0]!.items.map(i => i.id)).toEqual(['a', 'b'])
    expect(again.failed(OWNER, ['a', 'b'], T0 + 60_000)).toBe(2)
    expect(again.groups(T0 + 60_000 + 119_999)).toEqual([])
    expect(again.groups(T0 + 60_000 + 120_000)).toHaveLength(1)
    expect(db.query("SELECT first_failed_at FROM speech_pending WHERE id='a'").get()).toEqual({ first_failed_at: T0 })
  })

  it('过期 ⇒ expire 回给调用方、删掉;overflow 的过期悄悄删(本来就不说)', () => {
    const db = openTestDb()
    const p = makePendingNotices({ db, log: () => {}, now: () => T0 })
    p.add({ id: 'old', kind: 'job_notice', chatId: OWNER, text: '旧', expiresAt: T0 + 10 })
    p.add({ id: 'new', kind: 'boot_notice', chatId: OWNER, text: '新' })
    expect(p.expire(T0 + 10)).toEqual([{ id: 'old', kind: 'job_notice', chatId: OWNER }])
    expect(p.groups(T0 + 10)[0]!.items.map(i => i.id)).toEqual(['new'])
    // 缺省过期:入队后 24 小时
    expect(db.query("SELECT expires_at FROM speech_pending WHERE id='new'").get()).toEqual({ expires_at: T0 + 24 * 3600_000 })
  })
})

describe('旧的 speech/pending-notices.json 开机读进表(S2b)', () => {
  const legacy = (body: unknown): string => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pend-legacy-'))
    mkdirSync(join(stateDir, 'speech'), { recursive: true })
    writeFileSync(join(stateDir, 'speech', 'pending-notices.json'), typeof body === 'string' ? body : JSON.stringify(body))
    return stateDir
  }

  it('每一条 id / 入队时刻原样进表,被挤掉的计数变成 overflow;文件改名 .migrated;再开机不重复', () => {
    const stateDir = legacy({
      items: [
        { id: 'k1', kind: 'job_notice', chatId: OWNER, text: '定时 j1 停了', at: '2026-11-04T09:00:00.000Z' },
        { id: 'k2', kind: 'social_mail', chatId: OWNER, text: '老王来信', at: '2026-11-04T09:30:00.000Z' },
      ],
      dropped: { [OWNER]: 2 },
    })
    const db = openTestDb()
    const logs: string[] = []
    const p = makePendingNotices({ db, stateDir, log: (_t, l) => logs.push(l), now: () => T0 })
    const file = join(stateDir, 'speech', 'pending-notices.json')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.migrated`)).toBe(true)
    expect(logs.some(l => l.includes('imported 2 pending notice(s)'))).toBe(true)
    const [g] = p.groups(T0)
    expect(g!.items.map(i => [i.id, i.text, i.at])).toEqual([['k1', '定时 j1 停了', '2026-11-04T09:00:00.000Z'], ['k2', '老王来信', '2026-11-04T09:30:00.000Z']])
    expect(g!.dropped).toBe(2)
    expect(db.query("SELECT expires_at FROM speech_pending WHERE id='k1'").get()).toEqual({ expires_at: Date.parse('2026-11-04T09:00:00.000Z') + 24 * 3600_000 })
    // 半路崩了、文件还在(拷回去模拟)⇒ 再读一遍也不重复
    writeFileSync(file, readFileSync(`${file}.migrated`))
    makePendingNotices({ db, stateDir, log: () => {}, now: () => T0 })
    expect(db.query("SELECT COUNT(*) AS n FROM speech_pending WHERE status='pending'").get()).toEqual({ n: 2 })
    expect(db.query("SELECT COUNT(*) AS n FROM speech_pending WHERE status='overflow'").get()).toEqual({ n: 2 })
  })

  it('真机上那份(空的 {"items":[],"dropped":{}})⇒ 什么都不进,照样改名', () => {
    const stateDir = legacy({ items: [], dropped: {} })
    const db = openTestDb()
    makePendingNotices({ db, stateDir, log: () => {} })
    expect(db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
    expect(existsSync(join(stateDir, 'speech', 'pending-notices.json.migrated'))).toBe(true)
  })

  it('读不了(坏 JSON)⇒ 原样留着、记一行,开机照常', () => {
    const stateDir = legacy('{not json')
    const logs: string[] = []
    makePendingNotices({ db: openTestDb(), stateDir, log: (_t, l) => logs.push(l) })
    expect(existsSync(join(stateDir, 'speech', 'pending-notices.json'))).toBe(true)
    expect(logs.some(l => l.includes('unreadable'))).toBe(true)
  })

  it('带 BOM 的(Windows 记事本存过)照样读', () => {
    const stateDir = legacy(`﻿${JSON.stringify({ items: [{ id: 'b1', kind: 'boot_notice', chatId: OWNER, text: 'x', at: '2026-11-04T09:00:00.000Z' }], dropped: {} })}`)
    const db = openTestDb()
    makePendingNotices({ db, stateDir, log: () => {} })
    expect(db.query("SELECT id FROM speech_pending").all()).toEqual([{ id: 'b1' }])
  })
})
