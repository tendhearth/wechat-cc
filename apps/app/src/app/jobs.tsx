import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { JobsAction } from '../backend/types'
import { t, type MessageKey } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { Button } from '../ui/Button'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Icon } from '../ui/Icon'
import { BusyIndicator } from '../ui/motion'
import { StatusHint } from '../ui/StatusHint'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { canSubmit } from '../view/connection'
import { jobsActionNote, jobsPage, jobsTap } from '../view/jobs'

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
  const [open, setOpen] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // 同一帧连点两下:state 还没更新,靠 ref 挡住第二下(定时页评审 10-20)
  const inFlight = useRef(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { if (!armed) return; const tm = setTimeout(() => setArmed(null), 3000); return () => clearTimeout(tm) }, [armed])
  const page = q.data ? jobsPage(q.data, lang) : null

  const act = async (id: string, action: JobsAction) => {
    if (inFlight.current || busy || !online) return
    if (jobsTap(armed, id, action) === 'arm') { setArmed(id); setNote(null); return }
    inFlight.current = true
    setArmed(null); setBusy(id); setNote(null)
    try {
      const r = await submit(`jobs:${id}`, () => backend.jobsAction(id, action))
      const key = jobsActionNote(r)
      if (key) setNote(t(lang, key))
      await q.refresh().catch(() => {})   // 失败会落在 q.error ⇒ 下面那句「可能不是最新的」
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  const pill = (testID: string, key: MessageKey, onPress: () => void, off: boolean) => (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: off }} disabled={off} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m, opacity: off ? 0.55 : pressed ? 0.7 : 1 })}>
      <Txt role="meta">{t(lang, key)}</Txt>
    </Pressable>
  )

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={st(lang, 'jobs')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!page && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <StatusHint testID="jobs-unavailable" icon="alert" label={t(lang, 'jobs.unavailable')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'jobs.unavailable')} />
            <Button kind="secondary" testID="jobs-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !page ? (
          <View style={{ paddingVertical: space.l }}><BusyIndicator testID="jobs-loading" label={t(lang, 'progress.loading')} /></View>
        ) : (
          <>
            {page.notice ? <Txt testID="jobs-no-executor" role="bubble" tone="inkSoft" style={{ paddingTop: space.l }}>{page.notice}</Txt> : null}
            {page.empty ? <Txt testID="jobs-empty" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{page.empty}</Txt> : (
              <View style={{ gap: space.s }}>
                {page.rows.map(r => {
                  const off = !online || busy !== null
                  return (
                    <View key={r.id} testID={`jobs-row-${r.id}`} style={{ paddingVertical: space.m, gap: space.xs }}>
                      <Pressable testID={`jobs-details-${r.id}`} accessibilityRole="button" accessibilityLabel={`${r.body}, ${r.title}`} accessibilityState={{ expanded: open === r.id }}
                        onPress={() => { setOpen(open === r.id ? null : r.id); setArmed(null) }} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space.m }}>
                        <Icon name="calendar" color={c.inkSoft} />
                        <View style={{ flex: 1, gap: space.xs }}>
                          <Txt role="body" content="user">{r.body}</Txt>
                          <Txt role="meta" tone="inkSoft">{r.title}</Txt>
                        </View>
                        <Icon name={open === r.id ? 'chevronDown' : 'chevronRight'} size={16} color={c.inkSoft} />
                      </Pressable>
                      <Txt testID={`jobs-last-${r.id}`} role="meta" tone="inkSoft">{r.paused ? `${r.paused} · ${r.last}` : r.last}</Txt>
                      {open === r.id ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.xs }}>
                        {pill(`jobs-${r.toggle}-${r.id}`, r.toggle === 'pause' ? 'jobs.pause' : 'jobs.resume', () => void act(r.id, r.toggle), off)}
                        {pill(`jobs-remove-${r.id}`, armed === r.id ? 'jobs.removeConfirm' : 'jobs.remove', () => void act(r.id, 'remove'), off)}
                      </View> : null}
                    </View>
                  )
                })}
              </View>
            )}
            {note ? <Txt testID="jobs-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
            {/* 手上有列表、但最近一次重拉失败了 ⇒ 别让人以为这就是现在的样子 */}
            {q.error ? <Txt testID="jobs-stale" role="meta" tone="inkSoft">{t(lang, 'jobs.stale')}</Txt> : null}
            {page.hint ? <Txt role="meta" tone="inkSoft">{page.hint}</Txt> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
