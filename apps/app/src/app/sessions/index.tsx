import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NativeSessionRowT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Dot } from '../../ui/Dot'
import { TextField } from '../../ui/TextField'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { mergeSessionPages, sessionRows, sessionSearch } from '../../view/sessions'
import { canSubmit } from '../../view/connection'

type Provider = 'claude' | 'codex'

// 电脑上的 Claude Code / Codex 会话(只读)。第一页走缓存查询;「继续查找」的后续页本地追加。
export default function Sessions() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const [provider, setProvider] = useState<Provider>('claude')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [invalidSearch, setInvalidSearch] = useState(false)
  const queryKey = JSON.stringify([provider, query])
  // 追加页只对「第一页的那一次加载」有效:第一页重新拉过(syncedAt 变了)或换了标签 ⇒ 追加页作废,避免重复 / 漏行。
  const [extra, setExtra] = useState<{ key: string; base: number | undefined; items: NativeSessionRowT[]; next: string | null; failed: boolean } | null>(null)
  const [loadingFor, setLoadingFor] = useState<{ key: string; generation: number; token: number } | null>(null)
  const q = useQuery(`sessions:${queryKey}`, () => backend.sessions(provider, undefined, query), { refreshOnMount: true })
  const { refresh } = q
  useFocusEffect(useCallback(() => { void refresh() }, [refresh]))
  const cur = useRef({ key: queryKey, base: q.syncedAt, backend, loading: q.loading, generation: 0 })
  if (cur.current.key !== queryKey || cur.current.base !== q.syncedAt || cur.current.backend !== backend || cur.current.loading !== q.loading) {
    cur.current = { key: queryKey, base: q.syncedAt, backend, loading: q.loading, generation: cur.current.generation + 1 }
  }
  const moreRequest = useRef(0)
  const activeMore = useRef<typeof loadingFor>(null)
  const more = extra && extra.key === queryKey && extra.base === q.syncedAt ? extra : null
  const items = mergeSessionPages(q.data?.items ?? [], more?.items ?? [])
  const next = more ? more.next : q.data?.nextCursor ?? null
  const rows = sessionRows(items, Date.now(), lang)
  const loadingMore = loadingFor?.key === queryKey && loadingFor.generation === cur.current.generation
  const currentReport = canSubmit(conn) && q.fresh && !q.loading && !q.error
  const activeText = t(lang, currentReport ? 'sessions.activeObserved' : 'sessions.activeCached')
  const applySearch = () => {
    const value = sessionSearch(search)
    setInvalidSearch(value === null)
    if (value === null) return
    if (value === query) void refresh()
    else setQuery(value)
  }

  const loadMore = async () => {
    if (!next || loadingMore || activeMore.current?.generation === cur.current.generation || q.loading || !canSubmit(conn)) return
    const reqProvider = provider, reqQuery = query, reqKey = queryKey, reqBase = q.syncedAt, prior = more?.items ?? [], reqBackend = backend, generation = cur.current.generation
    const operation = { key: reqKey, generation, token: ++moreRequest.current }
    activeMore.current = operation; setLoadingFor(operation)
    try {
      const r = await backend.sessions(reqProvider, next, reqQuery)
      if (cur.current.generation !== generation || cur.current.backend !== reqBackend) return
      setExtra({ key: reqKey, base: reqBase, items: [...prior, ...r.items], next: r.nextCursor, failed: false })
    } catch {
      if (cur.current.generation === generation && cur.current.backend === reqBackend) setExtra({ key: reqKey, base: reqBase, items: prior, next, failed: true })
    } finally {
      if (activeMore.current?.token === operation.token) activeMore.current = null
      setLoadingFor(p => (p?.token === operation.token ? null : p))
    }
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
        style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: on ? c.ink : c.hair }}
      >
        <Txt role="bubble" tone={on ? 'ink' : 'inkSoft'}>{t(lang, `sessions.${p}`)}</Txt>
      </Pressable>
    )
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'sessions.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <View style={{ paddingHorizontal: space.xl, paddingVertical: space.m, gap: space.s }}>
        <TextField testID="sessions-search-input" value={search} onChangeText={setSearch} maxLength={200} accessibilityLabel={t(lang, 'sessions.searchPlaceholder')} placeholder={t(lang, 'sessions.searchPlaceholder')} returnKeyType="search" onSubmitEditing={applySearch} />
        <Button kind="secondary" testID="sessions-search" label={t(lang, 'sessions.search')} onPress={applySearch} />
        {invalidSearch ? <Txt testID="sessions-search-error" role="meta" tone="inkSoft">{t(lang, 'sessions.searchLimit')}</Txt> : null}
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', paddingHorizontal: space.xl, paddingBottom: space.s }}>{(['claude', 'codex'] as const).map(tab)}</View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl }}>
        {q.data && !currentReport ? <View style={{ paddingVertical: space.s, gap: space.s }}>
          <Txt testID="sessions-cached" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'sessions.cached')}</Txt>
          {q.error ? <Button kind="secondary" testID="sessions-refresh" label={t(lang, 'sessions.refresh')} onPress={() => void refresh()} disabled={!canSubmit(conn)} busy={q.loading} /> : null}
        </View> : null}
        {!q.data && q.error === 'not_found' ? (
          <Txt testID="sessions-unsupported" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, 'sessions.unsupported')}</Txt>
        ) : !q.data && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <Txt testID="sessions-slow" role="bubble" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt>
            <Button kind="secondary" testID="sessions-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !q.data ? (
          <Txt role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, 'sessions.loading')}</Txt>
        ) : rows.length === 0 ? (
          <Txt testID="sessions-empty" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, query ? 'sessions.searchEmpty' : 'sessions.empty')}</Txt>
        ) : (
          rows.map(r => (
            <Pressable
              key={r.key}
              testID={`sessions-row-${r.key}`}
              accessibilityRole="button"
              accessibilityLabel={`${r.title}, ${r.meta}${r.active ? `, ${activeText}` : ''}`}
              onPress={() => router.push(`/sessions/${encodeURIComponent(r.key)}`)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Txt role="body" content="user" numberOfLines={2}>{r.title}</Txt>
                <Txt role="small" tone="inkSoft" numberOfLines={1}>{r.meta}</Txt>
                {r.active ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
                    <Dot kind={currentReport ? 'ok' : 'unknown'} size={8} />
                    <Txt role="caption" tone="inkSoft">{activeText}</Txt>
                  </View>
                ) : null}
              </View>
              <Txt role="title" tone="inkSoft">›</Txt>
            </Pressable>
          ))
        )}
        {q.data && next ? (
          <View style={{ paddingTop: space.l, gap: space.s }}>
            {more?.failed ? <Txt testID="sessions-slow" role="meta" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt> : null}
            <Button kind="secondary" testID="sessions-more" label={t(lang, 'sessions.more')} busy={loadingMore} disabled={q.loading || !canSubmit(conn)} onPress={() => void loadMore()} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}
