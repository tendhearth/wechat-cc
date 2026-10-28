import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { pairingGen } from '../../state/drafts'
import { useTerminalActions, useTerminalActivity, useTerminalSessions } from '../../state/useTerminal'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { TerminalStatusPill } from '../../ui/TerminalItem'
import { TextField } from '../../ui/TextField'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { canSayTo, relAgo, stepLabel, terminalErrorKey, terminalRow } from '../../view/terminal'
import { nextSayView, sayNote, SAY_FAST_POLL_MS, type SayTrack, type SayView } from '../../view/terminal-say'

/** 手机上说一句最多这么长(同 daemon 的 PHONE_CLI_SAY_MAX)。 */
const SAY_MAX = 4000

// 一条终端会话(2026-10-14):最后一句、等批准的那一项(能拍就拍),和「接着说一句」。
// 说一句走的是微信「@码」同一条路:收下即回,跑完的结果成为这里的「最后一句」。在跑 / 在等批准时不能说。
// 看着它跑(2026-10-17):读得到过程就显示最近几步(最后一句就在里面),在跑时最后一步标「正在」;读不到退回最后一句。
// 送进窗口(2026-10-20):daemon 只回收下、后台送;拿 say_id 对会话行的 last_say 才说送到 / 没送进去,在送时 2 秒拉一次、最多一分钟。
export default function TerminalSession() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { id: raw } = useLocalSearchParams<{ id: string }>()
  const id = decodeURIComponent(String(raw ?? ''))
  const { store } = useBackendCtx()
  // A late result belongs to the session and backend that submitted it, even if navigation returns here.
  const view = useRef({ id, store })
  if (view.current.id !== id || view.current.store !== store) view.current = { id, store }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const actions = useTerminalActions()
  const activity = useTerminalActivity(id)
  const [text, setTextState] = useState('')
  const draftRevision = useRef(0)
  const setText = (value: string) => { draftRevision.current++; setTextState(value) }
  const [note, setNote] = useState<string | null>(null)
  // 刚说的那一句:发出时记下,之后随列表与时钟往前走(定下就不再改)
  const [track, setTrack] = useState<SayTrack | null>(null)
  const [said, setSaid] = useState<SayView | null>(null)
  const [tick, setTick] = useState(0)
  const sendingLive = said?.kind === 'sending'
  const terminal = useTerminalSessions(sendingLive ? { fastMs: SAY_FAST_POLL_MS } : {})
  // 点开的那几步(按「时间|这一步」记,4 秒刷新不收起)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const s = terminal.sessions.find(x => x.session_id === id)
  const row = s ? terminalRow(s, Date.now(), lang) : null
  // 登记处的时间只在 hook 事件时更新;一轮跑很久时过程里的时间更新 ⇒ 页头取较新的那个,也不算「有一阵没动静」。
  const newest = activity.items.reduce((m, i) => (i.at !== null && i.at > m ? i.at : m), s?.last_event_at ?? 0)
  const fresher = !!s && newest > s.last_event_at
  const sayOpen = !!row && canSayTo(row.status, row.live) && terminal.online
  const sending = actions.pending === `cli:say:${id}`
  const last = s?.last_say
  useEffect(() => {
    if (track) setSaid(v => nextSayView(v, track, last, Date.now()))
  }, [track, last?.id, last?.state, last?.error, tick])
  // 在送时自己也走钟:列表不变也要按时改说「还没确认」
  useEffect(() => {
    if (!sendingLive) return
    const h = setInterval(() => setTick(x => x + 1), SAY_FAST_POLL_MS)
    return () => clearInterval(h)
  }, [sendingLive])
  const deciding = actions.pending === `cli:decide:${id}`

  const shown = note ?? (said ? sayNote(said, lang) : null)

  const decide = async (d: 'allow' | 'deny') => {
    if (!s) return
    setNote(null); setTrack(null); setSaid(null)
    const err = await actions.decide(s, d)
    setNote(err === null ? t(lang, d === 'allow' ? 'terminal.decided' : 'terminal.denied') : err === 'busy' ? null : t(lang, terminalErrorKey(err)))
  }
  const send = async () => {
    const body = text.trim()
    if (!body || body.length > SAY_MAX || !sayOpen || sending) return
    const owner = view.current, atGen = pairingGen(), revision = draftRevision.current
    setNote(null); setTrack(null); setSaid(null)
    const prevId = s?.last_say?.id ?? null
    const live = !!row?.live
    const sentAt = Date.now()
    const { error: err, sayId } = await actions.say(id, body)
    if (!alive.current || view.current !== owner || pairingGen() !== atGen) return
    if (err === null) {
      if (draftRevision.current === revision) setText('')
      setTrack({ sayId, live, sentAt, prevId })
    } else if (err !== 'busy') setNote(t(lang, terminalErrorKey(err)))
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={row?.project ?? t(lang, 'terminal.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/together'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
          {!row ? (
            <Txt testID="terminal-missing" role="bubble" tone="inkSoft" style={{ paddingTop: space.xl }}>
              {terminal.loaded ? t(lang, 'terminal.gone') : t(lang, 'sessions.loading')}
            </Txt>
          ) : (
            <>
              <View style={{ gap: space.s }}>
                <TerminalStatusPill status={row.status} testID="terminal-detail-status" />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                  <Icon name="terminal" color={c.inkSoft} testID="terminal-detail-agent" />
                  <Txt role="small" tone="inkSoft" style={{ flex: 1 }}>{`${row.source} · ${row.stale && !fresher ? t(lang, 'terminal.stale.hint') : fresher ? relAgo(newest, Date.now(), lang) : row.ago}`}</Txt>
                </View>
              </View>
              {row.pendingText ? (
                <View style={{ gap: space.m }}>
                  <Txt testID="terminal-detail-pending" role="body" content="user">{row.pendingText}</Txt>
                  {row.actionable ? (
                    // 用词表:先不做在左(次要),允许这一步在右(主按钮),下面一行「只对这一次请求」
                    <View style={{ gap: space.s }}>
                      <View style={{ flexDirection: 'row', gap: space.m }}>
                        <View style={{ flex: 1 }}><Button kind="secondary" testID="terminal-detail-deny" label={t(lang, 'terminal.deny')} disabled={!terminal.online || deciding} onPress={() => void decide('deny')} /></View>
                        <View style={{ flex: 1 }}><Button kind="primary" testID="terminal-detail-allow" label={t(lang, 'terminal.allow')} busy={deciding} disabled={!terminal.online} onPress={() => void decide('allow')} /></View>
                      </View>
                      <Txt role="small" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'approval.onlyThisRequest')}</Txt>
                    </View>
                  ) : <Txt testID="terminal-detail-local" role="meta" tone="inkSoft">{t(lang, 'terminal.askedLocally')}</Txt>}
                </View>
              ) : null}
              {activity.items.length > 0 ? (
                <View testID="terminal-activity" style={{ gap: space.m }}>
                  <Txt role="meta" tone="inkSoft" accessibilityRole="header">{t(lang, 'terminal.activity')}</Txt>
                  <View style={{ gap: space.l }}>
                    {activity.items.map((it, i) => {
                      const now = row.status === 'running' && (!row.stale || fresher) && i === activity.items.length - 1 && it.kind === 'step'
                      const when = it.at === null ? '' : ` · ${relAgo(it.at, Date.now(), lang)}`
                      if (it.kind !== 'step') return <Txt key={i} role="bubble" content="user">{it.kind === 'you' ? `${t(lang, 'terminal.activityYou')}:${it.text}` : it.text}</Txt>
                      const label = `${now ? `${t(lang, 'terminal.activityNow')} · ` : ''}${it.error ? `${t(lang, 'terminal.activityFailed')} · ` : ''}${stepLabel(it, lang)}${when}`
                      const line = <Txt testID={now ? 'terminal-activity-now' : undefined} role="small" content="user" tone={it.error ? 'bad' : now ? 'ink' : 'inkSoft'}>{it.detail ? `${label}  ${open[`${it.at}|${it.text}`] ? '⌄' : '›'}` : label}</Txt>
                      if (!it.detail) return <View key={i}>{line}</View>
                      // 改文件 ⇒ diff(+ / - 行上色);命令 ⇒ 输出尾巴
                      const k = `${it.at}|${it.text}`, isDiff = /^(改|写|删) /.test(it.text)
                      return (
                        <View key={i} style={{ gap: space.s }}>
                          <Pressable testID={`terminal-step-${i}`} accessibilityRole="button" accessibilityState={{ expanded: !!open[k] }} accessibilityLabel={label} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setOpen(o => ({ ...o, [k]: !o[k] }))}>{line}</Pressable>
                          {open[k] ? (
                            <View testID={`terminal-step-detail-${i}`} style={{ paddingVertical: space.s, gap: space.xs }}>
                              {it.detail.split('\n').map((l, j) => (
                                <Txt key={j} role="code" content="user" style={isDiff && l.startsWith('+ ') ? { color: c.accent } : isDiff && l.startsWith('- ') ? { color: c.bad } : undefined}>{l || ' '}</Txt>
                              ))}
                            </View>
                          ) : null}
                        </View>
                      )
                    })}
                  </View>
                </View>
              ) : (
                <View style={{ gap: space.s }}>
                  {activity.error === 'cli_session_remote' ? <Txt testID="terminal-activity-remote" role="meta" tone="inkSoft">{t(lang, 'terminal.activityRemote')}</Txt> : null}
                  <Txt role="meta" tone="inkSoft" accessibilityRole="header">{t(lang, 'terminal.lastSaid')}</Txt>
                  <Txt testID="terminal-detail-summary" role="bubble" content="user" tone={row.summary ? 'ink' : 'inkSoft'}>{row.summary ?? t(lang, 'terminal.noSummary')}</Txt>
                </View>
              )}
              {/* 没送进去也是灰字:daemon 的原话照抄,不当成红色的出错 */}
              {shown ? <Txt testID="terminal-detail-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{shown}</Txt> : null}
            </>
          )}
        </ScrollView>
        {row && row.status !== 'ended' ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.m, paddingBottom: space.m, gap: space.s }}>
            {row.live ? <Txt testID="terminal-say-live" role="meta" tone="inkSoft">{t(lang, 'terminal.liveWindow')}</Txt> : null}
            {!canSayTo(row.status, row.live) ? <Txt testID="terminal-say-busy" role="meta" tone="inkSoft">{t(lang, row.status === 'waiting' ? 'terminal.sayWaiting' : 'terminal.sayBusy')}</Txt> : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s }}>
            <TextField
              testID="terminal-say-input"
              accessibilityLabel={t(lang, 'terminal.sayPlaceholder')}
              placeholder={t(lang, 'terminal.sayPlaceholder')}
              value={text}
              onChangeText={setText}
              editable={sayOpen}
              multiline
              maxLength={SAY_MAX}
              style={{ flex: 1, minHeight: 48, maxHeight: 160, paddingHorizontal: space.l, paddingVertical: space.m, borderWidth: 1, borderColor: c.hair, borderRadius: radius.control, opacity: sayOpen ? 1 : 0.55 }}
            />
            <IconButton name="arrowUp" testID="terminal-say-send" label={t(lang, 'terminal.send')} busy={sending} disabled={!sayOpen || !text.trim()} onPress={() => void send()} />
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
