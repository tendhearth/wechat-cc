import { useRouter } from 'expo-router'
import { FlatList, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useConnection } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { SayBar } from '../../ui/SayBar'
import { StatusPill } from '../../ui/StatusPill'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { togetherView } from '../../view/together'

// 「一起做」:全部没归档的事;等你决定的排前面。每行标题 + 状态词 + 副标题,点进进展页。
export default function Together() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { approvals, agents, matters } = useWork()
  const rows = togetherView(matters, approvals, agents)

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        title={t(lang, 'together.title')}
        connection={conn.state === 'online' ? 'online' : 'offline'}
        onAvatar={() => router.push('/settings')}
      />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center', paddingVertical: space.xxl }}>
            <Text testID="together-empty" style={{ color: c.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' }}>
              {t(lang, 'together.empty')}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`together-item-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${t(lang, `status.${item.status}`)}`}
            onPress={() => router.push(`/matter/${encodeURIComponent(item.id)}`)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.m,
              paddingVertical: space.l,
              borderBottomWidth: 1,
              borderBottomColor: c.line,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View style={{ flex: 1, gap: space.s }}>
              <Text numberOfLines={2} style={{ color: c.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }}>{item.title}</Text>
              <StatusPill status={item.status} />
              {item.subtitle ? <Text numberOfLines={1} style={{ color: c.muted, fontSize: 13 }}>{item.subtitle}</Text> : null}
            </View>
            <Text style={{ color: c.muted, fontSize: 22 }}>›</Text>
          </Pressable>
        )}
      />
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="together-say" placeholder={t(lang, 'now.sayToCC')} onPress={() => router.push('/compose')} />
      </View>
    </SafeAreaView>
  )
}
