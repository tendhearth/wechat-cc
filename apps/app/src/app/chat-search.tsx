import { WelcomeGate } from '../ui/WelcomeGate'
import { uuid } from '../net/uuid'
import { WorkSearchResults } from '../ui/WorkSearchResults'
import { Button } from '../ui/Button'
import { LinkRow } from '../ui/Rows'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { FlatList, Keyboard, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ChatSearchHitT } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { canSubmit } from '../view/connection'
import { searchCopy, searchSegments, type SearchTab } from '../view/chat-search'
import { TextField } from '../ui/TextField'
import { TopBar } from '../ui/TopBar'
import { IconButton } from '../ui/IconButton'
import { Icon } from '../ui/Icon'
import { componentAppearance, space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

const pad = (n: number) => String(n).padStart(2, '0')
const when = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

// 搜和 CC 的对话(2026-10-06,对标 Orca 会话历史搜索):微信、电脑、手机说过的都在这条对话里。新的在前,最多 30 条。
export default function ChatSearch() { return <WelcomeGate><ConversationSearch /></WelcomeGate> }

export function ConversationSearch() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const online = canSubmit(useConnection())
  const { scope, share } = useLocalSearchParams<{ scope?: string; share?: string }>()
  const [tab, setTab] = useState<SearchTab>(scope === 'work' ? 'work' : 'messages')
  const isWork = tab === 'work'
  const { title, placeholder } = searchCopy(tab, lang)
  const appearance = componentAppearance.button
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [hits, setHits] = useState<ChatSearchHitT[] | null>(null)
  const [hasMore,setHasMore]=useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async (more=false) => {
    const query = more?asked:q.trim()
    if (!query || busy || !online) return
    setBusy(true); setFailed(false)
    try { const next=await backend.chatSearch(query,more?hits?.at(-1)?.id:undefined);setHits(old=>more?[...new Map([...(old??[]),...next].map(h=>[h.id,h])).values()]:next);setHasMore(next.length===30);setAsked(query) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={title} onBack={() => (router.canGoBack() ? router.back() : router.replace('/chat'))} />
      <View style={{ flexDirection: 'row', gap: space.s, paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <TextField variant="search" testID="chat-search-input" accessibilityLabel={placeholder} value={q} onChangeText={setQ} placeholder={placeholder}
          returnKeyType="search" onSubmitEditing={isWork ? Keyboard.dismiss : () => void run()} autoFocus={!isWork} maxLength={200}
          style={{ flex: 1, minHeight: 44, backgroundColor: c.paper }} />
        {!isWork ? <IconButton name="search" label={t(lang, 'chatSearch.go')} testID="chat-search-go" disabled={!q.trim() || !online} busy={busy} onPress={() => void run()} /> : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.xl, gap: space.s }}>
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space.xs }}>
          {(['messages', 'work'] as const).map(key => {
            const selected = tab === key
            return <Pressable key={key} testID={`search-${key}`} accessibilityRole="tab" accessibilityState={{ selected }}
              onPress={() => { if (key === 'work') Keyboard.dismiss(); setTab(key) }}
              style={({ pressed }) => ({
                minHeight: appearance.minHeight.phone, minWidth: 44, paddingHorizontal: space.l, paddingVertical: space.s,
                justifyContent: 'center', alignItems: 'center', borderRadius: appearance.radius,
                backgroundColor: selected ? c.rail : undefined, opacity: pressed ? appearance.pressedOpacity : 1,
              })}>
              <Txt role="body" tone={selected ? 'ink' : 'inkSoft'}>{t(lang, key === 'work' ? 'chatSearch.workTab' : 'chatSearch.messagesTab')}</Txt>
            </Pressable>
          })}
        </View>
        <Pressable testID="search-topics" accessibilityRole="link" accessibilityLabel={t(lang, 'chatSearch.topicsLink')}
          onPress={() => router.push('/topics')}
          style={({ pressed }) => ({
            minHeight: appearance.minHeight.phone, minWidth: 44, flexDirection: 'row', alignItems: 'center',
            justifyContent: 'flex-end', gap: space.xs, opacity: pressed ? appearance.pressedOpacity : 1,
          })}>
          <Txt role="body">{t(lang, 'chatSearch.topicsLink')}</Txt>
          <Icon name="chevronRight" size={14} color={c.inkSoft} />
        </Pressable>
      </View>
      {isWork ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl }}><WorkSearchResults query={q} share={share === '1'} /></ScrollView> : <FlatList
        testID="chat-search-list"
        data={hits ?? []}
        keyExtractor={h => h.id}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}
        ListHeaderComponent={failed ? <Txt testID="chat-search-failed" role="meta" tone="inkSoft">{t(lang, 'chatSearch.failed')}</Txt>
          : hits ? <Txt testID="chat-search-count" role="meta" tone="inkSoft">{hits.length ? t(lang, 'chatSearch.count', { n: hits.length }) : t(lang, 'chatSearch.none')}</Txt> : null}
        ListFooterComponent={hasMore?<Button testID="chat-search-more" kind="secondary" label={t(lang,'activity.more')} disabled={busy||!online} onPress={()=>void run(true)} />:null}
        renderItem={({ item }) => (
          <View testID="chat-search-hit" style={{ gap: space.s, paddingVertical: space.m }}>
            <Txt role="caption" tone="inkSoft">{t(lang, item.role === 'me' ? 'chat.me' : 'cc.label')} · {when(item.at)}{item.source === 'wechat' || item.source === 'desktop' || item.source === 'phone' ? ` · ${t(lang, `chat.from.${item.source}`)}` : ''}</Txt>
            <Txt role="bubble" content="user" selectable>
              {searchSegments(item.text, asked).map((s, i) => s.hit
                ? <Txt key={i} role="bubble" content="user" style={{ backgroundColor: c.hair }}>{s.text}</Txt>
                : s.text)}{item.truncated ? '…' : ''}
            </Txt>
            <LinkRow testID={`chat-search-locate-${item.id}`} label={lang === 'zh-Hans' ? '回到这句' : 'Go to message'} onPress={() => router.dismissTo({ pathname: '/', params: { message: item.id, reference: '', locate: uuid() } })} />
          </View>
        )}
      />}
    </SafeAreaView>
  )
}
