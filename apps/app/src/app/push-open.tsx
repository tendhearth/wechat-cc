import { useEffect, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { hrefFor, resolvePushRoute } from '../push/route'
import { targetFromParams } from '../push/target'
import { useBackendCtx } from '../state/BackendProvider'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'

// 点通知 / 深链进来的中转页(spec §7「点通知」、§3「旧通知」)。系统深链已被 +native-intent 洗过一遍,这里再按不可信输入清一次。
// 先按 taskId 拉一次最新详情;事情已经不在 ⇒ 留在这里说一句 + 回到此刻;没有 taskId ⇒ 直接回此刻,不发请求。
// 否则先退回栈里已有的「此刻」(dismissTo:冷启动栈里没有它时等同 replace;不能用 replace,那会每点一次就多叠一层 (tabs))
// 再推批准页 / 进展页(返回键回到此刻),那两页打开时还会再拉新(已处理的批准显示「已处理」)。
// 这一页从不提交任何东西。
export default function PushOpen() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const { backend } = useBackendCtx()
  const { seenWelcome } = useSession()
  const [gone, setGone] = useState(false)
  const key = JSON.stringify(params)

  useEffect(() => {
    if (!seenWelcome) { router.replace('/welcome'); return }
    let alive = true
    setGone(false)
    const target = targetFromParams(JSON.parse(key) as Record<string, string | string[]>)
    void resolvePushRoute(target, id => backend.matter(id, lang)).then(r => {
      if (!alive) return
      if (r.kind === 'gone') { setGone(true); return }
      router.dismissTo('/')
      const href = hrefFor(r)
      if (href !== '/') router.push(href)
    })
    return () => { alive = false }
    // 语言变了不重新路由
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backend, seenWelcome, router])

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1, padding: space.xl, gap: space.l, justifyContent: 'center' }}>
        {gone ? (
          <>
            <Text testID="push-gone" accessibilityLiveRegion="polite" style={{ color: c.ink, fontSize: 18, lineHeight: 26 }}>{t(lang, 'push.gone')}</Text>
            <Button kind="primary" testID="push-go-now" label={t(lang, 'push.goNow')} onPress={() => router.dismissTo('/')} />
          </>
        ) : (
          <Text testID="push-opening" style={{ color: c.muted, fontSize: 16 }}>{t(lang, 'push.opening')}</Text>
        )}
      </View>
    </SafeAreaView>
  )
}
