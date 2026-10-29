import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type Lang } from '../i18n'
import { conversationText } from '../i18n/minimal-conversation'
import { useLang } from '../i18n/useLang'
import { dropDraftImages, getDraft, peekDraftImages, setDraft } from '../state/drafts'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { useChat, type ChatSendOutcome } from '../state/useChat'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { BusyIndicator } from '../ui/motion'
import { StatusHint } from '../ui/StatusHint'
import { MessageText } from '../ui/Markdown'
import { ReplyAttachments, ReplyProcess } from '../ui/ReplyExtras'
import { TextField } from '../ui/TextField'
import { ImageTray } from '../ui/ImageTray'
import { SendTalkButton, TalkStatus, useHoldToTalk } from '../ui/HoldToTalk'
import { mergeTranscript } from '../view/hold-to-talk'
import type { PickedImage } from '../state/image-upload'
import { PHONE_CHAT_MAX_IMAGES as CHAT_MAX_IMAGES } from '@wechat-cc/protocol'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { hasBubbleText, textAfterSend, type Bubble } from '../view/chat'
import { canSubmit } from '../view/connection'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

const FAILED_KEY = { busy: 'chat.failedBusy', unavailable: 'chat.failedUnavailable', notConfigured: 'chat.failedNotConfigured', maybeLost: 'chat.maybeLost', notConfirmed: 'chat.notConfirmed' } as const
const OUTCOME_KEY = { busy: 'compose.busy', ccBusy: 'chat.ccBusy', uncertain: 'compose.uncertain', tooLong: 'compose.tooLong', revoked: 'conn.revokedTitle', failed: 'compose.failed', refused: 'compose.notTaken' , imagesGone: 'chat.imagesGone', imagesUnsupported: 'chat.imagesUnsupported'} as const

