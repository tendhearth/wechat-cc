import { useState, type ReactNode } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, Share, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError } from '../backend/types'
import { t, type Lang } from '../i18n'
import { previewKind } from '../state/artifact-download'
import { bytesToBase64 } from '../state/image-upload'
import { MessageText } from './Markdown'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

type Opened = { name: string; kind: 'image'; uri: string } | { name: string; kind: 'text'; text: string }
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
export function useFileOpener(lang: Lang): { open(ref: FileRef, load: () => Promise<Uint8Array>): Promise<void>; busyId: string | null; note: string | null; viewer: ReactNode } {
  const { c } = useTheme()
  const [busyId, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const open = async (ref: FileRef, load: () => Promise<Uint8Array>) => {
    if (busyId) return
    setBusy(ref.id); setNote(null)
    try {
      const bytes = await load()
      const kind = previewKind(ref.mime, ref.name)
      if (kind === 'image') setOpened({ name: ref.name, kind, uri: `data:${ref.mime};base64,${bytesToBase64(bytes)}` })
      else if (kind === 'text') setOpened({ name: ref.name, kind, text: new TextDecoder().decode(bytes) })
      else {
        const { File, Paths } = await import('expo-file-system')
        const file = new File(Paths.cache, `cc-out-${ref.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16)}-${ref.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(-80)}`)
        if (file.exists) file.delete()
        file.create(); file.write(bytes)
        if (Platform.OS === 'ios') await Share.share({ url: file.uri })
        else setNote(t(lang, 'artifacts.openOnComputer'))
      }
    } catch (e) {
      const code = e instanceof BackendError ? e.code : ''
      setNote(t(lang, code === 'too_large' ? 'artifacts.tooLarge' : code === 'stale' ? 'artifacts.changed' : 'artifacts.failed'))
    } finally { setBusy(null) }
  }
  const viewer = (
    <Modal visible={!!opened} animationType="slide" onRequestClose={() => setOpened(null)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space.l, gap: space.m, borderBottomWidth: 1, borderBottomColor: c.hair }}>
          <Txt role="item" content="user" numberOfLines={1} style={{ flex: 1 }}>{opened?.name ?? ''}</Txt>
          <Pressable testID="artifact-close" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.close')} onPress={() => setOpened(null)} hitSlop={8}
            style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair }}>
            <Txt role="meta">{t(lang, 'artifacts.close')}</Txt>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: space.l }} maximumZoomScale={opened?.kind === 'image' ? 4 : 1}>
          {opened?.kind === 'image' ? <Image source={{ uri: opened.uri }} accessibilityLabel={opened.name} resizeMode="contain" style={{ width: '100%', aspectRatio: 1 }} /> : null}
          {opened?.kind === 'text' ? <MessageText role="assistant" text={opened.text} /> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
  return { open, busyId, note, viewer }
}
