import { useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useTopics } from '../state/useTopics'
import { LinkRow } from './Rows'
import { Txt } from './Txt'
import { space } from './tokens'

export function TopicRow() {
  const topics = useTopics()
  const router = useRouter()
  const lang = useLang(), zh = lang === 'zh-Hans'
  if (!topics.supported) return null
  if (!topics.data?.topics.length && !topics.error) return null
  return <View testID="topic-row">
    {topics.error || !topics.online ? <Txt role="caption" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    {topics.error && !topics.data ? <LinkRow testID="topics-retry" label={zh ? '暂时读不到，重试' : 'Cannot read right now. Retry'} onPress={() => void topics.refresh()} /> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center' }}><ScrollView horizontal style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.s }}>
      {topics.data?.topics.slice(0, 6).map(topic => <Pressable key={topic.id} testID={`topic-${topic.id}`} accessibilityRole="button" accessibilityLabel={`${topic.title}, ${topic.bubbleState === 'open' ? (zh ? '已想起' : 'Recalled') : (zh ? '已收起' : 'Folded')}`} onPress={() => router.push(`/topic?id=${encodeURIComponent(topic.id)}&open=1`)} style={{ minHeight: 44, paddingHorizontal: space.s, justifyContent: 'center' }}><Txt role="meta" content="user">{topic.title}</Txt></Pressable>)}
    </ScrollView>{topics.data?.topics.length ? <Pressable testID="topics-more" accessibilityRole="button" accessibilityLabel={zh ? '更多话题' : 'More topics'} onPress={() => router.push('/topics')} style={{ minHeight: 44, paddingHorizontal: space.s, justifyContent: 'center' }}><Txt role="meta">{zh ? '更多' : 'More'}</Txt></Pressable> : null}</View>
  </View>
}
