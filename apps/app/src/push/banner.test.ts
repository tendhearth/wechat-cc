import { describe, it, expect } from 'vitest'
import { bannerFrom, RELAY_PLACEHOLDER_BODY } from './banner'

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
})
