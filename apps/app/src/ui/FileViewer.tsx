import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, Share, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { BackendError } from '../backend/types'
import { t, type Lang } from '../i18n'
import { previewKind } from '../state/artifact-download'
import { bytesToBase64 } from '../state/image-upload'
import { MessageText } from './Markdown'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

type Opened = { ref: FileRef; bytes: Uint8Array } & ({ kind: 'image'; uri: string; ratio: number } | { kind: 'text'; text: string; markdown: boolean })
export type FileRef = { id: string; name: string; mime: string }

/** 字节的 sha256(十六进制)。原生模块用到才加载,页面的静态依赖里没有它。 */
export async function sha256Hex(b: Uint8Array): Promise<string> {
  const Crypto = await import('expo-crypto')
  return Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b as Uint8Array<ArrayBuffer>)), x => x.toString(16).padStart(2, '0')).join('')
}

/**
 * 在手机上打开一份文件(2026-10-06,成果与 CC 回复里的文件共用):图片 / 文字在 app 里看,其它存进缓存交给系统分享面板
 * (iOS 里能预览、存到「文件」)。读取由调用方给(按块、核对哈希);太大 / 中途换了各说一句。
 */
export function useFileOpener(lang: Lang, owner = ''): { open(ref: FileRef, load: () => Promise<Uint8Array>): Promise<void>; busyId: string | null; note: string | null; viewer: ReactNode } {
  const { c } = useTheme()
  const [busyId, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [sharing, setSharing] = useState(false)
  const [viewerNote, setViewerNote] = useState<string | null>(null)
  const generation = useRef(0)
  const locked = useRef(false)
  useEffect(() => {
    generation.current += 1; locked.current = false
    setOpened(null); setBusy(null); setNote(null); setSharing(false); setViewerNote(null)
    return () => { generation.current += 1; locked.current = false }
  }, [owner])
  const errorText = (e: unknown) => {
    const code = e instanceof BackendError ? e.code : ''
    return t(lang, code === 'too_large' ? 'artifacts.tooLarge' : code === 'stale' ? 'artifacts.changed' : 'artifacts.failed')
  }
  const shareBytes = async (ref: FileRef, bytes: Uint8Array) => {
    const { File, Paths } = await import('expo-file-system')
    const file = new File(Paths.cache, `cc-out-${ref.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16)}-${ref.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(-80)}`)
    if (file.exists) file.delete()
    file.create(); file.write(bytes)
    await Share.share({ url: file.uri })
  }
  const open = async (ref: FileRef, load: () => Promise<Uint8Array>) => {
    if (locked.current) return
    locked.current = true
    const mine = generation.current
    setBusy(ref.id); setNote(null); setViewerNote(null)
    try {
      const bytes = await load()
      if (mine !== generation.current) return
      const kind = previewKind(ref.mime, ref.name)
      if (kind === 'image') {
        const uri = `data:${ref.mime};base64,${bytesToBase64(bytes)}`
        const ratio = await new Promise<number>((resolve, reject) => Image.getSize(uri, (width, height) => width > 0 && height > 0 ? resolve(width / height) : reject(new Error('image size')), reject))
        if (mine === generation.current) setOpened({ ref, bytes, kind, uri, ratio })
      } else if (kind === 'text') {
        setOpened({ ref, bytes, kind, text: new TextDecoder().decode(bytes), markdown: ref.mime.split(';')[0]?.trim() === 'text/markdown' || /\.(md|markdown)$/i.test(ref.name) })
      } else if (Platform.OS === 'ios') await shareBytes(ref, bytes)
      else setNote(t(lang, 'artifacts.openOnComputer'))
    } catch (e) {
      if (mine === generation.current) setNote(errorText(e))
    } finally { if (mine === generation.current) { locked.current = false; setBusy(null) } }
  }
  const close = () => { setOpened(null); setViewerNote(null) }
  const share = async () => {
    if (!opened || sharing) return
    const mine = generation.current
    setSharing(true); setViewerNote(null)
    try { await shareBytes(opened.ref, opened.bytes) }
    catch (e) { if (mine === generation.current) setViewerNote(errorText(e)) }
    finally { if (mine === generation.current) setSharing(false) }
  }
  const control = { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: space.m }
  const viewer = (
    <Modal visible={!!opened} animationType="slide" onRequestClose={close}>
      <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: space.l, gap: space.m }}>
          {Platform.OS === 'ios' ? <Pressable testID="artifact-share" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.share')} disabled={sharing} onPress={() => void share()} style={control}>
            <Txt role="meta" tone="accent">{t(lang, 'artifacts.share')}</Txt>
          </Pressable> : null}
          <Pressable testID="artifact-close" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.close')} onPress={close} style={control}>
            <Txt role="meta">{t(lang, 'artifacts.close')}</Txt>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: space.l, gap: space.l }} maximumZoomScale={opened?.kind === 'image' ? 4 : 1} minimumZoomScale={1}>
          <Txt role="item" content="user" selectable accessibilityRole="header">{opened?.ref.name ?? ''}</Txt>
          {viewerNote ? <Txt testID="artifact-viewer-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{viewerNote}</Txt> : null}
          {opened?.kind === 'image' ? Platform.OS === 'android' ? <AndroidImage key={opened.ref.id} uri={opened.uri} name={opened.ref.name} ratio={opened.ratio} lang={lang} onError={() => setViewerNote(t(lang, 'artifacts.failed'))} /> : <Image testID="artifact-image" source={{ uri: opened.uri }} accessibilityLabel={opened.ref.name} resizeMode="contain"
            onError={() => setViewerNote(t(lang, 'artifacts.failed'))} style={{ width: '100%', aspectRatio: opened.ratio }} /> : null}
          {opened?.kind === 'text' ? opened.markdown ? <View testID="artifact-markdown"><MessageText role="assistant" text={opened.text} /></View>
            : <ScrollView horizontal nestedScrollEnabled style={{ maxWidth: '100%' }}><Txt testID="artifact-plain-text" role="code" content="user" selectable>{opened.text}</Txt></ScrollView> : null}
        </ScrollView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  )
  return { open, busyId, note, viewer }
}


