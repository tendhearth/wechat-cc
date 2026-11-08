// CC 回复的过程与附件(回复交付,2026-10-04)。过程:灰、默认收起,说清没发到微信;
// 附件:语音(点了才向电脑要声音再放)、表情(本地表情从电脑表情库取图;联网表情只写情绪,不替你去外网取图)、
// 文件(2026-10-06 起点一下按块读下来、在手机上打开;以前只有名字)。图片文件(2026-10-18:CC 在微信上发给你的图、
// 信纸也记进对话)直接画成图,点一下放大;读不到 / 太大 ⇒ 退回可点的文件名。
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Image, Pressable, View } from 'react-native'
import { t, type Lang } from '../i18n'
import { useBackendCtx } from '../state/BackendProvider'
import type { ChatAttachmentT } from '../backend/types'
import { INLINE_IMAGE_MAX_BYTES, inlineImageMime, isInlineImage, voiceFailureKey } from '../view/chat'
import { bytesToBase64 } from '../state/image-upload'
import { radius, space } from './tokens'
import { Icon } from './Icon'
import { Txt } from './Txt'
import { useTheme } from './useTheme'
import { playVoice } from './voice-player'
import { downloadReplyFile } from '../state/artifact-download'
import { sha256Hex, useFileOpener } from './FileViewer'

const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '')

export function ReplyProcess({ lines, lang, testID }: { lines: string[]; lang: Lang; testID: string }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  if (!lines.length) return null
  return (
    <View style={{ gap: space.xs, maxWidth: '85%' }}>
      <Pressable
        testID={`${testID}-toggle`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={t(lang, 'chat.processHint')}
        onPress={() => setOpen(o => !o)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.xs }}
        accessibilityLabel={t(lang, 'chat.process', { n: lines.length })}
      >
        <Txt role="small" tone="inkSoft">{t(lang, 'chat.process', { n: lines.length })}</Txt>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} color={c.inkSoft} size={14} />
      </Pressable>
      {open ? (
        <View testID={`${testID}-lines`} style={{ gap: space.s, paddingVertical: space.s }}>
          <Txt role="caption" tone="inkSoft">{t(lang, 'chat.processHint')}</Txt>
          {lines.map((l, i) => <Txt key={i} role="small" tone="inkSoft" content="user">{l}</Txt>)}
        </View>
      ) : null}
    </View>
  )
}

export function ReplyAttachments({ messageId, items, lang }: { messageId: string; items: ChatAttachmentT[]; lang: Lang }) {
  if (!items.length) return null
  return (
    <View testID="chat-attachments" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s, maxWidth: '85%' }}>
      {items.map((a, i) =>
        a.kind === 'voice' ? <VoiceChip key={i} messageId={messageId} index={i} text={a.text} lang={lang} />
          : a.kind === 'sticker' ? (a.file ? <StickerImage key={i} file={a.file} label={a.label} lang={lang} /> : <Chip key={i} testID="chat-att-sticker-label"><Txt role="small" tone="inkSoft">{t(lang, 'chat.stickerOnline', { label: a.label })}</Txt></Chip>)
            : isInlineImage(a.name) ? <InlineImage key={i} messageId={messageId} index={i} name={a.name} lang={lang} />
              : <FileChip key={i} messageId={messageId} index={i} name={a.name} lang={lang} />
      )}
    </View>
  )
}

function Chip({ children, testID }: { children: ReactNode; testID: string }) {
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingHorizontal: space.m, maxWidth: '100%' }}>
      {children}
    </View>
  )
}

function VoiceChip({ messageId, index, text, lang }: { messageId: string; index: number; text: string; lang: Lang }) {
  const { backend } = useBackendCtx()
  const { c } = useTheme()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<ReturnType<typeof voiceFailureKey> | null>(null)
  const play = async () => {
    if (busy) return
    setBusy(true); setFailed(null)
    try { await playVoice(await backend.chatVoice(messageId, index), `${messageId}-${index}`) }
    catch (e) { setFailed(voiceFailureKey(codeOf(e))) }
    finally { setBusy(false) }
  }
  return (
    <View style={{ gap: space.xs, maxWidth: '100%' }}>
      <Pressable
        testID="chat-att-voice"
        accessibilityRole="button"
        accessibilityLabel={t(lang, 'chat.voicePlay', { text })}
        accessibilityState={{ busy }}
        onPress={() => { void play() }}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingHorizontal: space.m, opacity: pressed ? 0.7 : 1, maxWidth: '100%' })}
      >
        {busy ? <ActivityIndicator size="small" color={c.inkSoft} /> : <Txt role="small" tone="accent">▶</Txt>}
        <Txt role="small">{t(lang, 'chat.voice')}</Txt>
        <Txt role="small" tone="inkSoft" content="user" numberOfLines={2} style={{ flexShrink: 1 }}>{text}</Txt>
      </Pressable>
      {failed ? <Txt testID="chat-att-voice-failed" role="caption" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, failed)}</Txt> : null}
    </View>
  )
}

