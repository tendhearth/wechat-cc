import { describe, it, expect } from 'vitest'
import { LAN_ONLY_OPS, LINK_ROUTES, PHONE_ROUTES, PHONE_TOPICS, phoneRouteAllowed, phoneTopicAllowed } from './phone-routes'

describe('phoneRouteAllowed', () => {
  it('精确键命中', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/set/api/state')).toBe(true)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'POST', '/m/api/matter/create')).toBe(true)
  })
  it('前缀键(以 / 结尾)命中其下所有路径', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/sticker/abc.png')).toBe(true)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/sticker')).toBe(false)
  })
  it('路径在册但方法不同 ⇒ 放行,交给处理器回 405(裁决 2)', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/attachment/chunk')).toBe(true)
  })
  it('不在册的路径 ⇒ 拒', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/nope')).toBe(false)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/v1/health')).toBe(false)
  })
  it('链接令牌与设备令牌同一套(裁决 1),但终端会话的「接着说」「拍板」(评审 10-15 #3)与「CC 的信」(2026-10-18,私事;连同能读出信页的 chat/file)只给配好的设备;只允局域网的三条', () => {
    // chat/file:信的每一页也镜像进对话,链接令牌不能从这里读出信(评审 10-19 #1)
    const deviceOnly = ['GET /m/api/letters', 'GET /m/api/letters/page', 'GET /m/api/chat/file', 'POST /m/api/cli/permission', 'POST /m/api/cli/say', 'GET /m/api/jobs', 'POST /m/api/jobs/action', 'GET /m/api/activity', 'GET /m/api/lessons', 'POST /m/api/lessons/add', 'POST /m/api/lessons/remove', 'GET /m/api/matter/rewind', 'POST /m/api/matter/rewind', 'POST /m/api/matter/review-return', 'POST /m/api/matter/review-comment', 'POST /m/api/matter/review-comments-send', 'POST /m/api/matter/say', 'POST /m/api/matter/create', 'POST /m/api/matter/permission', 'POST /m/api/matter/answer', 'POST /m/api/matter/handoff', 'POST /m/api/session/continue', 'POST /m/api/matter/worktree', 'POST /m/api/chat/say', 'POST /m/api/push/register', 'POST /m/api/push/test']
    expect([...LINK_ROUTES].sort()).toEqual([...PHONE_ROUTES].filter(r => !deviceOnly.includes(r)).sort())
    for (const r of deviceOnly) { expect(PHONE_ROUTES.has(r)).toBe(true); expect(LINK_ROUTES.has(r)).toBe(false) }
    // 退回 / 行评论给执行者的话是指令 ⇒ 只给设备(#456 评审);review-mark 只记标记,链接令牌照旧能用
    expect(LINK_ROUTES.has('POST /m/api/matter/review-mark')).toBe(true)
    expect([...LAN_ONLY_OPS].sort()).toEqual(['forget_devices', 'revoke_device', 'set_remote'])
  })
})

describe('phoneTopicAllowed', () => {
  it('三个固定主题精确命中', () => {
    expect(phoneTopicAllowed('home')).toBe(true)
    expect(phoneTopicAllowed('approvals')).toBe(true)
    expect(phoneTopicAllowed('agents')).toBe(true)
  })
  it('matter/<id>:id 合法就放行', () => {
    expect(phoneTopicAllowed('matter/abc123')).toBe(true)
    expect(phoneTopicAllowed('matter/a')).toBe(true)
    expect(phoneTopicAllowed(`matter/${'a'.repeat(64)}`)).toBe(true)
  })
  it('matter/ 前缀本身、id 超长、id 里有非法字符、路径穿越 ⇒ 拒', () => {
    expect(phoneTopicAllowed('matter/')).toBe(false)
    expect(phoneTopicAllowed(`matter/${'a'.repeat(65)}`)).toBe(false)
    expect(phoneTopicAllowed('matter/../x')).toBe(false)
    expect(phoneTopicAllowed('matter/a b')).toBe(false)
    expect(phoneTopicAllowed('matter/a/b')).toBe(false)
  })
  it('未知主题 ⇒ 拒', () => {
    expect(phoneTopicAllowed('unknown')).toBe(false)
    expect(phoneTopicAllowed('')).toBe(false)
    expect(phoneTopicAllowed('Home')).toBe(false)
  })
})

describe('链接令牌能做的写操作:每条都要归类(审计 10-20)', () => {
  it('every POST is either device-only or on LINK_WRITE_OK with a reason; nothing that reaches an executor is link-writable', async () => {
    const { LINK_WRITE_OK } = await import('./phone-routes')
    const posts = [...PHONE_ROUTES].filter(r => r.startsWith('POST '))
    for (const r of posts) expect(LINK_ROUTES.has(r) === r in LINK_WRITE_OK, r).toBe(true)
    for (const [r, why] of Object.entries(LINK_WRITE_OK)) { expect(PHONE_ROUTES.has(r), r).toBe(true); expect(why.length, r).toBeGreaterThan(4) }
    for (const r of ['POST /m/api/matter/say', 'POST /m/api/chat/say', 'POST /m/api/matter/create', 'POST /m/api/matter/permission']) expect(LINK_ROUTES.has(r), r).toBe(false)
  })
})
