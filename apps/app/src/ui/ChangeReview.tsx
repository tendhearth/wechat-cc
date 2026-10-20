import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { BackendError, type Backend, type PhoneChangesTurnT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { uuid } from '../net/uuid'
import { useSubmit } from '../state/hooks'
import { COMMENT_MAX, commentFailure, hunkComments, sendOutcome, type HunkPiece } from '../view/review-comments'
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

/**
 * 行评论(切片 4):一个文件按块显示,每块一个「评论这一块」⇒ 存成草稿(整块评论,手机不选行)。
 * 草稿旁「删」点两下;已发出的写「已发出 · 时间」、只读。按块撤回不上手机。
 * commentId 在打开输入框时生成,存不上 / 不确定时重试沿用同一个(daemon 按它幂等);改了正文或存成了才换新的。
 */
export function HunkComments({ matterId, artifactId, file, pieces, backend, lang, online, onDone }: {
  matterId: string; artifactId: string; file: PhoneChangesTurnT['files'][number]; pieces: HunkPiece[]
  backend: Pick<Backend, 'reviewComment' | 'reviewCommentDelete'>; lang: Lang; online: boolean; onDone: () => void
}) {
  const { c } = useTheme()
  const submit = useSubmit()
  const [editing, setEditing] = useState<number | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ hunk: number; text: string } | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const commentId = useRef<string | null>(null)
  useEffect(() => { if (!armed) return; const tm = setTimeout(() => setArmed(null), 3000); return () => clearTimeout(tm) }, [armed])
  const now = Date.now()
  const open = (hunk: number) => { setEditing(hunk); setBody(''); setNote(null); commentId.current = uuid() }
  const save = async (p: HunkPiece) => {
    const text = body.trim()
    if (!text || busy) return
    const cid = commentId.current ?? (commentId.current = uuid())
    setBusy(true); setNote(null)
    const r = await submit(`review-comment:${matterId}:${cid}`, () => backend.reviewComment({ id: matterId, commentId: cid, artifactId, path: file.path, hunk: p.index, hunkSha256: p.sha256, body: text }))
    setBusy(false)
    const failed = commentFailure(r, lang)
    if (failed) { setNote({ hunk: p.index, text: failed }); if (r !== 'ok' && r !== 'busy' && r.error === 'uncertain') onDone(); return }
    commentId.current = null; setEditing(null); setBody(''); onDone()
  }
  const remove = async (hunk: number, id: string) => {
    if (armed !== id) { setArmed(id); setNote(null); return }
    setArmed(null); setBusy(true)
    const r = await submit(`review-comment-del:${matterId}:${id}`, () => backend.reviewCommentDelete({ id: matterId, commentId: id }))
    setBusy(false)
    const failed = commentFailure(r, lang)
    if (failed) setNote({ hunk, text: failed })
    onDone()
  }
  return (
    <View style={{ gap: space.s }}>
      {pieces.map(p => (
        <View key={p.index} testID={`hunk-${file.path}-${p.index}`} style={{ gap: space.xs }}>
          <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}>
            <Txt role="code" tone="inkSoft">{p.text}</Txt>
          </ScrollView>
          {hunkComments(file, p.index, now, lang).map(row => (
            <View key={row.id} testID={`line-comment-${row.id}`} style={{ borderLeftWidth: 1, borderLeftColor: c.hair, paddingLeft: space.s, gap: space.xs }}>
              <Txt role="small" content="user">{row.body}</Txt>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                {row.meta ? <Txt role="caption" tone="inkSoft">{row.meta}</Txt> : null}
                {row.draft ? (
                  <Pressable testID={`line-comment-delete-${row.id}`} accessibilityRole="button" disabled={!online || busy} onPress={() => void remove(p.index, row.id)}
                    style={{ minHeight: 32, justifyContent: 'center', opacity: !online || busy ? 0.55 : 1 }}>
                    <Txt role="caption" tone={armed === row.id ? 'bad' : 'inkSoft'}>{t(lang, armed === row.id ? 'lineReview.deleteConfirm' : 'lineReview.delete')}</Txt>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
          {editing === p.index ? (
            <>
              <TextField testID={`line-comment-input-${file.path}-${p.index}`} value={body} onChangeText={v => { setBody(v); commentId.current = uuid() }} placeholder={t(lang, 'lineReview.placeholder')} multiline maxLength={COMMENT_MAX}
                style={{ paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: c.hair }} />
              <View style={{ flexDirection: 'row', gap: space.s }}>
                <Button kind="secondary" testID={`line-comment-save-${file.path}-${p.index}`} label={t(lang, 'lineReview.save')} busy={busy} disabled={!online || !body.trim()} onPress={() => void save(p)} />
                <Button kind="secondary" label={t(lang, 'lineReview.cancel')} disabled={busy} onPress={() => { setEditing(null); setNote(null) }} />
              </View>
            </>
          ) : (
            <Pressable testID={`line-comment-open-${file.path}-${p.index}`} accessibilityRole="button" disabled={!online} onPress={() => open(p.index)}
              style={{ minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start', opacity: online ? 1 : 0.55 }}>
              <Txt role="caption" tone="inkSoft">{t(lang, 'lineReview.comment')}</Txt>
            </Pressable>
          )}
          {note?.hunk === p.index ? <Txt role="caption" tone="bad" accessibilityLiveRegion="polite">{note.text}</Txt> : null}
        </View>
      ))}
    </View>
  )
}

/**
 * 「发出 N 条评论」+ 可选「整体说一句」(切片 4):这件事所有草稿一起发给执行者。
 * requestId 一批一个:没发成 / 不确定时重点沿用(daemon 按它去重),发成了才换。
 * 结果那一句交给 onNote(发成后这一块会消失,那句话由页面留着)。
 */
export function CommentsSend({ matterId, label, olderDrafts, backend, lang, online, onNote, onDone }: {
  matterId: string; label: string; olderDrafts: boolean
  backend: Pick<Backend, 'reviewCommentsSend'>; lang: Lang; online: boolean; onNote: (note: { text: string; ok: boolean } | null) => void; onDone: () => void
}) {
  const { c } = useTheme()
  const submit = useSubmit()
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const requestId = useRef(uuid())
  const send = async () => {
    if (busy) return
    setBusy(true); onNote(null)
    let counts: { sent: number; remaining: number; skippedDiscarded: number } | null = null
    const s = summary.trim()
    const r = await submit(`review-send:${matterId}`, async () => { counts = await backend.reviewCommentsSend({ id: matterId, requestId: requestId.current, ...(s ? { summary: s } : {}) }) })
    setBusy(false)
    const out = sendOutcome(r, counts, lang)
    onNote(out)
    if (out.ok) { requestId.current = uuid(); setSummary('') }
    onDone()
  }
  return (
    <View testID="line-comments-send" style={{ gap: space.s, paddingTop: space.s }}>
      <TextField testID="line-comments-summary" value={summary} onChangeText={setSummary} placeholder={t(lang, 'lineReview.summary')} multiline maxLength={COMMENT_MAX}
        style={{ paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: c.hair }} />
      {olderDrafts ? <Txt role="caption" tone="inkSoft">{t(lang, 'lineReview.olderDrafts')}</Txt> : null}
      <Button kind="primary" testID="line-comments-send-button" label={label} busy={busy} disabled={!online} onPress={() => void send()} />
    </View>
  )
}
