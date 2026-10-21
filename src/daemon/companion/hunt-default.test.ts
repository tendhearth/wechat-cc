import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeChatPrefs } from '../chat-prefs'
import { HUNT_DEFAULT_MARKER, pinHuntForExistingOwner } from './hunt-default'

const OWNER = 'owner@im.wechat'
const fresh = () => mkdtempSync(join(tmpdir(), 'hunt-default-'))

describe('打猎改默认关:老装机主人「没设过 = 开」开机时写成显式的开(收敛清单 ②)', () => {
  it('主动关心开着、主人没设过打猎 ⇒ 写成 hunt:true,只做一次', () => {
    const dir = fresh(), prefs = makeChatPrefs(dir)
    prefs.set(OWNER, { stickers: false })
    expect(pinHuntForExistingOwner({ stateDir: dir, chatPrefs: prefs, companion: { enabled: true, default_chat_id: OWNER }, log: () => {} })).toBe('pinned')
    expect(prefs.get(OWNER)).toEqual({ stickers: false, hunt: true })
    expect(existsSync(join(dir, 'companion', HUNT_DEFAULT_MARKER))).toBe(true)
    // 第二次开机不再动(哪怕主人之后自己关了,也不会被改回来)
    prefs.set(OWNER, { hunt: false })
    expect(pinHuntForExistingOwner({ stateDir: dir, chatPrefs: prefs, companion: { enabled: true, default_chat_id: OWNER }, log: () => {} })).toBe('already')
    expect(prefs.get(OWNER).hunt).toBe(false)
  })
  it('主人明确设过(开或关)⇒ 不动,只记一次', () => {
    const dir = fresh(), prefs = makeChatPrefs(dir)
    prefs.set(OWNER, { hunt: false })
    expect(pinHuntForExistingOwner({ stateDir: dir, chatPrefs: prefs, companion: { enabled: true, default_chat_id: OWNER }, log: () => {} })).toBe('nothing')
    expect(prefs.get(OWNER).hunt).toBe(false)
  })
  it('新装(主动关心没开 / 还没有主人)⇒ 不写,之后开了主动关心打猎也默认关', () => {
    const a = fresh(), pa = makeChatPrefs(a)
    expect(pinHuntForExistingOwner({ stateDir: a, chatPrefs: pa, companion: { enabled: false, default_chat_id: OWNER }, log: () => {} })).toBe('nothing')
    expect(pa.get(OWNER).hunt).toBeUndefined()
    expect(pinHuntForExistingOwner({ stateDir: a, chatPrefs: pa, companion: { enabled: true, default_chat_id: OWNER }, log: () => {} })).toBe('already')
    expect(pa.get(OWNER).hunt).toBeUndefined()
    const b = fresh(), pb = makeChatPrefs(b)
    expect(pinHuntForExistingOwner({ stateDir: b, chatPrefs: pb, companion: { enabled: true, default_chat_id: null }, log: () => {} })).toBe('nothing')
  })
})
