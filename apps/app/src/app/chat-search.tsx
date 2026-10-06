import { useRouter } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ChatSearchHitT } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { canSubmit } from '../view/connection'
import { searchSegments } from '../view/chat-search'
import { TextField } from '../ui/TextField'
import { TopBar } from '../ui/TopBar'
import { radius, space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

const pad = (n: number) => String(n).padStart(2, '0')
const when = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

// 搜和 CC 的对话(2026-10-06,对标 Orca 会话历史搜索):微信、电脑、手机说过的都在这条对话里。新的在前,最多 30 条。
export default function ChatSearch() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const online = canSubmit(useConnection())
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [hits, setHits] = useState<ChatSearchHitT[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async () => {
    const query = q.trim()
    if (!query || busy || !online) return
    setBusy(true); setFailed(false)
    try { setHits(await backend.chatSearch(query)); setAsked(query) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'chatSearch.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/chat'))} />
      <View style={{ flexDirection: 'row', gap: space.s, paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <TextField testID="chat-search-input" accessibilityLabel={t(lang, 'chatSearch.placeholder')} value={q} onChangeText={setQ} placeholder={t(lang, 'chatSearch.placeholder')}
          returnKeyType="search" onSubmitEditing={() => void run()} autoFocus maxLength={200}
          style={{ flex: 1, minHeight: 44, paddingHorizontal: space.l, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper }} />
        <Pressable testID="chat-search-go" accessibilityRole="button" accessibilityLabel={t(lang, 'chatSearch.go')} disabled={!q.trim() || busy || !online} onPress={() => void run()}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: radius.control, backgroundColor: c.accent, opacity: !q.trim() || busy || !online ? 0.55 : pressed ? 0.8 : 1 })}>
          {busy ? <ActivityIndicator color={c.onAccent} /> : <Txt role="body" tone="onAccent">{t(lang, 'chatSearch.go')}</Txt>}
        </Pressable>
      </View>
      <FlatList
        testID="chat-search-list"
        data={hits ?? []}
        keyExtractor={h => h.id}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}
        ListHeaderComponent={failed ? <Txt testID="chat-search-failed" role="meta" tone="inkSoft">{t(lang, 'chatSearch.failed')}</Txt>
          : hits ? <Txt testID="chat-search-count" role="meta" tone="inkSoft">{hits.length ? t(lang, 'chatSearch.count', { n: hits.length }) : t(lang, 'chatSearch.none')}</Txt> : null}
        renderItem={({ item }) => (
          <View testID="chat-search-hit" style={{ gap: space.xs, paddingBottom: space.m, borderBottomWidth: 1, borderBottomColor: c.hair }}>
            <Txt role="caption" tone="inkSoft">{t(lang, item.role === 'me' ? 'chat.me' : 'cc.label')} · {when(item.at)}{item.source === 'wechat' || item.source === 'desktop' || item.source === 'phone' ? ` · ${t(lang, `chat.from.${item.source}`)}` : ''}</Txt>
            <Txt role="bubble" content="user" selectable>
              {searchSegments(item.text, asked).map((s, i) => s.hit
                ? <Txt key={i} role="bubble" content="user" style={{ backgroundColor: c.hair }}>{s.text}</Txt>
                : s.text)}{item.truncated ? '…' : ''}
            </Txt>
          </View>
        )}
      />
    </SafeAreaView>
  )
}
