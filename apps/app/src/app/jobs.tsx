import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { JobsAction } from '../backend/types'
import { t, type MessageKey } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { Button } from '../ui/Button'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { canSubmit } from '../view/connection'
import { jobsPage } from '../view/jobs'

// 「定时」(2026-10-20,对标 B7):电脑上的定时,每条能停 / 开 / 删;新建仍在微信「定时」里说。从设置进来,不占标签页。
// 删点两下(3 秒内,同进展页的「停下」),只在在线时能点;做完重新拉一次列表。
export default function Jobs() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const online = canSubmit(useConnection())
  const submit = useSubmit()
  const q = useQuery('jobs', () => backend.jobs(), { refreshOnMount: true })
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { if (!armed) return; const tm = setTimeout(() => setArmed(null), 3000); return () => clearTimeout(tm) }, [armed])
  const page = q.data ? jobsPage(q.data, lang) : null

  const act = async (id: string, action: JobsAction) => {
    if (busy || !online) return
    if (action === 'remove' && armed !== id) { setArmed(id); setNote(null); return }
    setArmed(null); setBusy(id); setNote(null)
    const r = await submit(`jobs:${id}`, () => backend.jobsAction(id, action))
    setBusy(null)
    if (r !== 'ok' && r !== 'busy') setNote(t(lang, r.error === 'not_found' ? 'jobs.gone' : 'jobs.failed'))
    void q.refresh()
  }
  const pill = (testID: string, key: MessageKey, onPress: () => void, off: boolean) => (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: off }} disabled={off} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, opacity: off ? 0.55 : pressed ? 0.7 : 1 })}>
      <Txt role="meta">{t(lang, key)}</Txt>
    </Pressable>
  )

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'jobs.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!page && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <Txt testID="jobs-unavailable" role="bubble" tone="inkSoft">{t(lang, 'jobs.unavailable')}</Txt>
            <Button kind="secondary" testID="jobs-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !page ? (
          <Txt role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, 'progress.loading')}</Txt>
        ) : (
          <>
            {page.notice ? <Txt testID="jobs-no-executor" role="bubble" tone="inkSoft" style={{ paddingTop: space.l }}>{page.notice}</Txt> : null}
            {page.empty ? <Txt testID="jobs-empty" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{page.empty}</Txt> : (
              <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
                {page.rows.map(r => {
                  const off = !online || busy !== null
                  return (
                    <View key={r.id} testID={`jobs-row-${r.id}`} style={{ paddingVertical: space.m, gap: space.xs, borderBottomWidth: 1, borderBottomColor: c.hair }}>
                      <Txt role="item" accessibilityRole="header">{r.title}</Txt>
                      <Txt role="bubble" content="user" numberOfLines={3}>{r.body}</Txt>
                      <Txt testID={`jobs-last-${r.id}`} role="meta" tone="inkSoft">{r.paused ? `${r.paused} · ${r.last}` : r.last}</Txt>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.xs }}>
                        {pill(`jobs-${r.toggle}-${r.id}`, r.toggle === 'pause' ? 'jobs.pause' : 'jobs.resume', () => void act(r.id, r.toggle), off)}
                        {pill(`jobs-remove-${r.id}`, armed === r.id ? 'jobs.removeConfirm' : 'jobs.remove', () => void act(r.id, 'remove'), off)}
                      </View>
                    </View>
                  )
                })}
              </View>
            )}
            {note ? <Txt testID="jobs-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
            {page.hint ? <Txt role="meta" tone="inkSoft">{page.hint}</Txt> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
