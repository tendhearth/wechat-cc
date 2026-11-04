import { describe, expect, it } from 'vitest'
import { openDb } from '../../lib/db'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { ccActMatterId } from '../../adapters/store/cc-acts'
import { huntAction } from './action'

/** 「打猎」那件事(M5b):真开了口才算去打了猎,带回了什么记一步;没去成不记。 */
describe('huntAction × CC 自己做的事', () => {
  const rig = (went: boolean | 'refused', shared: string[]) => {
    const db = openDb({ path: ':memory:' })
    const action = huntAction({
      stateDir: '/tmp/none', boot: {} as never, log: () => {}, db,
      careLedger: { claimHunt: () => 't', unclaim: () => {} } as never,
      outboundTaps: { tap: () => ({ close: () => shared }) } as never,
      journal: { recordHunt: () => shared.length } as never,
    }, { dispatchToChat: async () => went } as never)
    return { db, run: () => action.run({ chatId: 'owner@im.wechat', nowIso: '2026-11-04T10:00:00.000Z', prefs: {} } as never) }
  }
  it('去了、带回两条 ⇒ 一轮 completed,一步记带回了几条', async () => {
    const r = rig(true, ['一条链接', '另一条'])
    expect(await r.run()).toBe(true)
    const log = makeMatterLog(r.db), id = ccActMatterId('hunt')
    expect(log.turns(id)).toMatchObject([{ status: 'completed', startedAt: Date.parse('2026-11-04T10:00:00.000Z'), policy: { who: 'hunt' } }])
    expect(log.items(id).map(i => [i.kind, i.payload])).toEqual([['artifact', { messages: 2, caught: 2 }]])
    r.db.close()
  })
  it('去了但什么都没发出去(沉默 / 出错 / 发不出去,旁听什么都没收到)⇒ 一轮 failed(nothing_sent),没有步(Codex 评审)', async () => {
    const r = rig(true, [])
    await r.run()
    const log = makeMatterLog(r.db), id = ccActMatterId('hunt')
    expect(log.turns(id)).toMatchObject([{ status: 'failed', errorCode: 'nothing_sent' }])
    expect(log.items(id)).toEqual([])
    r.db.close()
  })
  it('没去成(false / refused)⇒ 不记', async () => {
    for (const went of [false, 'refused'] as const) {
      const r = rig(went, [])
      await r.run()
      expect(makeMatterLog(r.db).turns(ccActMatterId('hunt'))).toEqual([])
      r.db.close()
    }
  })
})
