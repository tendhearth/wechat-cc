import { useEffect, useState } from 'react'
import { Image, Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { ccPresence, statusLine, statusLineTicks } from '../view/presence'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')

// 状态行只在两个标签页(此刻 / 一起做,传 showStatus)出现;有返回键的详情页不显示,连接问题由 ConnectionNotice 说。
// 左:返回 / 标题(不截断);右:「● 家里的电脑 · 在线」(演示:「● 演示 · 没有连电脑」灰点)(传了 onConnection 就是 CC 的连接入口)+ 头像(进设置)。
export function TopBar({ title, onBack, showStatus = false, onAvatar, onConnection, connectionTestID }: {
  title?: string; onBack?: () => void; showStatus?: boolean; onAvatar?: () => void; onConnection?: () => void; connectionTestID?: string
}) {
  const lang = useLang()
  const conn = useConnection()
  const demo = useBackendCtx().backend.mode === 'demo'
  const [now, setNow] = useState(() => Date.now())
  // 只有「HH:MM 同步」会随时间变:离线且同步过才走 30 秒的钟,别的时候不空转
  const ticks = showStatus && statusLineTicks(conn, { demo })
  useEffect(() => {
    if (!ticks) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [ticks])
  const s = statusLine(conn, now, lang, { demo })
  const status = (
    <View accessible testID="topbar-connection" accessibilityLabel={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexShrink: 1 }}>
      <Dot kind={s.dot} size={8} />
      <Txt role="small" tone="inkSoft" numberOfLines={1} style={{ flexShrink: 1 }}>{s.text}</Txt>
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <Pressable accessibilityRole="button" testID="topbar-back" accessibilityLabel={t(lang, 'common.back')} onPress={onBack} hitSlop={12}>
          <Txt role="title">‹</Txt>
        </Pressable>
      ) : null}
      {/* 字标永不截断:挤的时候让右边的状态行缩;别的页面标题(可能很长,如会话名)照常可截断 */}
      <Txt role="wordmark" numberOfLines={1} style={{ flexShrink: title === t(lang, 'common.wordmark') ? 0 : 1 }}>{title ?? ''}</Txt>
      <View style={{ flex: 1 }} />
      {showStatus ? (onConnection ? (
        <Pressable testID={connectionTestID} accessibilityRole="button" accessibilityLabel={`${t(lang, 'common.openConnections')}, ${s.label}`} onPress={onConnection} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center', flexShrink: 1 }}>{status}</Pressable>
      ) : status) : null}
      <Pressable accessibilityRole="button" testID="topbar-settings" accessibilityLabel={t(lang, 'settings.title')} onPress={onAvatar} hitSlop={8}
        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Image source={ccPresence(conn) === 'here' ? lit : unlit} style={{ width: 28, height: 28 }} resizeMode="contain" />
      </Pressable>
    </View>
  )
}
