import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { statusLine, statusLineTicks } from '../view/presence'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import { useTheme } from './useTheme'

// 状态行只在两个标签页(此刻 / 一起做,传 showStatus)出现;有返回键的详情页不显示,连接问题由 ConnectionNotice 说。
// 左:返回 / 标题;右:电脑图标与真实状态点、页面动作和可选设置齿轮。完整连接说明进读屏标签与连接页。
export function TopBar({ title, onBack, showStatus = false, onAvatar, onConnection, connectionTestID, actions }: {
  title?: string; onBack?: () => void; showStatus?: boolean; onAvatar?: () => void; onConnection?: () => void; connectionTestID?: string; actions?: ReactNode
}) {
  const { c } = useTheme()
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
      <Icon name="monitor" size={16} color={c.inkSoft} />
      <Dot kind={s.dot} size={5} />
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <IconButton name="back" testID="topbar-back" label={t(lang, 'common.back')} onPress={onBack} />
      ) : null}
      {/* 字标永不截断:挤的时候让右边的状态行缩;别的页面标题(可能很长,如会话名)照常可截断 */}
      <Txt role="wordmark" numberOfLines={1} style={{ flexShrink: title === t(lang, 'common.wordmark') ? 0 : 1 }}>{title ?? ''}</Txt>
      <View style={{ flex: 1 }} />
      {showStatus ? (onConnection ? (
        <Pressable testID={connectionTestID} accessibilityRole="button" accessibilityLabel={`${t(lang, 'common.openConnections')}, ${s.label}`} onPress={onConnection} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{status}</Pressable>
      ) : status) : null}
      {actions}
      {onAvatar ? <IconButton name="settings" testID="topbar-settings" label={t(lang, 'settings.title')} onPress={onAvatar} /> : null}
    </View>
  )
}