/** Android ScrollView has no native zoom. Scale a real image canvas, then pan
 * horizontally here and vertically in the reader's existing outer ScrollView. */
function AndroidImage({ uri, name, ratio, lang, onError }: { uri: string; name: string; ratio: number; lang: Lang; onError(): void }) {
  const { width: windowWidth } = useWindowDimensions()
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scale, setScale] = useState(1)
  const width = (viewportWidth || Math.max(1, windowWidth - 2 * space.l)) * scale
  const control = { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: space.m }
  return <View testID="artifact-image-viewport" style={{ width: '100%', gap: space.s }}
    onLayout={event => { const width = event.nativeEvent.layout.width; if (width > 0) setViewportWidth(width) }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.s }}>
      <Pressable testID="artifact-zoom-out" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.zoomOut')} disabled={scale === 1} onPress={() => setScale(value => Math.max(1, value - 1))} style={control}>
        <Txt role="meta" tone={scale === 1 ? 'inkSoft' : 'accent'}>{t(lang, 'artifacts.zoomOut')}</Txt>
      </Pressable>
      <Txt testID="artifact-zoom-level" role="meta" accessibilityLiveRegion="polite">{scale * 100}%</Txt>
      <Pressable testID="artifact-zoom-in" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.zoomIn')} disabled={scale === 4} onPress={() => setScale(value => Math.min(4, value + 1))} style={control}>
        <Txt role="meta" tone={scale === 4 ? 'inkSoft' : 'accent'}>{t(lang, 'artifacts.zoomIn')}</Txt>
      </Pressable>
    </View>
    <ScrollView testID="artifact-image-pan" horizontal nestedScrollEnabled style={{ maxWidth: '100%', flexGrow: 0 }}>
      <Image testID="artifact-image" source={{ uri }} accessibilityLabel={name} resizeMode="contain" onError={onError} style={{ width, height: width / ratio, aspectRatio: ratio }} />
    </ScrollView>
  </View>
}
