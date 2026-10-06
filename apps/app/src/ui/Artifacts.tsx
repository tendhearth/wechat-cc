import { ActivityIndicator, Pressable, View } from 'react-native'
import type { Backend } from '../backend/types'
import { t, type Lang } from '../i18n'
import { downloadArtifact, humanSize, type ArtifactRef } from '../state/artifact-download'
import { sha256Hex, useFileOpener } from './FileViewer'
import { Sheet } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/**
 * 一件事的成果(2026-10-06,对标 Paseo / Orca 手机上看产出):列出来,点开读(打开方式见 FileViewer)。
 * 读取按块、核对 sha256;电脑上那份中途换了 ⇒ 说一声,不显示半截。
 */
export function Artifacts({ matterId, artifacts, backend, lang, online }: { matterId: string; artifacts: readonly ArtifactRef[]; backend: Pick<Backend, 'artifactChunk'>; lang: Lang; online: boolean }) {
  const { c } = useTheme()
  const opener = useFileOpener(lang)
  if (!artifacts.length) return null
  return (
    <Sheet testID="progress-artifacts" title={t(lang, 'artifacts.title', { n: artifacts.length })} defaultOpen>
      <View style={{ gap: space.s }}>
        {artifacts.map((a, i) => (
          <Pressable key={a.id} testID={`artifact-${i}`} accessibilityRole="button" accessibilityLabel={`${a.name}, ${humanSize(a.size)}`} disabled={!online || !!opener.busyId}
            onPress={() => void opener.open(a, () => downloadArtifact(backend, matterId, a, sha256Hex))}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, opacity: !online ? 0.55 : pressed ? 0.7 : 1 })}>
            <View style={{ flex: 1 }}>
              <Txt role="bubble" content="user" numberOfLines={1}>{a.name}</Txt>
              <Txt role="caption" tone="inkSoft">{humanSize(a.size)}</Txt>
            </View>
            {opener.busyId === a.id ? <ActivityIndicator color={c.inkSoft} /> : <Txt role="meta" tone="inkSoft">{t(lang, 'artifacts.open')} ›</Txt>}
          </Pressable>
        ))}
        {opener.note ? <Txt testID="artifact-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{opener.note}</Txt> : null}
      </View>
      {opener.viewer}
    </Sheet>
  )
}
