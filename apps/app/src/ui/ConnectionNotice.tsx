import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { connectionNotice } from '../view/connection'
import { Button } from './Button'
import { Card } from './Card'
import { space } from './tokens'
import { Txt } from './Txt'

// 离线 / 连接中 / 已撤销 的一句话(spec §3)。在线时什么都不渲染。撤销给「重新配对」按钮。
// only='revoked':只在撤销时出东西 —— 此刻页的离线 / 连接中已经写在顶栏状态行里,不再说第二遍。
export function ConnectionNotice({ only }: { only?: 'revoked' } = {}) {
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
        <Txt role="item" accessibilityRole="header">{t(lang, 'conn.revokedTitle')}</Txt>
        <Txt role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{n.text}</Txt>
        <Button kind="primary" testID="conn-repair" label={t(lang, 'conn.repair')} onPress={() => router.push('/pair')} />
      </Card>
    )
  }
  if (only === 'revoked') return null
  return (
    <Txt testID={`conn-notice-${n.kind}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ textAlign: 'center' }}>
      {n.text}
    </Txt>
  )
}
