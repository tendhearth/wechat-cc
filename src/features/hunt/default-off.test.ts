import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeChatPrefs } from '../../daemon/chat-prefs'
import { HUNT_DEFAULT_MARKER, pinHuntForExistingOwner } from './default-off'
import { configPath } from '../../daemon/companion/paths'

const OWNER = 'owner@im.wechat'
const fresh = () => mkdtempSync(join(tmpdir(), 'hunt-default-'))
const writeConfig = (dir: string, body: string) => { mkdirSync(join(dir, 'companion'), { recursive: true }); writeFileSync(configPath(dir), body) }
const pin = (dir: string, prefs: ReturnType<typeof makeChatPrefs>) => pinHuntForExistingOwner({ stateDir: dir, chatPrefs: prefs, log: () => {} })
const marker = (dir: string) => existsSync(join(dir, 'companion', HUNT_DEFAULT_MARKER))

describe('打猎改默认关:老装机主人「没设过 = 开」开机时写成显式的开(收敛清单 ②)', () => {
  it('主动关心开着、主人没设过打猎 ⇒ 写成 hunt:true,只做一次', () => {
    const dir = fresh(), prefs = makeChatPrefs(dir)
    writeConfig(dir, JSON.stringify({ enabled: true, default_chat_id: OWNER }))
    prefs.set(OWNER, { stickers: false })
    expect(pin(dir, prefs)).toBe('pinned')
    expect(prefs.get(OWNER)).toEqual({ stickers: false, hunt: true })
    expect(marker(dir)).toBe(true)
    // 第二次开机不再动(哪怕主人之后自己关了,也不会被改回来)
    prefs.set(OWNER, { hunt: false })
    expect(pin(dir, prefs)).toBe('already')
    expect(prefs.get(OWNER).hunt).toBe(false)
  })
  it('主人明确设过(开或关)⇒ 不动,只记一次', () => {
    const dir = fresh(), prefs = makeChatPrefs(dir)
    writeConfig(dir, JSON.stringify({ enabled: true, default_chat_id: OWNER }))
    prefs.set(OWNER, { hunt: false })
    expect(pin(dir, prefs)).toBe('nothing')
    expect(prefs.get(OWNER).hunt).toBe(false)
    expect(marker(dir)).toBe(true)
  })
  it('新装(没有伙伴配置 / 主动关心没开 / 还没有主人)⇒ 不写,之后开了主动关心打猎也默认关', () => {
    const a = fresh(), pa = makeChatPrefs(a)
    expect(pin(a, pa)).toBe('nothing') // config.json 不存在 = 新装,判过了
    expect(marker(a)).toBe(true)
    writeConfig(a, JSON.stringify({ enabled: true, default_chat_id: OWNER }))
    expect(pin(a, pa)).toBe('already')
    expect(pa.get(OWNER).hunt).toBeUndefined()
    const b = fresh(), pb = makeChatPrefs(b)
    writeConfig(b, JSON.stringify({ enabled: false, default_chat_id: OWNER }))
    expect(pin(b, pb)).toBe('nothing')
    expect(pb.get(OWNER).hunt).toBeUndefined()
    const c = fresh(), pc = makeChatPrefs(c)
    writeConfig(c, JSON.stringify({ enabled: true, default_chat_id: null }))
    expect(pin(c, pc)).toBe('nothing')
  })
  it('**配置在但读坏了 ⇒ 不判、不写标记**;下次配置好了再开机照样写成开(整合者评审 #504)', () => {
    const dir = fresh(), prefs = makeChatPrefs(dir)
    writeConfig(dir, '{"enabled": tr') // 半写的文件
    expect(pin(dir, prefs)).toBe('unreadable')
    expect(marker(dir)).toBe(false)
    expect(prefs.get(OWNER).hunt).toBeUndefined()
    writeConfig(dir, JSON.stringify(['not', 'an', 'object']))
    expect(pin(dir, prefs)).toBe('unreadable')
    writeConfig(dir, JSON.stringify({ default_chat_id: OWNER })) // enabled 不是布尔 ⇒ 也不算判过
    expect(pin(dir, prefs)).toBe('unreadable')
    expect(marker(dir)).toBe(false)
    writeConfig(dir, JSON.stringify({ enabled: true, default_chat_id: OWNER }))
    expect(pin(dir, prefs)).toBe('pinned')
    expect(prefs.get(OWNER).hunt).toBe(true)
  })
})
