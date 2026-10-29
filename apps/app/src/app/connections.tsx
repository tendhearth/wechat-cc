import { useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { Button } from '../ui/Button'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Dot } from '../ui/Dot'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { formatSynced } from '../view/connection'
import { connectionsPage } from '../view/connections'

// CC 的连接:来源 / 家里的电脑 / 最近在做 / 成果。圆点旁一定有文字;读不到 ⇒ 说「不知道」,不画绿。
// 电脑先出现,来源和能力随后;每组靠留白,状态圆点始终带真实文字。
export default function Connections() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const q = useQuery('connections', () => backend.connections(), { refreshOnMount: true })
  // stale 或演示 ⇒ 所有圆点灰(演示没有电脑,不画绿);顶上一行与桌面连接卡同义
  const { trust, view: v, headline } = connectionsPage(q, conn.state, Date.now(), lang, { demo: backend.mode === 'demo' })
  const heading = (k: Parameters<typeof t>[1]) => <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginTop: space.m }}>{t(lang, k)}</Txt>
  const row = (testID: string, key: string, dot: Parameters<typeof Dot>[0]['kind'] | null, name: string, label: string, onPress?: () => void, user = false) => (
    <Pressable
      key={key}
      testID={testID}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${name}, ${label}`}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 56, paddingVertical: space.s, opacity: pressed ? 0.7 : 1 })}
    >
      {dot ? <Dot kind={dot} size={8} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt role="body" content={user ? 'user' : 'ui'} numberOfLines={1}>{name}</Txt>
        <Txt role="small" tone="inkSoft">{label}</Txt>
      </View>
      {onPress ? <Icon name="chevronRight" size={16} color={c.inkSoft} /> : null}
    </Pressable>
  )
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={st(lang, 'connections')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} actions={<IconButton name="refresh" testID="connections-refresh" label={t(lang, 'sessions.refreshRecords')} busy={q.loading} onPress={() => void q.refresh()} />} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.s }}>
        {!v ? (
          <View style={{ gap: space.m }}>
            <Txt testID="connections-unknown" role="bubble" tone="inkSoft">{t(lang, q.error ? 'links.unknown' : 'sessions.loading')}</Txt>
            {q.error ? <Button kind="secondary" testID="connections-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} /> : null}
          </View>
        ) : (
          <>
            {headline ? (
              <View testID="connections-headline" accessible accessibilityRole="header" accessibilityLabel={headline.text} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                <Dot kind={headline.dot} size={8} />
                <Txt role="body">{headline.text}</Txt>
              </View>
            ) : null}
            {trust === 'stale' ? (
              <Txt testID="connections-stale" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">
                {q.syncedAt === undefined ? t(lang, 'links.unknown') : t(lang, 'links.staleAt', { time: formatSynced(q.syncedAt, Date.now(), lang) })}
              </Txt>
            ) : null}
            {heading('links.computers')}
            <View style={{ gap: space.s }}>
              {v.computers.map(x => row(x.id === 'home' ? 'connections-computer-home' : `connections-computer-${x.id}`, x.id, x.dot, x.label, x.detail))}
            </View>
            {v.capabilities.length > 0 ? (
              <>
                {heading('links.capabilities')}
                <View testID="connections-capabilities" style={{ gap: space.s }}>
                  {v.capabilities.map(x => row(`connections-cap-${x.id}`, `cap:${x.id}`, x.dot, x.name, x.action ? `${x.label}\n${x.action}` : x.label))}
                </View>
              </>
            ) : null}
            {heading('links.sources')}
            <View style={{ gap: space.s }}>
              {v.sources.map(s => row(`connections-source-${s.id}`, s.id, s.dot, s.name, s.label))}
            </View>
            {v.recent.length > 0 ? (
              <>
                {heading('links.recent')}
                <View testID="connections-recent" style={{ gap: space.s }}>
                  {v.recent.map(r => row(`connections-recent-${r.matterId}`, r.matterId, null, r.title, r.when, () => router.push(`/matter/${encodeURIComponent(r.matterId)}`), true))}
                </View>
              </>
            ) : null}
            {v.outputs.length > 0 ? (
              <>
                {heading('links.outputs')}
                <View testID="connections-outputs" style={{ gap: space.s }}>
                  {v.outputs.map((o, i) => row(`connections-output-${i}`, `${o.matterId}:${i}`, null, o.name, o.when, () => router.push(`/matter/${encodeURIComponent(o.matterId)}`)))}
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
