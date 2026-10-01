import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type Lang } from '../i18n'
import { useLang } from '../i18n/useLang'
import { getDraft, setDraft } from '../state/drafts'
import { useConnection } from '../state/hooks'
import { useChat, type ChatSendOutcome } from '../state/useChat'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { textAfterSend, type Bubble } from '../view/chat'
import { canSubmit } from '../view/connection'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

const FAILED_KEY = { busy: 'chat.failedBusy', unavailable: 'chat.failedUnavailable', notConfigured: 'chat.failedNotConfigured', maybeLost: 'chat.maybeLost', notConfirmed: 'chat.notConfirmed' } as const
const OUTCOME_KEY = { busy: 'compose.busy', ccBusy: 'chat.ccBusy', uncertain: 'compose.uncertain', tooLong: 'compose.tooLong', revoked: 'conn.revokedTitle', failed: 'compose.failed' } as const

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
        // 只在输入框还是发出去那句时清空(Task 11 a);草稿由 useChat.send 按同一规则删
        if (sent !== null) { const left = textAfterSend(textRef.current, sent); textRef.current = left; setTextState(left) }
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
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
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
              <Text testID="chat-load-older" style={{ color: c.muted, fontSize: 12, textAlign: 'center', paddingVertical: space.s }}>
                {t(lang, chat.loadingOlder ? 'chat.loadingOlder' : 'chat.olderHint')}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            // inverted 列表的空态会倒过来,再转一次摆正
            <View style={{ flex: 1, justifyContent: 'center', transform: [{ scaleY: -1 }] }}>
              {chat.noOwner ? (
                <Text testID="chat-no-owner" style={{ color: c.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' }}>{t(lang, 'chat.noOwner')}</Text>
              ) : loadFailed ? (
                <Text testID="chat-load-failed" style={{ color: c.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' }}>{t(lang, 'chat.loadFailed')}</Text>
              ) : !chat.page ? (
                <ActivityIndicator accessibilityLabel={t(lang, 'progress.loading')} color={c.muted} />
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <ChatBubble b={item} lang={lang} canRetry={online && !sending} onRetry={() => retry(item)} onDismiss={() => chat.dismiss(item.requestId ?? '')} />
          )}
        />
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m, gap: space.s }}>
          {outcome ? (
            <Text testID={`chat-outcome-${outcome}`} accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14 }}>{t(lang, OUTCOME_KEY[outcome])}</Text>
          ) : null}
          <Pressable
            testID="chat-handoff"
            accessibilityRole="button"
            accessibilityLabel={t(lang, 'chat.handoff')}
            onPress={() => router.push('/compose')}
            hitSlop={6}
            style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.pill, borderWidth: 1, borderColor: c.line, opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ color: c.ink, fontSize: 14 }}>{t(lang, 'chat.handoff')} ›</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s }}>
            <TextInput
              testID="chat-input"
              accessibilityLabel={t(lang, 'chat.placeholder')}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={t(lang, 'chat.placeholder')}
              placeholderTextColor={c.muted}
              style={{ flex: 1, minHeight: 48, maxHeight: 140, paddingHorizontal: space.l, paddingTop: 13, paddingBottom: 13, borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.card, color: c.ink, fontSize: 16, lineHeight: 22 }}
            />
            <Pressable
              testID="chat-send"
              accessibilityRole="button"
              accessibilityLabel={t(lang, 'chat.send')}
              accessibilityState={{ disabled: !online || !text.trim() || sending, busy: sending }}
              disabled={!online || !text.trim() || sending}
              onPress={send}
              style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: space.l, borderRadius: radius.button, justifyContent: 'center', backgroundColor: c.primary, opacity: !online || !text.trim() || sending ? 0.55 : pressed ? 0.85 : 1 })}
            >
              {sending ? <ActivityIndicator color={c.primaryInk} /> : <Text style={{ color: c.primaryInk, fontSize: 16 }}>{t(lang, 'chat.send')}</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

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
          maxWidth: '85%', paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.card,
          backgroundColor: me ? c.accentSoft : c.card, borderWidth: me ? 0 : 1, borderColor: c.line,
          opacity: b.state === 'failed' ? 0.8 : 1,
        }}
      >
        <Text selectable style={{ color: c.ink, fontSize: 16, lineHeight: 23 }}>
          {b.text}{b.truncated ? t(lang, 'chat.truncated') : ''}
        </Text>
      </View>
      <Text style={{ color: c.muted, fontSize: 11 }}>{from} · {hhmm(b.at)}</Text>
      {b.state === 'failed' && b.failedKind ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
          <Text testID={`chat-failed-${b.failedKind}`} accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 13 }}>{t(lang, FAILED_KEY[b.failedKind])}</Text>
          {b.requestId ? (
            <Pressable testID="chat-retry" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.retry')} accessibilityState={{ disabled: !canRetry }} disabled={!canRetry} onPress={onRetry} hitSlop={10} style={{ opacity: canRetry ? 1 : 0.5 }}>
              <Text style={{ color: c.ink, fontSize: 13, textDecorationLine: 'underline' }}>{t(lang, 'chat.retry')}</Text>
            </Pressable>
          ) : null}
          {b.failedKind === 'notConfirmed' ? (
            <Pressable testID="chat-dismiss" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.dismiss')} onPress={onDismiss} hitSlop={10}>
              <Text style={{ color: c.muted, fontSize: 13, textDecorationLine: 'underline' }}>{t(lang, 'chat.dismiss')}</Text>
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
        style={{ opacity, paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.card, backgroundColor: c.card, borderWidth: 1, borderColor: c.line }}
      >
        <Text style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'chat.thinking')}</Text>
      </Animated.View>
    </View>
  )
}
