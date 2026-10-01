import { describe, it, expect } from 'vitest'
import { bannerKey, makeSeenOnce, notificationTimeMs, rewriteSystemPath, tapKey } from './open'

describe('rewriteSystemPath —— 深链进 app 之前先洗一遍(不可信输入;Review Focus 5)', () => {
  it('合法的 push-open 深链 ⇒ 规范化的 /push-open(URLSearchParams 解析,+ 解成空格)', () => {
    expect(rewriteSystemPath('tendhearth://push-open?kind=permission&taskId=a1b2c3d4&requestId=perm-demo-1', false))
      .toBe('/push-open?kind=permission&taskId=a1b2c3d4&requestId=perm-demo-1')
    expect(rewriteSystemPath('/push-open?taskId=a1b2c3d4&kind=task_done', false)).toBe('/push-open?kind=task_done&taskId=a1b2c3d4')
    expect(rewriteSystemPath('tendhearth:///push-open?kind=task_failed&taskId=a1b2c3d4#x', false)).toBe('/push-open?kind=task_failed&taskId=a1b2c3d4')
  })
  it('伪造 / 畸形字段一律丢;没有 taskId ⇒ 直接回此刻(中转页连请求都不发)', () => {
    expect(rewriteSystemPath('tendhearth://push-open?kind=permission&taskId=..%2F..%2Fx', false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://push-open?kind=permission&taskId=a1b2c3d4&requestId=a+b', false)).toBe('/push-open?kind=permission&taskId=a1b2c3d4')
    expect(rewriteSystemPath('tendhearth://push-open?kind=rm-rf&taskId=a1b2c3d4', false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://push-open?kind=permission&taskId=%E0%A4%A', false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://push-open', false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://push-open?kind=task_done&kind=permission&taskId=a1b2c3d4&taskId=ffffffff', false)).toBe('/push-open?kind=task_done&taskId=a1b2c3d4')
  })
  it('开发用密钥页只在开发构建里可达;发布构建 ⇒ 此刻', () => {
    expect(rewriteSystemPath('tendhearth://dev-push-key?token=dev' + '0'.repeat(48), false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://Dev-Push-Key/?token=x', false)).toBe('/')
    expect(rewriteSystemPath('tendhearth://push-open/?kind=task_done&taskId=a1b2c3d4', false)).toBe('/push-open?kind=task_done&taskId=a1b2c3d4')
    expect(rewriteSystemPath('tendhearth://dev-push-key?token=dev' + '0'.repeat(48), true)).toBe('tendhearth://dev-push-key?token=dev' + '0'.repeat(48))
  })
  it('别的路径原样放行(交给路由自己)', () => {
    expect(rewriteSystemPath('tendhearth://settings', false)).toBe('tendhearth://settings')
    expect(rewriteSystemPath('/matter/a1b2c3d4', false)).toBe('/matter/a1b2c3d4')
    expect(rewriteSystemPath('tendhearth://push-open-x?kind=permission', false)).toBe('tendhearth://push-open-x?kind=permission')
  })
})

describe('通知时刻与点击去重键(裁决 C5)', () => {
  it('Notification.date:iOS 是秒,安卓是毫秒 ⇒ 一律毫秒', () => {
    expect(notificationTimeMs(1_700_000_000.5, 'ios')).toBe(1_700_000_000_500)
    expect(notificationTimeMs(1_700_000_000_500, 'android')).toBe(1_700_000_000_500)
    expect(notificationTimeMs(Number.NaN, 'ios')).toBe(0)
  })
  it('tapKey = identifier:毫秒时刻(collapse-id 等于 taskId,同一件事的新通知 identifier 相同、时刻不同)', () => {
    const n = (date: number) => ({ date, request: { identifier: 'a1b2c3d4', content: {}, trigger: {} } })
    expect(tapKey(n(1_700_000_000), 'ios')).toBe('a1b2c3d4:1700000000000')
    expect(tapKey(n(1_700_000_001), 'ios')).not.toBe(tapKey(n(1_700_000_000), 'ios'))
  })
  it('bannerKey:有密文按密文(中继重发 / 扩展交来的重复是同一份密文),没有就退回 tapKey', () => {
    const a = { date: 1, request: { identifier: 'x', content: { data: { wcc: { v: 1, iv: 'i', ct: 'CT1' } } }, trigger: {} } }
    const b = { date: 2, request: { identifier: 'y', content: { data: {} }, trigger: { payload: { wcc: JSON.stringify({ v: 1, iv: 'j', ct: 'CT1' }) } } } }
    expect(bannerKey(a, 'ios')).toBe(bannerKey(b, 'ios'))
    expect(bannerKey({ date: 3, request: { identifier: 'z', content: {}, trigger: {} } }, 'ios')).toBe('id:z:3000')
  })
})

describe('makeSeenOnce —— 本次运行里同一个键只算一次,有上限', () => {
  it('第二次 ⇒ false;超出上限挤掉最早的', () => {
    const s = makeSeenOnce(2)
    expect(s.first('a')).toBe(true)
    expect(s.first('a')).toBe(false)
    expect(s.first('b')).toBe(true)
    expect(s.first('c')).toBe(true)
    expect(s.first('a')).toBe(true)
  })
})

describe('rewriteSystemPath —— 配对链接(plan 7a)', () => {
  const FRAG = `#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
  it('通用链接 ⇒ 暂存原链接,去配对页(路由参数里没有令牌);每次序号不同', () => {
    const got: string[] = []
    const a = rewriteSystemPath(`https://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))
    const b = rewriteSystemPath(`https://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))
    expect(a).toMatch(/^\/pair\?from=link&n=\d+$/)
    expect(b).not.toBe(a)
    expect(a).not.toContain('t0000')
    expect(got).toEqual([`https://relay.tendhearth.com/pset/${FRAG}`, `https://relay.tendhearth.com/pset/${FRAG}`])
  })
  it('发布构建不认 staging / 自定义 scheme 的配对链接 ⇒ 回此刻(带锚点的原链接不进路由匹配)', () => {
    const got: string[] = []
    expect(rewriteSystemPath(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))).toBe('/')
    expect(rewriteSystemPath(`https://relay-staging.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))).toBe('/')
    expect(rewriteSystemPath(`https://evil.example/pset/${FRAG}`, true, r => got.push(r))).toBe('/')
    expect(rewriteSystemPath(`tendhearth://pset/${FRAG}`, true, r => got.push(r))).toBe('/')
    expect(rewriteSystemPath(`/PSET/${FRAG}`, false, r => got.push(r))).toBe('/')
    expect(got).toEqual([])
  })
  it('外面来的 /pair 深链去掉 from / n(只有 /pset 改写自己能带上;别人不能把确认卡换成「没带全」)', () => {
    const got: string[] = []
    expect(rewriteSystemPath('tendhearth://pair?from=link&n=99', true, r => got.push(r))).toBe('/pair')
    expect(rewriteSystemPath('/pair?from=link&n=1', false, r => got.push(r))).toBe('/pair')
    expect(rewriteSystemPath('tendhearth://Pair/?n=3&from=link#x', false, r => got.push(r))).toBe('/pair')
    expect(rewriteSystemPath('tendhearth://pair', false, r => got.push(r))).toBe('/pair')
    expect(got).toEqual([])
  })
})
