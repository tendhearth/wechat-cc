import { WelcomeGate } from '../ui/WelcomeGate'
import { BusyIndicator } from '../ui/motion'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { TopicsListT } from '../backend/types'
import { useBackendCtx } from '../state/BackendProvider'
import { useTopics } from '../state/useTopics'
import { useLang } from '../i18n/useLang'
import { TextField } from '../ui/TextField'
import { TopBar } from '../ui/TopBar'
import { LinkRow } from '../ui/Rows'
import { Button } from '../ui/Button'
import { Txt } from '../ui/Txt'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'
export default function Topics() { return <WelcomeGate><TopicsList /></WelcomeGate> }

export function TopicsList() {
  const lang = useLang(), zh = lang === 'zh-Hans', router = useRouter(), { c } = useTheme()
  const [cursor, setCursor] = useState<string>(), [q, setQ] = useState('')
  const page = useTopics({ view: 'all', cursor })
  const { backend } = useBackendCtx()
  const [loaded, setLoaded] = useState<{ backend: typeof backend; revision: string; rows: TopicsListT['topics'] }>({ backend, revision: '', rows: [] })
  const rows = loaded.backend === backend ? loaded.rows : []
  useEffect(() => {
    const next = page.data
    if (!next) return
    setLoaded(old => {
      if (cursor && (old.backend !== backend || old.revision !== next.revision)) { setCursor(undefined); return { backend, revision: next.revision, rows: [] } }
      return { backend, revision: next.revision, rows: cursor ? [...new Map([...old.rows, ...next.topics].map(t => [t.id, t])).values()] : next.topics }
    })
  }, [backend, page.data, cursor])
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
    <TopBar title={zh ? '更多话题' : 'More topics'} onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.m }}>
      <TextField testID="topics-search" value={q} onChangeText={setQ} placeholder={zh ? '搜索话题' : 'Search topics'} accessibilityLabel={zh ? '搜索话题' : 'Search topics'} />
      {!rows.length && page.loading ? <BusyIndicator testID="topics-loading" label={zh ? '正在读取' : 'Loading'} /> : null}
      {page.error || !page.online ? <Button testID="topics-retry" kind="secondary" label={zh ? '暂时读不到，重试' : 'Cannot read right now. Retry'} onPress={() => void page.refresh()} /> : null}
      {page.supported ? rows.filter(t => t.title.toLocaleLowerCase().includes(q.toLocaleLowerCase())).map(t => <LinkRow key={t.id} testID={`topic-${t.id}`} label={t.title} detail={t.summary || undefined} onPress={() => router.push(`/topic?id=${encodeURIComponent(t.id)}&open=1`)} />) : <Txt>{zh ? '这台电脑暂不支持话题' : 'Topics are not available on this computer'}</Txt>}
      {page.data?.nextCursor ? <Button testID="topics-next" kind="secondary" label={zh ? '更多话题' : 'More topics'} onPress={() => setCursor(page.data!.nextCursor!)} /> : null}
    </ScrollView>
  </SafeAreaView>
}
