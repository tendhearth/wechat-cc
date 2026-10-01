import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NativeSessionRowT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { mergeSessionPages, sessionRows } from '../../view/sessions'

type Provider = 'claude' | 'codex'

// 电脑上的 Claude Code / Codex 会话(只读)。第一页走缓存查询;「继续查找」的后续页本地追加。
export default function Sessions() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const [provider, setProvider] = useState<Provider>('claude')
  // 追加页只对「第一页的那一次加载」有效:第一页重新拉过(syncedAt 变了)或换了标签 ⇒ 追加页作废,避免重复 / 漏行。
  const [extra, setExtra] = useState<{ provider: Provider; base: number | undefined; items: NativeSessionRowT[]; next: string | null; failed: boolean } | null>(null)
  const [loadingFor, setLoadingFor] = useState<Provider | null>(null)
  const q = useQuery(`sessions:${provider}`, () => backend.sessions(provider), { refreshOnMount: true })
  const cur = useRef({ provider, base: q.syncedAt })
  cur.current = { provider, base: q.syncedAt }
  const more = extra && extra.provider === provider && extra.base === q.syncedAt ? extra : null
  const items = mergeSessionPages(q.data?.items ?? [], more?.items ?? [])
  const next = more ? more.next : q.data?.nextCursor ?? null
  const rows = sessionRows(items, Date.now(), lang)
  const loadingMore = loadingFor === provider

  const loadMore = async () => {
    if (!next || loadingMore) return
    const reqProvider = provider, reqBase = q.syncedAt, prior = more?.items ?? []
    setLoadingFor(reqProvider)
    try {
      const r = await backend.sessions(reqProvider, next)
      if (cur.current.provider !== reqProvider || cur.current.base !== reqBase) return // 期间换了标签 / 第一页刷新过 ⇒ 丢弃
      setExtra({ provider: reqProvider, base: reqBase, items: [...prior, ...r.items], next: r.nextCursor, failed: false })
    } catch {
      if (cur.current.provider === reqProvider && cur.current.base === reqBase) setExtra({ provider: reqProvider, base: reqBase, items: prior, next, failed: true })
    } finally { setLoadingFor(p => (p === reqProvider ? null : p)) }
  }

  const tab = (p: Provider) => {
    const on = provider === p
    return (
      <Pressable
        key={p}
        testID={`sessions-tab-${p}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        onPress={() => setProvider(p)}
        style={{ flex: 1, minHeight: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.navOnBg : 'transparent' }}
      >
        <Text style={{ color: on ? c.navOnInk : c.ink, fontSize: 15 }}>{t(lang, `sessions.${p}`)}</Text>
      </Pressable>
    )
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'sessions.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} connection={conn.state === 'online' ? 'online' : 'offline'} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space.s, paddingHorizontal: space.xl, paddingBottom: space.s }}>{(['claude', 'codex'] as const).map(tab)}</View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl }}>
        {!q.data && q.error === 'not_found' ? (
          <Text testID="sessions-unsupported" style={{ color: c.muted, fontSize: 15, paddingVertical: space.l }}>{t(lang, 'sessions.unsupported')}</Text>
        ) : !q.data && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <Text testID="sessions-slow" style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'sessions.slow')}</Text>
            <Button kind="secondary" testID="sessions-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !q.data ? (
          <Text style={{ color: c.muted, fontSize: 15, paddingVertical: space.l }}>{t(lang, 'sessions.loading')}</Text>
        ) : rows.length === 0 ? (
          <Text testID="sessions-empty" style={{ color: c.muted, fontSize: 15, paddingVertical: space.l }}>{t(lang, 'sessions.empty')}</Text>
        ) : (
          rows.map(r => (
            <Pressable
              key={r.key}
              testID={`sessions-row-${r.key}`}
              accessibilityRole="button"
              accessibilityLabel={`${r.title}, ${r.meta}${r.active ? `, ${t(lang, 'sessions.active')}` : ''}`}
              onPress={() => router.push(`/sessions/${encodeURIComponent(r.key)}`)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: c.line, opacity: pressed ? 0.7 : 1 })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={2} style={{ color: c.ink, fontSize: 16 }}>{r.title}</Text>
                <Text numberOfLines={1} style={{ color: c.muted, fontSize: 13 }}>{r.meta}</Text>
                {r.active ? <Text style={{ color: c.warn, fontSize: 12 }}>{t(lang, 'sessions.active')}</Text> : null}
              </View>
              <Text style={{ color: c.muted, fontSize: 22 }}>›</Text>
            </Pressable>
          ))
        )}
        {q.data && next ? (
          <View style={{ paddingTop: space.l, gap: space.s }}>
            {more?.failed ? <Text testID="sessions-slow" style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'sessions.slow')}</Text> : null}
            <Button kind="secondary" testID="sessions-more" label={t(lang, 'sessions.more')} busy={loadingMore} onPress={() => void loadMore()} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}
