import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { derivePushKey } from '@wechat-cc/protocol'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useSession } from '../state/session'
import { PushBanner } from '../ui/PushBanner'
import { bannerFrom, type Banner } from './banner'
import { devPushToken, fallbackPushToken } from './dev-token'
import { bannerKey, makeSeenOnce, notificationTimeMs, tapKey } from './open'
import { pushOpenHref } from './route'
import { targetFromNotification } from './target'

/**
 * iOS:点通知(冷启动 / 后台 / 前台)⇒ 中转页;app 在前台收到通知 ⇒ 自己的横幅。
 * 安卓:expo 的 JS 通知监听对我们自己的消息服务发的通知不触发 —— 点击只走 Kotlin 发的 tendhearth://push-open 深链
 * (+native-intent 洗过再进中转页),安卓没有 app 内横幅。
 * 扩展没解开时,用配对记录里的设备令牌在 app 里兜底解一次(时间用通知送达时刻;Notification.date 在 iOS 是秒 ⇒ 换成毫秒)。
 * 没配对时(演示),开发构建里用 /dev-push-key 记下的合成开发令牌兜底(dev-token.ts,只为模拟器验证;发布构建不用)。
 * 去重:同一次点击(identifier + 送达时刻,裁决 C5)只路由一次;同一份推送(扩展把重复静默交来时不带标记)本次运行只弹一次横幅。
 */
export function PushRouter() {
  const router = useRouter()
  const lang = useLang()
  const { pairing } = useSession()
  const last = Notifications.useLastNotificationResponse()
  const taps = useRef(makeSeenOnce())
  const banners = useRef(makeSeenOnce())
  const [banner, setBanner] = useState<Banner | null>(null)
  const devTok = useSyncExternalStore(devPushToken.subscribe, devPushToken.get)
  const key = useMemo(() => {
    const tok = fallbackPushToken(pairing?.deviceToken, devTok, __DEV__)
    return tok ? derivePushKey(tok) : null
  }, [pairing, devTok])
  const os = Platform.OS === 'ios' ? 'ios' : 'android'

  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    if (!taps.current.first(tapKey(last.notification, os))) return
    const now = notificationTimeMs(last.notification.date, os)
    const target = targetFromNotification(last.notification, key ? { key, now } : undefined)
    setBanner(null)
    router.push(target ? pushOpenHref(target) : '/')
  }, [last, key, router, os])

  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(n => {
      if (!banners.current.first(bannerKey(n, os))) return
      const now = notificationTimeMs(n.date, os)
      setBanner(bannerFrom(n, lang, key ? { key, now } : undefined))
    })
    return () => sub.remove()
  }, [lang, key, os])

  const close = useCallback(() => setBanner(null), [])
  if (!banner) return null
  return (
    <PushBanner banner={banner} openLabel={t(lang, 'push.bannerOpen')} onClose={close}
      onOpen={() => { const b = banner; setBanner(null); router.push(b.target ? pushOpenHref(b.target) : '/') }} />
  )
}
