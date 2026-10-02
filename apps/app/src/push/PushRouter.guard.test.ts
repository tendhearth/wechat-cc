import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// PushRouter 引 expo / react-native,单测里起不来 ⇒ 钉源码:安卓没有 app 内横幅(Kotlin 自己发系统通知)。
describe('PushRouter 的前台横幅只在 iOS', () => {
  it('收到通知的监听在 os !== "ios" 时直接返回,不注册', () => {
    const s = readFileSync(new URL('./PushRouter.tsx', import.meta.url), 'utf8')
    const effect = s.slice(s.lastIndexOf('useEffect(', s.indexOf('addNotificationReceivedListener')), s.indexOf('addNotificationReceivedListener'))
    expect(effect).toMatch(/if \(os !== 'ios'\) return/)
  })
})
