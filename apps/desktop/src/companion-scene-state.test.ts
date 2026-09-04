import { describe, expect, it } from 'vitest'
import { sceneStateFrom } from './companion-scene-state.js'

const P = (presence: string, kind = 'idle', label = '', news = { unread: 0, latest_kind: null as string | null, latest_title: null as string | null }) =>
  ({ presence, activity: { kind, label, since: null }, news })

describe('sceneStateFrom — spec §3.2 逐行', () => {
  it('null / down / offline → 熊不在,dark,牌子「离线」(事实,不是故事)', () => {
    for (const p of [null, P('down'), P('offline')]) {
      const s = sceneStateFrom(p as never)
      expect(s).toMatchObject({ bearPresent: false, tint: 'dark', sign: '离线', bubble: null })
    }
  })
  it('down 时即使有 activity 也不讲故事', () => {
    expect(sceneStateFrom(P('down', 'visiting', '去X家串门了')).sign).toBe('离线')
  })
  it('degraded → dim,其余按 activity', () => {
    expect(sceneStateFrom(P('degraded', 'foraging', '觅食中'))).toMatchObject({ bearPresent: true, tint: 'dim', bearPose: 'fishing', sign: '觅食中' })
  })
  it('chatting → wave + bubble,没牌子', () => {
    expect(sceneStateFrom(P('ok', 'chatting', '在跟你聊'))).toMatchObject({ bearPresent: true, bearPose: 'wave', sign: null, bubble: '在跟你聊' })
  })
  it('hosting_human → wave + 牌子「家里有客人」', () => {
    expect(sceneStateFrom(P('ok', 'hosting_human', '家里有客人'))).toMatchObject({ bearPose: 'wave', sign: '家里有客人', bubble: null })
  })
  it('visiting → 熊不在,牌子 = label(缺席就是内容)', () => {
    expect(sceneStateFrom(P('ok', 'visiting', '去邻居「阿柚」家串门了'))).toMatchObject({ bearPresent: false, tint: 'normal', sign: '去邻居「阿柚」家串门了' })
  })
  it('hosting_peer → 熊在,idle,牌子 = label', () => {
    expect(sceneStateFrom(P('ok', 'hosting_peer', 'X来串门了'))).toMatchObject({ bearPresent: true, bearPose: 'idle', sign: 'X来串门了' })
  })
  it('foraging → fishing + 牌子「觅食中」', () => {
    expect(sceneStateFrom(P('ok', 'foraging', '觅食中'))).toMatchObject({ bearPose: 'fishing', sign: '觅食中' })
  })
  it('working → busy + bubble,没牌子', () => {
    expect(sceneStateFrom(P('ok', 'working', '在忙一件事'))).toMatchObject({ bearPose: 'busy', sign: null, bubble: '在忙一件事' })
  })
  it('idle → 全空', () => {
    expect(sceneStateFrom(P('ok'))).toEqual({ bearPresent: true, bearPose: 'idle', tint: 'normal', sign: null, prop: null, badge: 0, bubble: null })
  })
})

describe('sceneStateFrom — 道具', () => {
  const news = (k: string | null, n = 2) => ({ unread: n, latest_kind: k, latest_title: 't' })
  it('unread 0 → 没道具,不管 kind', () => {
    expect(sceneStateFrom(P('ok', 'idle', '', news('hunt', 0)))).toMatchObject({ prop: null, badge: 0 })
  })
  it('hunt → bag;visit / postcard → postcard;letter → letter;其它 → bag;badge = unread', () => {
    expect(sceneStateFrom(P('ok', 'idle', '', news('hunt')))).toMatchObject({ prop: 'bag', badge: 2 })
    expect(sceneStateFrom(P('ok', 'idle', '', news('visit')))).toMatchObject({ prop: 'postcard' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('postcard')))).toMatchObject({ prop: 'postcard' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('letter')))).toMatchObject({ prop: 'letter' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('gift')))).toMatchObject({ prop: 'bag' })
  })
  it('熊不在家(visiting)时道具照样摆着 —— 回来之前带的东西还在', () => {
    expect(sceneStateFrom(P('ok', 'visiting', '去X家', news('hunt', 1)))).toMatchObject({ bearPresent: false, prop: 'bag', badge: 1 })
  })
  it('down 时不画道具(daemon 都没起,数字不可信)', () => {
    expect(sceneStateFrom(P('down', 'idle', '', news('hunt', 3)))).toMatchObject({ prop: null, badge: 0 })
  })
})

describe('sceneStateFrom — 残缺输入', () => {
  it('无 activity 无 news → idle 全空', () => {
    const s = sceneStateFrom({ presence: 'ok' } as never)
    expect(s).toEqual({ bearPresent: true, bearPose: 'idle', tint: 'normal', sign: null, prop: null, badge: 0, bubble: null })
  })
  it('unread 异常值(NaN、负数、浮点)→ badge = 0,prop = null', () => {
    expect(sceneStateFrom({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: NaN, latest_kind: 'hunt', latest_title: 't' } } as never))
      .toMatchObject({ prop: null, badge: 0 })
    expect(sceneStateFrom({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: -3, latest_kind: 'hunt', latest_title: 't' } } as never))
      .toMatchObject({ prop: null, badge: 0 })
  })
  it('unread 浮点截断 → badge 向下取整', () => {
    expect(sceneStateFrom({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 2.7, latest_kind: 'hunt', latest_title: 't' } } as never))
      .toMatchObject({ prop: 'bag', badge: 2 })
  })
  it('无 activity 但有 news → 正常读 news', () => {
    expect(sceneStateFrom({ presence: 'ok', news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } } as never))
      .toMatchObject({ bearPose: 'idle', prop: 'bag', badge: 1 })
  })
})
