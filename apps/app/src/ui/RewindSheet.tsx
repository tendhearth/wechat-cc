import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError, type Backend, type RewindPreviewT } from '../backend/types'
import { t, type Lang } from '../i18n'
import type { SubmitResult } from '../state/store'
import { rewindOutcome, rewindPreviewError, rewindSheet, type RewindOutcome } from '../view/rewind'
import { Button } from './Button'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/**
 * 「撤掉这一轮」的确认页(回退切片 4):打开就拉预览,列出会撤掉什么,「确认撤掉」/「算了」。
 * 工作区刚变过 ⇒ 重拉预览、说「请再看一眼」;超时 ⇒ 不说成了(「不确定电脑那边做完没有」);停住 ⇒ 关掉,详情那句只读提醒接手。
 * 唯一的强调按钮是「确认撤掉」。
 */
export function RewindSheet({ matterId, artifactId, backend, lang, online, submit, onClose, onSettled, onStale }: {
  matterId: string; artifactId: string
  backend: Pick<Backend, 'rewindPreview' | 'rewind'>; lang: Lang; online: boolean
  submit: (key: string, run: () => Promise<void>) => Promise<SubmitResult>
  onClose: () => void
  /** 确认之后(成了 / 不确定 / 停住):调用方关掉确认页、说那句话、重拉详情与改动。 */
  onSettled: (o: RewindOutcome) => void
  /** 工作区刚变过:调用方也重拉改动(可能来了新的一轮,那就该看新的那一轮)。 */
  onStale?: () => void
}) {
  const { c } = useTheme()
  const [preview, setPreview] = useState<RewindPreviewT | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const load = useCallback(async () => {
    setLoadError(null)
    try { const p = await backend.rewindPreview({ id: matterId, artifactId }); if (alive.current) setPreview(p) }
    catch (e) { if (alive.current) { setPreview(null); setLoadError(rewindPreviewError(e instanceof BackendError ? e.code : 'unknown', lang)) } }
  }, [backend, matterId, artifactId, lang])
  useEffect(() => { void load() }, [load])

  const confirm = async () => {
    if (!preview || sending) return
    setSending(true); setNote(null)
    const r = await submit(`rewind:${matterId}`, () => backend.rewind({ id: matterId, artifactId, token: preview.token }))
    if (!alive.current) return
    setSending(false)
    const o = rewindOutcome(r, preview.round, lang)
    if (o.kind === 'stale') { setNote(o.text); onStale?.(); void load(); return }
    if (o.kind === 'error') { setNote(o.text); return }
    onSettled(o)
  }
  const v = preview ? rewindSheet(preview, lang) : null

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
      <Pressable accessibilityLabel={t(lang, 'rewind.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={onClose} />
      <SafeAreaView testID="rewind-sheet" edges={['bottom']} style={{ backgroundColor: c.paper, maxHeight: '85%', borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.xl, gap: space.m }}>
        {v ? (
          <>
            <Txt role="item" accessibilityRole="header">{v.title}</Txt>
            <View style={{ gap: space.s }}>
              <Txt role="bubble">{v.what}</Txt>
              <Txt role="meta" tone="inkSoft">{v.filesHead}</Txt>
              {v.paths.map((p, i) => <Txt key={i} testID={`rewind-path-${i}`} role="code" tone="inkSoft" content="user" selectable>{p}</Txt>)}
              {v.more ? <Txt role="meta" tone="inkSoft">{v.more}</Txt> : null}
              {v.notes.map((n, i) => <Txt key={i} testID={`rewind-note-${i}`} role="meta" tone="inkSoft">{n}</Txt>)}
            </View>
          </>
        ) : (
          <Txt testID="rewind-loading" role="bubble" tone="inkSoft" accessibilityLiveRegion="polite">{loadError ?? t(lang, 'rewind.loading')}</Txt>
        )}
        {note ? <Txt testID="rewind-sheet-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
        {loadError ? <Button kind="secondary" testID="rewind-retry" label={t(lang, 'common.retry')} onPress={() => void load()} /> : null}
        {v ? <Button kind="primary" testID="rewind-confirm" label={t(lang, 'rewind.confirm')} onPress={() => void confirm()} disabled={!online} busy={sending} /> : null}
        <Button kind="secondary" testID="rewind-cancel" label={t(lang, 'rewind.cancel')} onPress={onClose} disabled={sending} />
        </ScrollView>
      </SafeAreaView>
      </View>
    </Modal>
  )
}
