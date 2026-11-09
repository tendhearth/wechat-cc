import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useTopics } from '../state/useTopics'
import { LinkRow } from './Rows'
import { Txt } from './Txt'
import { componentAppearance, space } from './tokens'
import { useTheme } from './useTheme'
import { Dot } from './Dot'
import { topicActivityLabel } from '../view/topic-bubble'

export function TopicRow({ onTopics }: { onTopics?: (ids: string[] | undefined) => void }) {
  const { c } = useTheme()
  const appearance = componentAppearance.topic
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useFocusEffect(useCallback(() => { setSelectedId(null) }, []))
  const shape = { minHeight: appearance.minHeight.phone, minWidth: appearance.minHeight.phone, paddingHorizontal: appearance.paddingX, paddingVertical: appearance.paddingY, borderWidth: appearance.borderWidth, borderRadius: appearance.radius, backgroundColor: appearance.background, justifyContent: 'center' as const }
  const topics = useTopics()
  const router = useRouter()
  const lang = useLang(), zh = lang === 'zh-Hans'
  useEffect(() => { onTopics?.(topics.online && !topics.error && topics.data ? topics.data.topics.slice(0, 6).map(topic => topic.id) : undefined) }, [topics.online, topics.error, topics.data, onTopics])
  if (!topics.supported) return null
  if (!topics.data?.topics.length && !topics.error) return null
  return <View testID="topic-row">
    {topics.error || !topics.online ? <Txt role="caption" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    {topics.error && !topics.data ? <LinkRow testID="topics-retry" label={zh ? '暂时读不到，重试' : 'Cannot read right now. Retry'} onPress={() => void topics.refresh()} /> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center' }}><ScrollView horizontal style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.s }}>
      {topics.data?.topics.slice(0, 6).map(topic => <Pressable key={topic.id} testID={`topic-${topic.id}`} accessibilityRole="button" accessibilityLabel={topicActivityLabel(topic,zh)} accessibilityState={{ selected: selectedId === topic.id }} onPress={() => { setSelectedId(topic.id); router.push(`/topic?id=${encodeURIComponent(topic.id)}&open=1`) }} style={({ pressed }) => ({ ...shape, borderColor: c[selectedId === topic.id ? appearance.selectedBorder : appearance.border], opacity: pressed ? appearance.pressedOpacity : 1 })}><View style={{flexDirection:'row',alignItems:'center',gap:appearance.activity.gap}}><Txt role={appearance.role} content="user">{topic.title}</Txt>{topic.activity && (topic.activity.waiting || topic.activity.running || topic.activity.unread) ? <View testID={`topic-activity-${topic.id}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{flexDirection:'row',alignItems:'center',gap:appearance.activity.gap}}>{topic.activity.waiting || topic.activity.running ? <Dot kind={topic.activity.waiting?appearance.activity.attention:appearance.activity.passive} size={appearance.activity.dotSize} /> : <View style={{width:appearance.activity.lineWidth,height:appearance.activity.lineHeight,backgroundColor:c[appearance.activity.passive]}} />}<Txt role="caption" tone={topic.activity.waiting?appearance.activity.attention:appearance.activity.passive}>{topic.activity.waiting || topic.activity.running || topic.activity.unread}</Txt></View> : null}</View></Pressable>)}
    </ScrollView>{topics.data?.topics.length ? <Pressable testID="topics-more" accessibilityRole="button" accessibilityLabel={zh ? '更多话题' : 'More topics'} onPress={() => router.push('/topics')} style={({ pressed }) => ({ ...shape, borderColor: c[appearance.border], opacity: pressed ? appearance.pressedOpacity : 1 })}><Txt role={appearance.role}>{zh ? '更多' : 'More'}</Txt></Pressable> : null}</View>
  </View>
}
