import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { connectionNotice } from '../view/connection'
import { Button } from './Button'
import { Card } from './Card'
import { space } from './tokens'
import { useTheme } from './useTheme'

// 离线 / 连接中 / 已撤销 的一句话(spec §3)。在线时什么都不渲染。撤销给「重新配对」按钮。
export function ConnectionNotice() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id) }, [])
  const n = connectionNotice(conn, now, lang)
  if (!n) return null
  if (n.kind === 'revoked') {
    return (
      <Card testID="conn-notice-revoked" style={{ gap: space.s }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 16 }}>{t(lang, 'conn.revokedTitle')}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{n.text}</Text>
        <Button kind="primary" testID="conn-repair" label={t(lang, 'conn.repair')} onPress={() => router.push('/pair')} />
      </Card>
    )
  }
  return (
    <Text testID={`conn-notice-${n.kind}`} accessibilityLiveRegion="polite" style={{ color: n.kind === 'offline' ? c.warn : c.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>
      {n.text}
    </Text>
  )
}