// 跟 CC 说:微信 / 电脑 / 手机共用一条对话;状态只在对应内容旁出现,点开再看原因。
export default function Chat() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const online = canSubmit(conn)
  const chat = useChat()
  const { backend } = useBackendCtx()
  const [text, setTextState] = useState(() => getDraft('chat'))
  // 发送是异步的:成功回来时比的是「现在」输入框里的字,不是点发送时闭包里的那份
  const textRef = useRef(text)
  const setText = (v: string) => { setDraft('chat', v); textRef.current = v; setTextState(v) }
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<Exclude<ChatSendOutcome, 'ok'> | null>(null)
  const lock = useRef(false)
  // 待发的图(2026-10-06):只在这一屏里;发成功就清,没发出去留着再点就是重发同一句。
  // 分享进来的图(分享页放在草稿旁边)在这里接过来;挂载后就是这一屏自己的
  const [images, setImages] = useState<PickedImage[]>(() => peekDraftImages('chat'))
  useEffect(() => { dropDraftImages('chat') }, [])
  const [imageNote, setImageNote] = useState<string | null>(null)
  const addImages = async () => {
    // 用到才加载:相册与哈希是原生模块,不进页面的静态依赖(测试与首屏都不需要它)
    const { pickImages } = await import('../net/image-pick')
    const r = await pickImages(CHAT_MAX_IMAGES - images.length)
    if (!r) return
    setImages(cur => [...cur, ...r.images].slice(0, CHAT_MAX_IMAGES))
    setImageNote(r.skipped === 'too_large' ? t(lang, 'images.tooLarge') : r.skipped === 'unsupported' ? t(lang, 'images.unsupported') : null)
  }

  const run = async (go: () => Promise<ChatSendOutcome>, sent: string | null) => {
    if (lock.current || !online) return
    lock.current = true
    setSending(true); setOutcome(null)
    try {
      const r = await go()
      if (r === 'ok') {
        setImages([]); setImageNote(null)
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
  const send = () => { const sent = text, imgs = images; if (sent.trim() || imgs.length) void run(() => chat.send(sent, imgs), sent) }
  const canSend = online && (!!text.trim() || images.length > 0) && !sending
  const retry = (b: Bubble) => { if (b.requestId) void run(() => chat.retry(b.requestId!, b.text), null) }

  // 这条对话现在用谁(2026-10-06):一眼看见,点进去换。
  const chatModel = useQuery('chatModel', () => backend.chatModel(), { refreshOnMount: true })
  // 按住说话(2026-10-18):转出来的字接在输入框后面,主人看过再点发送 —— 永不自动发。发送和说话是同一颗按钮(有字点一下发、按住说;空着一按就说)。电脑上没配语音转文字 ⇒ 按钮先说清楚。
  const sttStatus = useQuery('transcribeStatus', () => backend.transcribeStatus(), { refreshOnMount: true })
  const talk = useHoldToTalk({
    transcribe: p => backend.transcribe(p),
    onText: s => setText(mergeTranscript(textRef.current, s)),
    configured: sttStatus.data?.configured ?? null,
  })
  const data = [...chat.bubbles].reverse()
  const loadFailed = !chat.page && chat.error !== undefined && !chat.noOwner

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        title={t(lang, 'chat.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        actions={<IconButton name="search" label={t(lang, 'chatSearch.title')} testID="chat-search-open" onPress={() => router.push('/chat-search')} />}
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
              <Pressable testID="chat-load-older" accessibilityRole="button" accessibilityLabel={t(lang, chat.loadingOlder ? 'chat.loadingOlder' : 'chat.olderHint')}
                disabled={chat.loadingOlder} onPress={() => void chat.loadOlder()} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                {chat.loadingOlder ? <BusyIndicator label={t(lang, 'chat.loadingOlder')} /> : <Icon name="chevronDown" color={c.inkSoft} />}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            // inverted 列表的空态会倒过来,再转一次摆正
            <View style={{ flex: 1, justifyContent: 'center', transform: [{ scaleY: -1 }] }}>
              {chat.noOwner ? (
                <Txt testID="chat-no-owner" role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'chat.noOwner')}</Txt>
              ) : loadFailed ? (
                <StatusHint testID="chat-load-failed" label={t(lang, 'feedback.loadingFailed')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'chat.loadFailed')}>
                  <ChatCheck lang={lang} online={online} loading={chat.loading} error={chat.error} onCheck={chat.refresh} />
                </StatusHint>
              ) : !chat.page ? (
                <BusyIndicator label={t(lang, 'progress.loading')} color={c.inkSoft} />
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <ChatBubble b={item} lang={lang} canRetry={online && !sending} onRetry={() => retry(item)} onDismiss={() => chat.dismiss(item.requestId ?? '')} checking={chat.loading} checkError={chat.error} onCheck={chat.refresh} />
          )}
        />
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m, gap: space.s }}>
          {outcome ? (
            <View style={{ alignItems: 'flex-end' }}><StatusHint testID={`chat-outcome-${outcome}`} label={t(lang, outcome === 'uncertain' ? 'feedback.unconfirmed' : 'feedback.notSent')}
              icon={outcome === 'uncertain' ? 'help' : 'alert'} description={t(lang, OUTCOME_KEY[outcome])}>
              {outcome === 'uncertain' ? <ChatCheck lang={lang} online={online} loading={chat.loading} error={chat.error} onCheck={chat.refresh} /> : null}
            </StatusHint></View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
            <IconButton name="plus" label={t(lang, 'images.add')} testID="chat-add-image" disabled={sending || images.length >= CHAT_MAX_IMAGES} onPress={() => { void addImages() }} />
            <Pressable testID="chat-model-open" accessibilityRole="button" accessibilityLabel={`${t(lang, 'chatModel.title')}${chatModelLabel(chatModel.data) ? `: ${chatModelLabel(chatModel.data)}` : ''}`}
              onPress={() => router.push('/chat-model')}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space.xs, flexShrink: 1, opacity: pressed ? 0.7 : 1 })}>
              <Txt role="meta" tone="inkSoft" numberOfLines={1} style={{ flexShrink: 1 }}>{chatModelLabel(chatModel.data) ?? t(lang, 'chatModel.open')}</Txt>
              <Icon name="chevronDown" color={c.inkSoft} size={14} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable testID="chat-handoff" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.handoff')}
              onPress={() => router.push('/compose')}
              style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.s, opacity: pressed ? 0.7 : 1 })}>
              <Txt role="meta" tone="accent">{conversationText(lang, 'handoff')}</Txt>
            </Pressable>
          </View>
          <ImageTray testID="chat-images" images={images} lang={lang} onRemove={id => { setImages(cur => cur.filter(i => i.id !== id)); setImageNote(null) }} />
          {imageNote ? <Txt testID="chat-image-note" role="meta" tone="inkSoft">{imageNote}</Txt> : null}
          <TalkStatus view={talk.view} elapsedMs={talk.elapsedMs} lang={lang} testID="chat-talk" />
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s }}>
            <TextField
              testID="chat-input"
              accessibilityLabel={t(lang, 'chat.placeholder')}
              value={text}
              onChangeText={v => { setText(v); talk.ctl.clearNote() }}
              multiline
              placeholder={t(lang, 'chat.placeholder')}
              style={{ flex: 1, minHeight: 48, maxHeight: 140, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.m, borderRadius: radius.sheet, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper }}
            />
            <SendTalkButton ctl={talk.ctl} view={talk.view} elapsedMs={talk.elapsedMs} lang={lang} sendable={canSend} talkable={online && !sending} sending={sending} onTap={send} testID="chat-send" />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

