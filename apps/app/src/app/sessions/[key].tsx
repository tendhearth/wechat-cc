import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NativeSessionPageT, SessionContinueT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useSubmit } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Dot } from '../../ui/Dot'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { canSubmit } from '../../view/connection'
import { CONTINUE_RECHECK, continueBlock, continueConfirmLabel, continueErrorDot, continueErrorText, continueSheetLines } from '../../view/continue'

type Msg = NativeSessionPageT['messages'][number]
type Cont = SessionContinueT | 'loading' | 'failed'

// 读一个电脑上的会话 + 在手机上接着做(spec 2026-10-01-tendhearth-continue-sessions §4.4)。
// 消息:首页进来就拉,「继续读取」按 nextCursor 追加。底部:先问电脑能不能接(不缓存),问到之前什么都不画。
export default function SessionReader() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const { key: raw } = useLocalSearchParams<{ key: string }>()
  const key = decodeURIComponent(String(raw ?? ''))
  const [title, setTitle] = useState('')
  const [rowProvider, setRowProvider] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'slow'>('loading')
  const [moreFailed, setMoreFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const req = useRef(0) // 每次换 key / 发新请求 +1;返回时对不上就丢弃,换 key 后新的加载不会被旧的锁挡掉
  const busyRef = useRef(false)
  // 接着做:预览、确认卡、提交
  const [cont, setCont] = useState<Cont>('loading')
  const [sheet, setSheet] = useState(false)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<{ text: string; dot: 'bad' | 'warn' | 'unknown' } | null>(null)
  const contReq = useRef(0)
  const online = canSubmit(conn)

  const load = async (cursor?: string) => {
    if (cursor && busyRef.current) return
    const my = ++req.current
    if (cursor) { busyRef.current = true; setBusy(true) }
    try {
      const p = await backend.session(key, cursor)
      if (my !== req.current) return
      setTitle(p.session.title)
      setRowProvider(p.session.provider)
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
  /** 问电脑这条能不能接。重连(epoch 前进)、点开确认卡、状态类失败之后都重问。返回问到的(过期的 / 问不到 ⇒ null)。 */
  const check = async (): Promise<SessionContinueT | null> => {
    const my = ++contReq.current
    try {
      const p = await backend.continuePreview(key)
      if (my !== contReq.current) return null
      setCont(p); return p
    } catch { if (my === contReq.current) setCont('failed'); return null }
  }
  useEffect(() => {
    busyRef.current = false; setBusy(false)
    setTitle(''); setRowProvider(null); setMsgs([]); setNext(null); setMoreFailed(false); setState('loading')
    setCont('loading'); setSheet(false); setFailure(null)
    void load()
    return () => { req.current++ }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void check()
    return () => { contReq.current++ }
  }, [key, conn.epoch]) // eslint-disable-line react-hooks/exhaustive-deps

  // 执行者的名字只来自电脑(预览 / 会话行),从不假定是 Claude(裁决 R5);都还没有 ⇒ null,失败句说「这个执行者」。
  const provider = typeof cont === 'object' ? cont.provider : rowProvider
  // 会话本身读不了(missing)⇒ 底部不画:那一页已经说了读不了,不再另说「确认不了能不能接」
  const block = state === 'missing' ? { kind: 'none' as const } : continueBlock(cont, lang)

  /** 「接着做」与「打开这件事」都走同一个幂等 POST;daemon 回成功之前页面上不出现任何「在跑」。 */
  const adopt = async (then: (matterId: string) => void) => {
    if (sending) return
    setSending(true); setFailure(null)
    const box: { id: string | null } = { id: null }
    const r = await submit(`continue:${key}`, async () => { box.id = (await backend.continueSession(key)).matterId })
    setSending(false)
    if (r === 'ok' && box.id) { then(box.id); return }
    if (r === 'busy') return // 同一个请求还在路上(本机)
    const code = r === 'ok' ? 'unknown' : r.error
    if (code === 'session_managed') {
      // 不是错:别处(桌面 / 另一台手机)刚接过。重问预览,接过了就打开那件事(POST 幂等,走「打开」那一路)。
      const p = await check()
      if (p?.state === 'managed') { setSheet(false); void openExisting(); return }
    }
    setFailure({ text: continueErrorText(code, provider, lang), dot: continueErrorDot(code) })
    if (CONTINUE_RECHECK.has(code)) void check()
  }
  const confirm = () => adopt(id => {
    setSheet(false)
    // 成了一件事:读页换成这件事的进展页,再叠上说一句页(输入框已聚焦),返回就是这件事。
    router.replace(`/matter/${encodeURIComponent(id)}`)
    router.push(`/compose?matter=${encodeURIComponent(id)}&focus=1`)
  })
  const openExisting = (): Promise<void> => adopt(id => { setSheet(false); router.push(`/matter/${encodeURIComponent(id)}`) })
  const openSheet = () => { setFailure(null); setSheet(true); void check() }

  const failureRow = (testID: string) => failure ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind={failure.dot} size={8} />
      <Txt testID={testID} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{failure.text}</Txt>
    </View>
  ) : null

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={title || t(lang, 'sessions.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/sessions'))} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.m }}>
        {state === 'loading' ? <Txt role="bubble" tone="inkSoft">{t(lang, 'sessions.loading')}</Txt> : null}
        {state === 'missing' ? <Txt testID="sessions-unsupported" role="bubble" tone="inkSoft">{t(lang, 'sessions.unsupported')}</Txt> : null}
        {state === 'slow' ? (
          <View style={{ gap: space.m }}>
            <Txt testID="sessions-slow" role="bubble" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt>
            <Button kind="secondary" testID="session-retry" label={t(lang, 'common.retry')} onPress={() => void load()} />
          </View>
        ) : null}
        {msgs.map((m, i) => {
          const mine = m.role === 'user'
          return (
            <View
              key={`${m.id}:${i}`}
              testID={`session-message-${i}`}
              style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: c.paper, borderColor: c.hair, borderWidth: 1, paddingHorizontal: space.l, paddingVertical: space.m, gap: space.xs,
                borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble, borderBottomLeftRadius: mine ? radius.bubble : 4, borderBottomRightRadius: mine ? 4 : radius.bubble }}
            >
              <Txt selectable role="body" content="user">{m.text}</Txt>
              {m.truncated ? <Txt role="caption" tone="inkSoft">{t(lang, 'chat.truncated')}</Txt> : null}
            </View>
          )
        })}
        {state === 'ok' && next ? (
          <View style={{ gap: space.s }}>
            {moreFailed ? <Txt testID="sessions-slow" role="meta" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt> : null}
            <Button kind="secondary" testID="session-more" label={t(lang, 'sessions.readMore')} busy={busy} onPress={() => void load(next)} />
          </View>
        ) : null}
      </ScrollView>

      {block.kind === 'none' ? null : (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m, gap: space.s }}>
          {block.kind === 'continue' ? (
            <Button kind="primary" testID="session-continue" label={block.label} onPress={openSheet} disabled={!online} />
          ) : block.kind === 'open' ? (
            <Button kind="primary" testID="session-open" label={block.label} onPress={() => void openExisting()} disabled={!online} busy={sending} />
          ) : (
            <>
              <Txt testID="session-continue-note" role="meta" tone="inkSoft">{block.text}</Txt>
              {block.retry ? <Button kind="secondary" testID="session-continue-retry" label={t(lang, 'common.retry')} onPress={() => void check()} /> : null}
            </>
          )}
          {sheet || (block.kind === 'note' && failure?.text === block.text) ? null : failureRow('session-continue-error')}
        </View>
      )}

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setSheet(false)} />
        <View testID="continue-sheet" style={{ backgroundColor: c.paper, padding: space.xl, gap: space.m, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
          <Txt role="item" accessibilityRole="header">{t(lang, 'continue.title')}</Txt>
          {typeof cont === 'object' && cont.state === 'ready' ? (
            <>
              {continueSheetLines(cont, lang).map((line, i) => <Txt key={i} testID={`continue-line-${i}`} role="bubble">{line}</Txt>)}
              {failureRow('continue-error')}
              <Button kind="primary" testID="continue-confirm" label={continueConfirmLabel(cont, lang)} onPress={() => void confirm()} disabled={!online} busy={sending} />
            </>
          ) : block.kind === 'open' ? (
            // 点开时重问,发现别处刚接过:直接给「打开这件事」
            <>
              {failureRow('continue-error')}
              <Button kind="primary" testID="continue-open" label={block.label} onPress={() => void openExisting()} disabled={!online} busy={sending} />
            </>
          ) : block.kind === 'note' ? (
            // 点开时重问,电脑那边变了(开始跑了 / 额度用完了):只说为什么,收起主按钮
            <>
              <Txt testID="continue-sheet-note" role="bubble" tone="inkSoft">{block.text}</Txt>
              {failure?.text === block.text ? null : failureRow('continue-error')}
            </>
          ) : null}
          <Button kind="secondary" testID="continue-cancel" label={t(lang, 'common.cancel')} onPress={() => setSheet(false)} />
        </View>
      </Modal>
    </SafeAreaView>
  )
}
