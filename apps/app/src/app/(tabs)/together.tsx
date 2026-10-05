import { useRouter } from 'expo-router'
import { FlatList, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useWork } from '../../state/useWork'
import { useAllMatterInputs, useInputRecovery } from '../../state/useMatterInputs'
import { inputNeedsChecking } from '../../state/matter-inputs'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { LinkRow } from '../../ui/Rows'
import { SayBar } from '../../ui/SayBar'
import { StatusPill } from '../../ui/StatusPill'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { togetherView } from '../../view/together'

// 「一起做」:交给 CC 的事(全部没归档的;等你决定的排前面)。每行标题 + 状态词 + 副标题,点进进展页。
// 和 CC 的对话只住在「此刻」(2026-10-05,同一件东西只有一个家);这里底部是「交办」,不是「跟 CC 说」。
// 「电脑上的会话」是把电脑上已有的会话接进来,放在列表末尾,不和事情抢第一眼。
export default function Together() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { approvals, agents, matters } = useWork()
  const rows = togetherView(matters, approvals, agents)
  const saved = useAllMatterInputs().filter(inputNeedsChecking).length
  const recovery = useInputRecovery()

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        title={t(lang, 'together.title')}
        showStatus
        onAvatar={() => router.push('/settings')}
      />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, flexGrow: 1 }}
        ListHeaderComponent={saved || recovery.phase !== 'ready' ? <LinkRow testID="together-saved-inputs" label={`${t(lang, 'input.savedTitle')}${saved ? ` · ${saved}` : ''}`} onPress={() => router.push('/inputs')} /> : null}
        ListFooterComponent={<LinkRow testID="together-sessions" label={t(lang, 'sessions.title')} onPress={() => router.push('/sessions')} />}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center', paddingVertical: space.xxl }}>
            <Txt testID="together-empty" role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>
              {t(lang, 'together.empty')}
            </Txt>
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
              borderBottomColor: c.hair,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View style={{ flex: 1, gap: space.s }}>
              <Txt role="item" content="user" numberOfLines={2}>{item.title}</Txt>
              <StatusPill status={item.status} />
              {item.subtitle ? <Txt role="small" tone="inkSoft" content="user" numberOfLines={1}>{item.subtitle}</Txt> : null}
            </View>
            <Txt role="title" tone="inkSoft">›</Txt>
          </Pressable>
        )}
      />
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="together-delegate" placeholder={t(lang, 'together.delegate')} onPress={() => router.push('/compose')} />
      </View>
    </SafeAreaView>
  )
}
