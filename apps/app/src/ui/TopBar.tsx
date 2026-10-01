import { useEffect, useState } from 'react'
import { Image, Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { ccPresence, statusLine } from '../view/presence'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')

// 左:返回 / 标题;右:「● 家里的电脑 · 在线」(传了 onConnection 就是 CC 的连接入口)+ 头像(进设置)。
export function TopBar({ title, onBack, showConnection = true, onAvatar, onConnection, connectionTestID }: {
  title?: string; onBack?: () => void; showConnection?: boolean; onAvatar?: () => void; onConnection?: () => void; connectionTestID?: string
}) {
  const lang = useLang()
  const conn = useConnection()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id) }, [])
  const s = statusLine(conn, now, lang)
  const status = (
    <View accessible testID="topbar-connection" accessibilityLabel={s.text} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
      <Dot kind={s.dot} size={8} />
      <Txt role="small" tone="inkSoft" numberOfLines={1}>{s.text}</Txt>
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <Pressable accessibilityRole="button" testID="topbar-back" accessibilityLabel={t(lang, 'common.back')} onPress={onBack} hitSlop={12}>
          <Txt role="title">‹</Txt>
        </Pressable>
      ) : null}
      <Txt role="wordmark" numberOfLines={1} style={{ flex: 1 }}>{title ?? ''}</Txt>
      {showConnection ? (onConnection ? (
        <Pressable testID={connectionTestID} accessibilityRole="button" accessibilityLabel={`${t(lang, 'common.openConnections')}, ${s.text}`} onPress={onConnection} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>{status}</Pressable>
      ) : status) : null}
      <Pressable accessibilityRole="button" testID="topbar-settings" accessibilityLabel={t(lang, 'settings.title')} onPress={onAvatar} hitSlop={8}
        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Image source={ccPresence(conn) === 'here' ? lit : unlit} style={{ width: 28, height: 28 }} resizeMode="contain" />
      </Pressable>
    </View>
  )
}
