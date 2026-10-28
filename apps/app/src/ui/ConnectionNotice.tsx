import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { labelJoin, t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { connectionNotice } from '../view/connection'
import { Button } from './Button'
import { Card } from './Card'
import { MotionView } from './motion'
import { StatusHint } from './StatusHint'
import { space } from './tokens'
import { Txt } from './Txt'

// 离线 / 连接中保留可见状态,同步时间和草稿说明按需看;撤销保留完整修复入口。
// only='revoked':只在撤销时出东西 —— 此刻页的离线 / 连接中已经写在顶栏状态行里,不再说第二遍。
export function ConnectionNotice({ only }: { only?: 'revoked' } = {}) {
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const signature = `${conn.epoch}:${conn.state}`
  const event = useRef<{ signature: string; key?: string }>({ signature })
  if (event.current.signature !== signature) event.current = { signature, key: signature }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id) }, [])
  const n = connectionNotice(conn, now, lang)
  if (!n) return null
  if (n.kind === 'revoked') {
    return (
      <Card testID="conn-notice-revoked" style={{ gap: space.s }}>
        <Txt role="item" accessibilityRole="header" accessibilityLiveRegion="polite">{n.text}</Txt>
        <Button kind="primary" testID="conn-repair" label={t(lang, 'conn.repair')} onPress={() => router.push('/pair')} />
      </Card>
    )
  }
  if (only === 'revoked') return null
  return (
    <MotionView kind="status" eventKey={event.current.key} style={{ alignItems: 'center' }}>
      <View accessibilityLiveRegion="polite">
        <StatusHint testID={`conn-notice-${n.kind}`} icon={n.kind === 'connecting' ? 'refresh' : 'clock'}
          label={labelJoin(t(lang, 'feedback.connection'), t(lang, n.kind === 'connecting' ? 'feedback.connecting' : 'feedback.offline'))}
          shortLabel={t(lang, n.kind === 'connecting' ? 'feedback.connecting' : 'feedback.offline')} description={n.text} />
      </View>
    </MotionView>
  )
}
