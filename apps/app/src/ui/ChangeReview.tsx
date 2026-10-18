import { useState } from 'react'
import { View } from 'react-native'
import { BackendError, type Backend } from '../backend/types'
import { t, type Lang } from '../i18n'
import { Button } from './Button'
import { TextField } from './TextField'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

type Mark = { mark: 'accepted' | 'returned'; comment: string }

/**
 * 一个文件的「没问题 / 退回」(2026-10-17,对标 Paseo 手机上审改动):和桌面「改动」面板同一张标记表。
 * 退回必须写一句意见 —— 那句话会连同这份改动投给执行者接着改(同桌面 review-return)。
 */
export function ChangeReview({ matterId, artifactId, path, mark, backend, lang, online, onDone }: {
  matterId: string; artifactId: string; path: string; mark?: Mark
  backend: Pick<Backend, 'reviewMark' | 'reviewReturn'>; lang: Lang; online: boolean; onDone: () => void
}) {
  const { c } = useTheme()
  const [returning, setReturning] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn(); setReturning(false); setComment(''); onDone() }
    catch (e) {
      const code = e instanceof BackendError ? e.code : 'unknown'
      setError(t(lang, code === 'busy' ? 'review.busy' : code === 'session_changed' ? 'review.sessionChanged' : 'review.failed'))
    } finally { setBusy(false) }
  }
  return (
    <View style={{ gap: space.xs }}>
      {mark?.mark === 'accepted' ? <Txt role="caption" tone="inkSoft">{t(lang, 'review.accepted')}</Txt> : null}
      {mark?.mark === 'returned' ? <Txt role="caption" tone="inkSoft">{t(lang, 'review.returned', { c: mark.comment })}</Txt> : null}
      {returning ? (
        <>
          <TextField testID={`review-comment-${path}`} value={comment} onChangeText={setComment} placeholder={t(lang, 'review.placeholder')} multiline maxLength={2000}
            style={{ paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: c.hair }} />
          <View style={{ flexDirection: 'row', gap: space.s }}>
            <Button kind="primary" testID={`review-send-${path}`} label={t(lang, 'review.send')} busy={busy} disabled={!online || !comment.trim()}
              onPress={() => void run(() => backend.reviewReturn({ id: matterId, artifactId, paths: [path], comment: comment.trim() }))} />
            <Button kind="secondary" label={t(lang, 'review.cancel')} disabled={busy} onPress={() => { setReturning(false); setError(null) }} />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: space.s }}>
          {mark?.mark !== 'accepted' ? (
            <Button kind="secondary" testID={`review-accept-${path}`} label={t(lang, 'review.accept')} busy={busy} disabled={!online}
              onPress={() => void run(() => backend.reviewMark({ id: matterId, artifactId, path }))} />
          ) : null}
          <Button kind="secondary" testID={`review-return-${path}`} label={t(lang, 'review.return')} disabled={!online || busy} onPress={() => setReturning(true)} />
        </View>
      )}
      {error ? <Txt role="caption" tone="bad" accessibilityLiveRegion="polite">{error}</Txt> : null}
    </View>
  )
}
