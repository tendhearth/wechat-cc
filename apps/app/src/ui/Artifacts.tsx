import { useState } from 'react'
import { ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, Share, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Backend } from '../backend/types'
import { BackendError } from '../backend/types'
import { t, type Lang } from '../i18n'
import { downloadArtifact, humanSize, previewKind, type ArtifactRef } from '../state/artifact-download'
import { bytesToBase64 } from '../state/image-upload'
import { MessageText } from './Markdown'
import { Sheet } from './Sheet'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

type Opened = { a: ArtifactRef; kind: 'image'; uri: string } | { a: ArtifactRef; kind: 'text'; text: string }

/**
 * 一件事的成果(2026-10-06,对标 Paseo / Orca 手机上看产出):列出来,点开读。
 * 图片、文字类在 app 里直接看;PDF / 网页 / 表格等存进缓存交给系统分享面板(iOS 里能预览、存到「文件」)。
 * 读取按块、核对 sha256;电脑上那份中途换了 ⇒ 说一声,不显示半截。
 */
export function Artifacts({ matterId, artifacts, backend, lang, online }: { matterId: string; artifacts: readonly ArtifactRef[]; backend: Pick<Backend, 'artifactChunk'>; lang: Lang; online: boolean }) {
  const { c } = useTheme()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  if (!artifacts.length) return null

  const open = async (a: ArtifactRef) => {
    if (busy) return
    setBusy(a.id); setNote(null)
    try {
      // 原生模块用到才加载(哈希 / 写缓存文件),页面的静态依赖里没有它们
      const Crypto = await import('expo-crypto')
      const sha = async (b: Uint8Array) => Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b as Uint8Array<ArrayBuffer>)), x => x.toString(16).padStart(2, '0')).join('')
      const bytes = await downloadArtifact(backend, matterId, a, sha)
      const kind = previewKind(a.mime, a.name)
      if (kind === 'image') setOpened({ a, kind, uri: `data:${a.mime};base64,${bytesToBase64(bytes)}` })
      else if (kind === 'text') setOpened({ a, kind, text: new TextDecoder().decode(bytes) })
      else {
        const { File, Paths } = await import('expo-file-system')
        const file = new File(Paths.cache, `cc-out-${a.id.slice(0, 8)}-${a.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(-80)}`)
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

  return (
    <Sheet testID="progress-artifacts" title={t(lang, 'artifacts.title', { n: artifacts.length })} defaultOpen>
      <View style={{ gap: space.s }}>
        {artifacts.map((a, i) => (
          <Pressable key={a.id} testID={`artifact-${i}`} accessibilityRole="button" accessibilityLabel={`${a.name}, ${humanSize(a.size)}`} disabled={!online || !!busy}
            onPress={() => void open(a)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, opacity: !online ? 0.55 : pressed ? 0.7 : 1 })}>
            <View style={{ flex: 1 }}>
              <Txt role="bubble" content="user" numberOfLines={1}>{a.name}</Txt>
              <Txt role="caption" tone="inkSoft">{humanSize(a.size)}</Txt>
            </View>
            {busy === a.id ? <ActivityIndicator color={c.inkSoft} /> : <Txt role="meta" tone="inkSoft">{t(lang, 'artifacts.open')} ›</Txt>}
          </Pressable>
        ))}
        {note ? <Txt testID="artifact-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
      </View>
      <Modal visible={!!opened} animationType="slide" onRequestClose={() => setOpened(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: space.l, gap: space.m, borderBottomWidth: 1, borderBottomColor: c.hair }}>
            <Txt role="item" content="user" numberOfLines={1} style={{ flex: 1 }}>{opened?.a.name ?? ''}</Txt>
            <Pressable testID="artifact-close" accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.close')} onPress={() => setOpened(null)} hitSlop={8}
              style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair }}>
              <Txt role="meta">{t(lang, 'artifacts.close')}</Txt>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.l }} maximumZoomScale={opened?.kind === 'image' ? 4 : 1}>
            {opened?.kind === 'image' ? <Image source={{ uri: opened.uri }} accessibilityLabel={opened.a.name} resizeMode="contain" style={{ width: '100%', aspectRatio: 1 }} /> : null}
            {opened?.kind === 'text' ? <MessageText role="assistant" text={opened.text} /> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Sheet>
  )
}
