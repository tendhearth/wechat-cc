import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { MatterDetailT } from '../backend/types'
import { useLang } from '../i18n/useLang'
import { ConnectionNotice } from './ConnectionNotice'
import { space } from './tokens'
import { TopBar } from './TopBar'
import { Txt } from './Txt'
import { useTheme } from './useTheme'
import { actTimeline, actTitle } from '../view/cc-acts'

/**
 * CC 自己做的那一件(kind='act',M5c):/matter/<id> 按 kind 画这个。一轮一段(新的在前):那一句 + 时间,下面是这一轮的几步。
 * 只读,没有按钮 —— 信、早报、记忆整理的正文各在自己的页里;这里只说 CC 做了什么、送到没有。
 */
export function ActDetail({ detail }: { detail: MatterDetailT }) {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const v = actTimeline(detail, Date.now(), lang)
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={actTitle(detail.matter, lang)} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {v.empty ? <Txt testID="act-empty" role="bubble" tone="inkSoft" style={{ paddingTop: space.xl }}>{v.empty}</Txt> : null}
        {v.turns.map((tr, i) => (
          <View key={tr.id} testID={`act-turn-${i}`} style={{ gap: space.xs, paddingTop: i === 0 ? space.l : 0 }}>
            <Txt role="item">{tr.line}</Txt>
            <Txt role="caption" tone="inkSoft">{tr.when}</Txt>
            {tr.steps.length ? <View style={{ gap: space.xs, paddingTop: space.xs, paddingLeft: space.m, borderLeftWidth: 1, borderLeftColor: c.hair }}>
              {tr.steps.map((s, j) => <Txt key={j} role="small" tone="inkSoft">{s}</Txt>)}
            </View> : null}
          </View>
        ))}
        {v.note ? <Txt testID="act-note" role="meta" tone="inkSoft">{v.note}</Txt> : null}
      </ScrollView>
    </SafeAreaView>
  )
}