// 对话用左右与留白区分说话人,文件先于可展开的执行过程。
function ChatBubble({ b, lang, canRetry, onRetry, onDismiss, checking, checkError, onCheck }: { b: Bubble; lang: Lang; canRetry: boolean; onRetry(): void; onDismiss(): void; checking: boolean; checkError: unknown; onCheck(): Promise<void> }) {
  const me = b.side === 'me'
  if (b.state === 'thinking') return <Thinking lang={lang} />
  const from = t(lang, `chat.from.${b.source}`)
  // 只有附件的回复不画空文字区;过程仍可展开查看。
  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start', gap: space.xs }}>
      {hasBubbleText(b) ? <View
        testID={me ? 'chat-bubble-me' : 'chat-bubble-cc'}
        style={{
          maxWidth: '88%', paddingVertical: space.m, gap: space.s,
          opacity: b.state === 'failed' ? 0.8 : 1,
        }}
      >
        <Txt role="caption" tone="inkSoft">{t(lang, me ? 'chat.me' : 'cc.label')}</Txt>
        <MessageText role={me ? 'user' : 'assistant'} text={b.text} />
        {b.truncated ? <Txt role="caption" tone="inkSoft">{t(lang, 'chat.truncated')}</Txt> : null}
      </View> : null}
      {b.attachments?.length ? <ReplyAttachments messageId={b.key} items={b.attachments} lang={lang} /> : null}
      {!me && b.narration?.length ? <ReplyProcess lines={b.narration} lang={lang} testID="chat-process" /> : null}
      <Txt role="caption" tone="inkSoft">{from} · {hhmm(b.at)}</Txt>
      {b.state === 'failed' && b.failedKind ? (
        <StatusHint testID={`chat-failed-${b.failedKind}`}
          label={t(lang, b.failedKind === 'maybeLost' || b.failedKind === 'notConfirmed' ? 'feedback.unconfirmed' : 'feedback.notSent')}
          icon={b.failedKind === 'maybeLost' || b.failedKind === 'notConfirmed' ? 'help' : 'alert'} description={t(lang, FAILED_KEY[b.failedKind])}>
          {close => <>
            {b.failedKind === 'maybeLost' || b.failedKind === 'notConfirmed'
              ? <ChatCheck lang={lang} online={canRetry} loading={checking} error={checkError} onCheck={onCheck} /> : null}
            {/* 重试 / 不管它的结果显示在聊天里(弹层后面):点了先关弹层 */}
            {b.requestId ? <Button kind="secondary" testID="chat-retry" label={t(lang, 'chat.retry')} disabled={!canRetry} onPress={() => { close(); onRetry() }} /> : null}
            {b.failedKind === 'notConfirmed' ? <Button kind="secondary" testID="chat-dismiss" label={t(lang, 'chat.dismiss')} onPress={() => { close(); onDismiss() }} /> : null}
          </>}
        </StatusHint>
      ) : null}
    </View>
  )
}

function ChatCheck({ lang, online, loading, error, onCheck }: { lang: Lang; online: boolean; loading: boolean; error: unknown; onCheck(): Promise<void> }) {
  // 核对读成功但这条还没出现 ⇒ 说一声(找到了的话这条状态入口整个消失,不用说);读失败照旧「暂未刷新」。
  const [checked, setChecked] = useState(false)
  const readFailed = !!error && error !== 'not_found'
  return <View style={{ gap: space.s }}>
    {readFailed ? <Txt testID="chat-check-failed" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'feedback.loadingFailed')}</Txt> : null}
    {checked && !loading && !readFailed ? <Txt testID="chat-check-none" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'feedback.checkedNotSeen')}</Txt> : null}
    <Button kind="secondary" testID="chat-check" label={t(lang, 'feedback.check')} disabled={!online} busy={loading} onPress={() => { setChecked(false); void onCheck().finally(() => setChecked(true)) }} />
  </View>
}

function Thinking({ lang }: { lang: Lang }) {
  return <View style={{ alignItems: 'flex-start', paddingHorizontal: space.l, paddingVertical: space.m }}>
    <BusyIndicator testID="chat-thinking" label={t(lang, 'chat.thinking')} />
  </View>
}

/** 「Claude · claude-opus-5-5」:钉了的模型优先,没钉看全局;读不到 ⇒ null(按钮显示「模型」)。 */
function chatModelLabel(v: { provider: string; model: string | null; globalModel: string | null; providers: Array<{ id: string; name: string }> } | undefined): string | null {
  if (!v) return null
  const name = v.providers.find(p => p.id === v.provider)?.name ?? v.provider
  const model = v.model ?? v.globalModel
  return model ? `${name} · ${model}` : name
}
