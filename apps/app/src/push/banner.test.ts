import { describe, it, expect } from 'vitest'
import { derivePushKey, sealPush } from '@wechat-cc/protocol'
import { bannerFrom, RELAY_PLACEHOLDER_BODY, BANNER_BODY_MAX, BANNER_TITLE_MAX } from './banner'

const n = (title: string, body: string, data: Record<string, unknown> = {}) => ({ date: 1, request: { identifier: 'i', content: { title, body, data }, trigger: { type: 'push', payload: {} } } })

describe('bannerFrom —— app 在前台时自己的横幅(spec §7「正在用 app 时」)', () => {
  it('扩展解开了:用它换好的标题与正文,带上路由', () => {
    expect(bannerFrom(n('Needs your approval', '整理作品集:npm i', { tendhearth: { kind: 'permission', taskId: 'ab12cd34', requestId: 'p' } }), 'en'))
      .toEqual({ title: 'Needs your approval', body: '整理作品集:npm i', target: { kind: 'permission', taskId: 'ab12cd34', requestId: 'p' } })
  })
  it('还是中继的中文占位 / 空正文 ⇒ 按 app 语言显示中性占位,点开回此刻', () => {
    expect(bannerFrom(n('CC', RELAY_PLACEHOLDER_BODY), 'en')).toEqual({ title: 'CC', body: 'CC has news', target: null })
    expect(bannerFrom(n('', ''), 'zh-Hans')).toEqual({ title: 'CC', body: 'CC 有新动态', target: null })
  })
  const R = { kind: 'permission', taskId: 'ab12cd34', requestId: 'p' }
  it('中继伪造的文字(无合法路由、wcc 坏)⇒ 中性占位,目标 null', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    expect(bannerFrom(n('Bank alert', 'send money', { wcc: { junk: 1 } }), 'en', { key, now: 1 })).toEqual({ title: 'CC', body: 'CC has news', target: null })
    expect(bannerFrom(n('Bank alert', 'send money'), 'en')).toEqual({ title: 'CC', body: 'CC has news', target: null })
    expect(bannerFrom(n('Bank alert', 'send money', { tendhearth: { kind: 'nope' } }), 'en')).toEqual({ title: 'CC', body: 'CC has news', target: null })
  })
  it('兜底解密成功 ⇒ 显示解密出的标题与正文,不是 aps.alert 的', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    const now = 1_700_000_000_000
    const sealed = sealPush(key, { ts: now - 1000, kind: 'permission', title: '需要你批准', body: 'npm i', taskId: 'ab12cd34', requestId: 'p' })
    expect(bannerFrom(n('forged', 'forged body', { wcc: sealed }), 'en', { key, now })).toEqual({ title: '需要你批准', body: 'npm i', target: R })
  })
  it('路由畸形 + 有效 wcc ⇒ 落到兜底解密', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    const now = 1_700_000_000_000
    const sealed = sealPush(key, { ts: now, kind: 'task_done', title: 'T', body: 'B', taskId: 'ab12cd34' })
    expect(bannerFrom(n('x', 'y', { tendhearth: 5, wcc: sealed }), 'en', { key, now }).body).toBe('B')
  })
  it('超长标题 / 正文被截断并带省略号', () => {
    const b = bannerFrom(n('t'.repeat(500), 'b'.repeat(900), { tendhearth: R }), 'en')
    expect(Array.from(b.title)).toHaveLength(BANNER_TITLE_MAX)
    expect(Array.from(b.body)).toHaveLength(BANNER_BODY_MAX)
    expect(b.body.endsWith('…')).toBe(true)
  })
})
