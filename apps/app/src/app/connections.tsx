import { useRouter } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Dot } from '../ui/Dot'
import { serifFamily } from '../ui/fonts'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { formatSynced } from '../view/connection'
import { connectionsTrust, connectionsView, muteDots } from '../view/connections'

// CC 的连接:来源 / 家里的电脑 / 最近在做 / 成果。圆点旁一定有文字;读不到 ⇒ 说「不知道」,不画绿。
export default function Connections() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const q = useQuery('connections', () => backend.connections(), { refreshOnMount: true })
  const trust = connectionsTrust(q, conn.state)
  const base = q.data ? connectionsView(q.data, Date.now(), lang, { stale: trust === 'stale' }) : null
  const v = base && trust === 'stale' ? muteDots(base) : base
  const heading = (k: Parameters<typeof t>[1]) => <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontFamily: serifFamily }}>{t(lang, k)}</Text>
  const row = (testID: string, key: string, dot: Parameters<typeof Dot>[0]['kind'] | null, name: string, label: string, onPress?: () => void) => (
    <Pressable
      key={key}
      testID={testID}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${name}, ${label}`}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 44, paddingVertical: space.xs }}
    >
      {dot ? <Dot kind={dot} /> : null}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: c.ink, fontSize: 16 }}>{name}</Text>
        <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
      </View>
      {onPress ? <Text style={{ color: c.muted, fontSize: 22 }}>›</Text> : null}
    </Pressable>
  )
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'links.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} connection={conn.state === 'online' ? 'online' : 'offline'} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        {!v ? (
          <View style={{ gap: space.m }}>
            <Text testID="connections-unknown" style={{ color: c.muted, fontSize: 15 }}>{t(lang, q.error ? 'links.unknown' : 'sessions.loading')}</Text>
            {q.error ? <Button kind="secondary" testID="connections-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} /> : null}
          </View>
        ) : (
          <>
            {trust === 'stale' ? (
              <Text testID="connections-stale" accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>
                {q.syncedAt === undefined ? t(lang, 'links.unknown') : t(lang, 'links.staleAt', { time: formatSynced(q.syncedAt, Date.now(), lang) })}
              </Text>
            ) : null}
            {heading('links.sources')}
            <Card style={{ gap: space.xs }}>
              {v.sources.map(s => row(`connections-source-${s.id}`, s.id, s.dot, s.name, s.label))}
            </Card>
            {heading('links.computers')}
            <Card style={{ gap: space.xs }}>
              {v.computers.map(x => row(x.id === 'home' ? 'connections-computer-home' : `connections-computer-${x.id}`, x.id, x.dot, x.label, x.detail))}
            </Card>
            {v.recent.length > 0 ? (
              <>
                {heading('links.recent')}
                <Card testID="connections-recent" style={{ gap: space.xs }}>
                  {v.recent.map(r => row(`connections-recent-${r.matterId}`, r.matterId, null, r.title, r.when, () => router.push(`/matter/${encodeURIComponent(r.matterId)}`)))}
                </Card>
              </>
            ) : null}
            {v.outputs.length > 0 ? (
              <>
                {heading('links.outputs')}
                <Card testID="connections-outputs" style={{ gap: space.xs }}>
                  {v.outputs.map((o, i) => row(`connections-output-${i}`, `${o.matterId}:${i}`, null, o.name, o.when, () => router.push(`/matter/${encodeURIComponent(o.matterId)}`)))}
                </Card>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
