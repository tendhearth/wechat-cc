import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NativeSessionPageT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'

type Msg = NativeSessionPageT['messages'][number]

// 读一个电脑上的会话(只读,没有「继续」)。首页进来就拉,「继续读取」按 nextCursor 追加。
export default function SessionReader() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { key: raw } = useLocalSearchParams<{ key: string }>()
  const key = decodeURIComponent(String(raw ?? ''))
  const [title, setTitle] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'slow'>('loading')
  const [moreFailed, setMoreFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const req = useRef(0) // 每次换 key / 发新请求 +1;返回时对不上就丢弃,换 key 后新的加载不会被旧的锁挡掉
  const busyRef = useRef(false)

  const load = async (cursor?: string) => {
    if (cursor && busyRef.current) return
    const my = ++req.current
    if (cursor) { busyRef.current = true; setBusy(true) }
    try {
      const p = await backend.session(key, cursor)
      if (my !== req.current) return
      setTitle(p.session.title)
      setMsgs(m => (cursor ? [...m, ...p.messages] : p.messages))
      setNext(p.nextCursor)
      setState('ok'); setMoreFailed(false)
    } catch (e) {
      if (my !== req.current) return
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
      if (cursor) setMoreFailed(true)
      else setState(code === 'not_found' ? 'missing' : 'slow')
    } finally { if (cursor && my === req.current) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => {
    busyRef.current = false; setBusy(false)
    setTitle(''); setMsgs([]); setNext(null); setMoreFailed(false); setState('loading')
    void load()
    return () => { req.current++ }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={title || t(lang, 'sessions.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/sessions'))} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.m }}>
        <Text testID="session-readonly" style={{ color: c.muted, fontSize: 13, lineHeight: 19 }}>{t(lang, 'sessions.readOnly')}</Text>
        {state === 'loading' ? <Text style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'sessions.loading')}</Text> : null}
        {state === 'missing' ? <Text testID="sessions-unsupported" style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'sessions.unsupported')}</Text> : null}
        {state === 'slow' ? (
          <View style={{ gap: space.m }}>
            <Text testID="sessions-slow" style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'sessions.slow')}</Text>
            <Button kind="secondary" testID="session-retry" label={t(lang, 'common.retry')} onPress={() => void load()} />
          </View>
        ) : null}
        {msgs.map((m, i) => {
          const mine = m.role === 'user'
          return (
            <View
              key={`${m.id}:${i}`}
              testID={`session-message-${i}`}
              style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: mine ? c.accentSoft : c.card, borderColor: c.line, borderWidth: 1, borderRadius: radius.card, padding: space.m, gap: space.xs }}
            >
              <Text selectable style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{m.text}</Text>
              {m.truncated ? <Text style={{ color: c.muted, fontSize: 12 }}>{t(lang, 'chat.truncated')}</Text> : null}
            </View>
          )
        })}
        {state === 'ok' && next ? (
          <View style={{ gap: space.s }}>
            {moreFailed ? <Text testID="sessions-slow" style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'sessions.slow')}</Text> : null}
            <Button kind="secondary" testID="session-more" label={t(lang, 'sessions.readMore')} busy={busy} onPress={() => void load(next)} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}
