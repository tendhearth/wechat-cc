import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { CCFigure } from '../../ui/CCFigure'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { SayBar } from '../../ui/SayBar'
import { StatusPill } from '../../ui/StatusPill'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { togetherView } from '../../view/together'

// 「一起做」:全部没归档的事;等你决定的排前面。每行标题 + 状态词 + 副标题,点进进展页。
// 最上面置顶「和 CC 的对话」(主人自己那条;读不到 / 没主人就不显示),点进 /chat。
export default function Together() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { approvals, agents, matters } = useWork()
  const rows = togetherView(matters, approvals, agents)
  const { backend } = useBackendCtx()
  const chat = useQuery('chat:latest', () => backend.chat({}))
  const { refresh: refreshChat } = chat
  useFocusEffect(useCallback(() => { void refreshChat() }, [refreshChat]))
  const lastLine = chat.data?.pending?.text ?? chat.data?.messages[chat.data.messages.length - 1]?.text ?? ''
  const pinned = chat.data ? (
    <Pressable
      testID="together-pinned-chat"
      accessibilityRole="button"
      accessibilityLabel={lastLine ? `${t(lang, 'chat.pinnedTitle')}, ${lastLine}` : t(lang, 'chat.pinnedTitle')}
      onPress={() => router.push('/chat')}
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
      <CCFigure size={44} />
      <View style={{ flex: 1, gap: space.xs }}>
        <Text numberOfLines={1} style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{t(lang, 'chat.pinnedTitle')}</Text>
        {lastLine ? <Text numberOfLines={1} style={{ color: c.muted, fontSize: 13 }}>{lastLine}</Text> : null}
      </View>
      <Text style={{ color: c.muted, fontSize: 22 }}>›</Text>
    </Pressable>
  ) : null

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
        ListHeaderComponent={pinned}
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
        <SayBar testID="together-say" placeholder={t(lang, 'now.sayToCC')} onPress={() => router.push('/chat')} />
      </View>
    </SafeAreaView>
  )
}