/** 取不到图(电脑上删了 / 离线)⇒ 退回写情绪的小条,不留一个空框。 */
function StickerImage({ file, label, lang }: { file: string; label: string; lang: Lang }) {
  const { backend } = useBackendCtx()
  const [uri, setUri] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    backend.sticker(file).then(
      s => { if (alive) setUri(`data:${s.mime};base64,${s.data}`) },
      () => { if (alive) setMissing(true) },
    )
    return () => { alive = false }
  }, [backend, file])
  if (missing) return <Chip testID="chat-att-sticker-label"><Txt role="small" tone="inkSoft">{t(lang, 'chat.stickerOnline', { label })}</Txt></Chip>
  return (
    <View testID="chat-att-sticker" accessible accessibilityRole="image" accessibilityLabel={t(lang, 'chat.sticker', { label })} style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
      {uri ? <Image source={{ uri }} style={{ width: 120, height: 120 }} resizeMode="contain" /> : <ActivityIndicator size="small" />}
    </View>
  )
}

/** CC 发来的图(2026-10-18):进对话页就按块读下来画成图(至多 INLINE_IMAGE_MAX_BYTES);点一下全屏看。读不到 ⇒ 文件名。 */
function InlineImage({ messageId, index, name, lang }: { messageId: string; index: number; name: string; lang: Lang }) {
  const { backend } = useBackendCtx()
  const { c } = useTheme()
  const opener = useFileOpener(lang, `${messageId}:${index}`)
  const [img, setImg] = useState<{ bytes: Uint8Array; uri: string } | null>(null)
  const [ratio, setRatio] = useState(3 / 4)
  const [missing, setMissing] = useState(false)
  const mime = inlineImageMime(name)
  useEffect(() => {
    let alive = true
    downloadReplyFile(backend, messageId, index, sha256Hex, INLINE_IMAGE_MAX_BYTES).then(
      bytes => {
        if (!alive) return
        const uri = `data:${mime};base64,${bytesToBase64(bytes)}`
        setImg({ bytes, uri })
        Image.getSize(uri, (w, h) => { if (alive && w > 0 && h > 0) setRatio(w / h) }, () => {})
      },
      () => { if (alive) setMissing(true) },
    )
    return () => { alive = false }
  }, [backend, messageId, index, mime])
  if (missing) return <FileChip messageId={messageId} index={index} name={name} lang={lang} />
  return (
    <View style={{ width: 240, maxWidth: '100%' }}>
      <Pressable testID="chat-att-image" accessibilityRole="imagebutton" accessibilityLabel={t(lang, 'chat.image', { name })} disabled={!img}
        onPress={() => { if (img) void opener.open({ id: `${messageId}:${index}`, name, mime }, async () => img.bytes) }}
        style={{ width: '100%', minHeight: 44, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
        {img ? <Image testID="chat-att-image-content" source={{ uri: img.uri }} style={{ width: '100%', aspectRatio: ratio }} resizeMode="contain" /> : <ActivityIndicator size="small" color={c.inkSoft} accessibilityLabel={t(lang, 'progress.loading')} />}
      </Pressable>
      {opener.note ? <Txt testID="chat-att-image-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{opener.note}</Txt> : null}
      {opener.viewer}
    </View>
  )
}

/** CC 回复里的文件(2026-10-06):点一下按块读下来,在手机上打开(图片 / 文字在 app 里看,其它交给系统)。 */
function FileChip({ messageId, index, name, lang }: { messageId: string; index: number; name: string; lang: Lang }) {
  const { backend } = useBackendCtx()
  const opener = useFileOpener(lang, `${messageId}:${index}`)
  const id = `${messageId}:${index}`
  const mime = guessMime(name)
  return (
    <View style={{ gap: space.xs }}>
      <Pressable testID="chat-att-file" accessibilityRole="button" accessibilityLabel={t(lang, 'chat.fileOpen', { name })} disabled={!!opener.busyId}
        onPress={() => void opener.open({ id, name, mime }, () => downloadReplyFile(backend, messageId, index, sha256Hex))}>
        <Chip testID="chat-att-file-chip"><Icon name="folder" /><Txt role="small" content="user" style={{ flexShrink: 1 }}>{name}</Txt><Txt role="caption" tone="inkSoft">{opener.busyId === id ? t(lang, 'progress.loading') : t(lang, 'artifacts.open')}</Txt></Chip>
      </Pressable>
      {opener.note ? <Txt testID="chat-att-file-note" role="caption" tone="inkSoft" accessibilityLiveRegion="polite">{opener.note}</Txt> : null}
      {opener.viewer}
    </View>
  )
}
/** 按扩展名猜类型(只用来决定在 app 里看还是交给系统;电脑那边回的 mime 不影响)。 */
function guessMime(name: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}
