import { WelcomeGate } from '../ui/WelcomeGate'
import { BusyIndicator } from '../ui/motion'
import { t } from '../i18n'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { TopicDetailT } from '../backend/types'
import { useBackendCtx } from '../state/BackendProvider'
import { isFresh } from '../state/store'
import { useConnection, useQuery } from '../state/hooks'
import { useTopicsRevision } from '../state/useTopics'
import { useLang } from '../i18n/useLang'
import { uuid } from '../net/uuid'
import { appendTopicPage, topicStatus } from '../view/topic-bubble'
import { rememberReference } from '../state/conversation-references'
import { TopBar } from '../ui/TopBar'
import { LinkRow } from '../ui/Rows'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Txt } from '../ui/Txt'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'

export default function Topic() { return <WelcomeGate><TopicBubble /></WelcomeGate> }

export function TopicBubble() {
  const { id = '', open } = useLocalSearchParams<{ id?: string; open?: string }>()
  const router = useRouter(), { c } = useTheme(), lang = useLang(), zh = lang === 'zh-Hans'
  const { backend, store } = useBackendCtx(), conn = useConnection()
  const enabled = conn.topics === 'v1' && conn.state === 'online'
  const query = useQuery(`topic:${id}`, () => backend.topicDetail({ id }), { enabled, refreshOnMount: true })
  useTopicsRevision(enabled, query.refresh)
  const [stored, setData] = useState<TopicDetailT>()
  const dataBackend = useRef(backend)
  const data = conn.topics === 'v1' && query.error !== 'not_found' && stored?.topic.id === id && dataBackend.current === backend ? stored : undefined
  useEffect(() => { const into=query.data?.topic.mergedInto; if(into && into!==id)router.replace({pathname:'/topic',params:{id:into,open:'1'}}) },[query.data?.topic.mergedInto,id,router])
  const folded = useRef(false)
  const [opened, setOpened] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0), lock = useRef(false)
  const request = useRef({ id, requestId: uuid() })
  useEffect(() => { generation.current++; dataBackend.current = backend; setData(query.error === 'not_found' ? undefined : query.data) }, [backend, query.data, query.error])
  useEffect(() => {
    if (!enabled || open !== '1') return
    let active = true
    // Same click retries with the same request id; reading and closing never writes closed.
    if (request.current.id !== id) request.current = { id, requestId: uuid() }
    folded.current = false
    setOpened(false)
    void (async () => {
      try {
        await backend.topicOpen(id, request.current.requestId)
        // An older read may still be in flight. Only a read issued after the click's
        // receipt can establish the open state we later fold after successful sleep.
        const since = store.clock(), current = store.query(`topic:${id}`, () => backend.topicDetail({ id }))
        await current.revalidate(since)
        const read = current.get()
        if (active && isFresh(read, since) && !read.error && read.data?.topic.bubbleState === 'open') setOpened(true)
      } catch { if (active) setNote(zh ? '尚未同步' : 'Not synced') }
    })()
    return () => { active = false }
  }, [backend, store, id, open, enabled, zh])
  const more = async (section: 'entries' | 'matters' | 'messages') => {
    const cursor = data?.pages[section].nextCursor
    if (!enabled || !cursor || lock.current) return
    lock.current = true; setBusy(true); setNote(null)
    const gen = generation.current
    try {
      const next = await backend.topicDetail({ id, section, cursor })
      if (gen !== generation.current) return
      if (next.revision !== data?.revision) { await query.refresh(); return }
      setData(old => old ? appendTopicPage(old, next, section) ?? old : next)
    } catch { setNote(zh ? '暂时读不到，重试' : 'Cannot read right now. Retry') }
    finally { lock.current = false; setBusy(false) }
  }
  const back = () => { folded.current = true; if (router.canGoBack()) router.back(); else router.replace('/') }
  useFocusEffect(useCallback(() => {
    // A background revision must not pop the matter the owner is reading above
    // this sheet. Fold only when this selection itself is focused again.
    if (opened && !folded.current && !query.error && data?.topic.bubbleState === 'closed') {
      folded.current = true
      if (router.canGoBack()) router.back(); else router.replace('/')
    }
  }, [opened, query.error, data?.topic.bubbleState, data?.revision, router]))
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
    <TopBar title={data?.topic.title ?? (zh ? '话题' : 'Topic')} onBack={back} />
    <ScrollView testID="topic-sheet" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
      {!data && query.loading ? <BusyIndicator testID="topic-loading" label={zh ? '正在读取' : 'Loading'} /> : null}
      {!enabled || query.error || note ? <Txt testID="topic-note" role="meta" tone="inkSoft">{query.error === 'not_found' ? (zh ? '这个话题已不可用' : 'This topic is unavailable') : note ?? (zh ? '尚未同步' : 'Not synced')}</Txt> : null}
      {query.error ? <Button testID="topic-retry" kind="secondary" label={zh ? '暂时读不到，重试' : 'Cannot read right now. Retry'} onPress={() => void query.refresh()} /> : null}
      {data && conn.topics === 'v1' ? <>
        {data.topic.description ? <Txt content="user">{data.topic.description}</Txt> : null}
        {data.topic.summary ? <Txt content="user">{data.topic.summary}</Txt> : null}
        {data.matters.length ? <View><Txt accessibilityRole="header">{zh ? '相关事项' : 'Related work'}</Txt>
          {data.matters.map(m => <LinkRow key={m.id} testID={`topic-matter-${m.id}`} label={m.title} detail={topicStatus(m.state) ? t(lang, `status.${topicStatus(m.state)!}`) : (zh ? '尚未同步' : 'Not synced')} onPress={() => { rememberReference(backend, m.id); router.push(`/matter/${encodeURIComponent(m.id)}`) }} />)}
        </View> : null}
        {data.entries.length ? <View><Txt accessibilityRole="header">{zh ? 'CC 记得' : 'CC remembers'}</Txt>
          {data.entries.map(e => <Sheet key={e.id} testID={`topic-entry-${e.id}`} title={`${e.line}${e.recalled ? (zh ? ' · 这次想起' : ' · Recalled this time') : ''}`}><Txt content="user">{e.body}</Txt><Txt role="caption" tone="inkSoft">{e.source} · {e.createdTs}</Txt></Sheet>)}
        </View> : null}
        {data.messages.length ? <View><Txt accessibilityRole="header">{zh ? '最近聊到' : 'Recently discussed'}</Txt>
          {data.messages.map(m => <LinkRow key={m.id} testID={`topic-message-${m.id}`} label={`${m.speaker === 'owner' ? (zh ? '你' : 'You') : 'CC'} · ${m.excerpt}`} detail={`${m.ts}${m.source === 'episode' ? (zh ? ' · 相关记录' : ' · Related record') : ''}`} onPress={() => { router.dismissTo({ pathname: '/', params: { message: m.id, reference: '', locate: uuid() } }) }} />)}
        </View> : null}
        {!data.entries.length && !data.matters.length && !data.messages.length ? <Txt>{zh ? '还没有记下内容' : 'Nothing recorded yet'}</Txt> : null}
        {(['matters', 'entries', 'messages'] as const).map(s => data.pages[s].nextCursor ? <Button key={s} testID={`topic-more-${s}`} kind="secondary" busy={busy} label={`${zh ? '更多' : 'More'} · ${s === 'matters' ? (zh ? '相关事项' : 'Work') : s === 'entries' ? (zh ? '记忆' : 'Memories') : (zh ? '对话' : 'Messages')} (${data.pages[s].total})`} onPress={() => void more(s)} /> : null)}
        <LinkRow testID="topic-memory" label={zh ? '更多 · 管理记忆' : 'More · Manage memory'} onPress={() => router.push('/memory')} />
      </> : null}
    </ScrollView>
  </SafeAreaView>
}
