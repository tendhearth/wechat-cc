import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMatterSeen } from './matter-seen'

describe('matter-seen(S3b)', () => {
  it('某一刻以后在桌面 / 手机上看过 ⇒ 回最近那个面;微信绑定、更早的不算;读不到 ⇒ null', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO matters(id,kind,title,state,created_at,updated_at,cursor) VALUES('m1','task','t','open',1,1,0);
      INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES('m1','wechat','o',500),('m1','phone','pwa',300),('m1','desktop','app',400);`)
    const seen = makeMatterSeen(db)
    expect(seen('m1', 250)).toBe('desktop')
    expect(seen('m1', 350)).toBe('desktop')
    expect(seen('m1', 450)).toBeNull()
    expect(seen('nope', 0)).toBeNull()
    db.close()
    expect(seen('m1', 0)).toBeNull()
  })
})
