import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMatterSeen } from './matter-seen'

describe('matter-seen(S3b)', () => {
  it('桌面(内存里记的)先看;再看手机绑定(某一刻以后);微信绑定、更早的不算;读不到 ⇒ null', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO matters(id,kind,title,state,created_at,updated_at,cursor) VALUES('m1','task','t','open',1,1,0);
      INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES('m1','wechat','o',500),('m1','phone','pwa',300);`)
    let desk = false
    const seen = makeMatterSeen(db, { seenSince: () => desk })
    expect(seen('m1', 250)).toBe('phone')
    expect(seen('m1', 350)).toBeNull()
    desk = true
    expect(seen('m1', 350)).toBe('desktop')
    expect(makeMatterSeen(db)('nope', 0)).toBeNull()
    db.close()
    expect(makeMatterSeen(db)('m1', 0)).toBeNull()
  })
})
