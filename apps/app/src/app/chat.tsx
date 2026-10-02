import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type Lang } from '../i18n'
import { useLang } from '../i18n/useLang'
import { getDraft, setDraft } from '../state/drafts'
import { useConnection } from '../state/hooks'
import { useChat, type ChatSendOutcome } from '../state/useChat'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Dot } from '../ui/Dot'
import { TextField } from '../ui/TextField'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { textAfterSend, type Bubble } from '../view/chat'
import { canSubmit } from '../view/connection'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

const FAILED_KEY = { busy: 'chat.failedBusy', unavailable: 'chat.failedUnavailable', notConfigured: 'chat.failedNotConfigured', maybeLost: 'chat.maybeLost', notConfirmed: 'chat.notConfirmed' } as const
const OUTCOME_KEY = { busy: 'compose.busy', ccBusy: 'chat.ccBusy', uncertain: 'compose.uncertain', tooLong: 'compose.tooLong', revoked: 'conn.revokedTitle', failed: 'compose.failed', refused: 'compose.notTaken' } as const

// 跟 CC 说:主人那条对话(微信 / 电脑 / 手机说的都在),往上滑看更早的;回复异步到,等回复时显示「在想…」。
export default function Chat() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const online = canSubmit(conn)
  const chat = useChat()
  const [text, setTextState] = useState(() => getDraft('chat'))
  // 发送是异步的:成功回来时比的是「现在」输入框里的字,不是点发送时闭包里的那份
  const textRef = useRef(text)
  const setText = (v: string) => { setDraft('chat', v); textRef.current = v; setTextState(v) }
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<Exclude<ChatSendOutcome, 'ok'> | null>(null)
  const lock = useRef(false)

  const run = async (go: () => Promise<ChatSendOutcome>, sent: string | null) => {
    if (lock.current || !online) return
    lock.current = true
    setSending(true); setOutcome(null)
    try {
      const r = await go()
      if (r === 'ok') {
        // 只去掉发出去的那段(Task 11 a):原样那句的草稿由 useChat.send 删;接着打过的字同步回草稿
        if (sent !== null) {
          const cur = textRef.current, left = textAfterSend(cur, sent)
          if (left !== cur) { if (cur !== sent) setDraft('chat', left); textRef.current = left; setTextState(left) }
        }
      } else setOutcome(r)
    } finally {
      lock.current = false
      setSending(false)
    }
  }
  const send = () => { const sent = text; if (sent.trim()) void run(() => chat.send(sent), sent) }
  const retry = (b: Bubble) => { if (b.requestId) void run(() => chat.retry(b.requestId!, b.text), null) }

  const data = [...chat.bubbles].reverse()
  const loadFailed = !chat.page && chat.error !== undefined && !chat.noOwner

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        title={t(lang, 'chat.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onAvatar={() => router.push('/settings')}
      />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          testID="chat-list"
          inverted
          data={data}
          keyExtractor={(b) => b.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: space.l, gap: space.m, flexGrow: 1 }}
          onEndReached={() => { void chat.loadOlder() }}
          onEndReachedThreshold={0.2}
          ListFooterComponent={
            chat.canLoadOlder ? (
              <Txt testID="chat-load-older" role="caption" tone="inkSoft" style={{ textAlign: 'center', paddingVertical: space.s }}>
                {t(lang, chat.loadingOlder ? 'chat.loadingOlder' : 'chat.olderHint')}
              </Txt>
            ) : null
          }
          ListEmptyComponent={
            // inverted 列表的空态会倒过来,再转一次摆正
            <View style={{ flex: 1, justifyContent: 'center', transform: [{ scaleY: -1 }] }}>
              {chat.noOwner ? (
                <Txt testID="chat-no-owner" role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'chat.noOwner')}</Txt>
              ) : loadFailed ? (
                <Txt testID="chat-load-failed" role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'chat.loadFailed')}</Txt>
              ) : !chat.page ? (
                <ActivityIndicator accessibilityLabel={t(lang, 'progress.loading')} color={c.inkSoft} />
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <ChatBubble b={item} lang={lang} canRetry={online && !sending} onRetry={() => retry(item)} onDismiss={() => chat.dismiss(item.requestId ?? '')} />
          )}
        />
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m, gap: space.s }}>
          {outcome ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
              <Dot kind="warn" size={8} />
              <Txt testID={`chat-outcome-${outcome}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{t(lang, OUTCOME_KEY[outcome])}</Txt>
            </View>
          ) : null}
          <Pressable
            testID="chat-handoff"
            accessibilityRole="button"
            accessibilityLabel={t(lang, 'chat.handoff')}
            onPress={() => router.push('/compose')}
            hitSlop={6}
            style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, opacity: pressed ? 0.7 : 1 })}
          >
            <Txt role="meta">{t(lang, 'chat.handoff')} ›</Txt>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s }}>
            <TextField
              testID="chat-input"
              accessibilityLabel={t(lang, 'chat.placeholder')}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={t(lang, 'chat.placeholder')}
              style={{ flex: 1, minHeight: 48, maxHeight: 140, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.m, borderRadius: radius.sheet, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper }}
            />
            <Pressable
              testID="chat-send"
              accessibilityRole="button"
              accessibilityLabel={t(lang, 'chat.send')}
              accessibilityState={{ disabled: !online || !text.trim() || sending, busy: sending }}
              disabled={!online || !text.trim() || sending}
              onPress={send}
              style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: space.l, borderRadius: radius.control, justifyContent: 'center', backgroundColor: c.accent, opacity: !online || !text.trim() || sending ? 0.55 : pressed ? 0.85 : 1 })}
            >
              {sending ? <ActivityIndicator color={c.onAccent} /> : <Txt role="body" tone="onAccent">{t(lang, 'chat.send')}</Txt>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

// 气泡照稿(此刻页 CC 那句):纸色 + 细线,说话人那一侧的下角收成小尾巴;「我」与 CC 只靠左右与尾巴区分,不上色块。
const bubbleShape = (me: boolean) => ({
  borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble,
  borderBottomLeftRadius: me ? radius.bubble : 4, borderBottomRightRadius: me ? 4 : radius.bubble,
})

function ChatBubble({ b, lang, canRetry, onRetry, onDismiss }: { b: Bubble; lang: Lang; canRetry: boolean; onRetry(): void; onDismiss(): void }) {
  const { c } = useTheme()
  const me = b.side === 'me'
  if (b.state === 'thinking') return <Thinking lang={lang} />
  const from = t(lang, `chat.from.${b.source}`)
  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start', gap: space.xs }}>
      <View
        testID={me ? 'chat-bubble-me' : 'chat-bubble-cc'}
        accessible
        accessibilityLabel={`${me ? t(lang, 'chat.me') : t(lang, 'cc.label')}: ${b.text}${b.truncated ? ` ${t(lang, 'chat.truncated')}` : ''}`}
        style={{
          maxWidth: '85%', paddingHorizontal: space.l, paddingVertical: space.m, ...bubbleShape(me),
          backgroundColor: c.paper, borderWidth: 1, borderColor: c.hair,
          opacity: b.state === 'failed' ? 0.8 : 1,
        }}
      >
        <Txt selectable role="body" content="user">
          {b.text}{b.truncated ? t(lang, 'chat.truncated') : ''}
        </Txt>
      </View>
      <Txt role="caption" tone="inkSoft">{from} · {hhmm(b.at)}</Txt>
      {b.state === 'failed' && b.failedKind ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s, flexShrink: 1 }}>
            <Dot kind="warn" size={8} />
            <Txt testID={`chat-failed-${b.failedKind}`} role="small" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}>{t(lang, FAILED_KEY[b.failedKind])}</Txt>
          </View>
          {b.requestId ? (
            <Pressable testID="chat-retry" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.retry')} accessibilityState={{ disabled: !canRetry }} disabled={!canRetry} onPress={onRetry} hitSlop={10} style={{ opacity: canRetry ? 1 : 0.5 }}>
              <Txt role="small" style={{ textDecorationLine: 'underline' }}>{t(lang, 'chat.retry')}</Txt>
            </Pressable>
          ) : null}
          {b.failedKind === 'notConfirmed' ? (
            <Pressable testID="chat-dismiss" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.dismiss')} onPress={onDismiss} hitSlop={10}>
              <Txt role="small" tone="inkSoft" style={{ textDecorationLine: 'underline' }}>{t(lang, 'chat.dismiss')}</Txt>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

// 「在想…」:系统开了「减少动态效果」就不动;否则轻轻明暗。
function Thinking({ lang }: { lang: Lang }) {
  const { c } = useTheme()
  const [reduceMotion, setReduceMotion] = useState(true)
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduceMotion(v)).catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => { alive = false; sub.remove() }
  }, [])
  useEffect(() => {
    if (reduceMotion) { opacity.setValue(1); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [reduceMotion, opacity])
  return (
    <View style={{ alignItems: 'flex-start' }}>
      <Animated.View
        testID="chat-thinking"
        accessible
        accessibilityLabel={t(lang, 'chat.thinking')}
        accessibilityLiveRegion="polite"
        style={{ opacity, paddingHorizontal: space.l, paddingVertical: space.m, ...bubbleShape(false), backgroundColor: c.paper, borderWidth: 1, borderColor: c.hair }}
      >
        <Txt role="bubble" tone="inkSoft">{t(lang, 'chat.thinking')}</Txt>
      </Animated.View>
    </View>
  )
}
