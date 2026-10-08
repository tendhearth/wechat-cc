import { useEffect, useRef, useState } from 'react'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { MatterInputT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { Artifacts } from '../../ui/Artifacts'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery, useSubmit, useTopic } from '../../state/hooks'
import { getDraft, setDraft } from '../../state/drafts'
import { useMatterInputs } from '../../state/useMatterInputs'
import type { InputSnapshot } from '../../state/matter-inputs'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Dot } from '../../ui/Dot'
import { MessageText } from '../../ui/Markdown'
import { InputReceipts } from '../../ui/InputReceipts'
import { SayBar } from '../../ui/SayBar'
import { Sheet } from '../../ui/Sheet'
import { StatusPill } from '../../ui/StatusPill'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { isOwnerChatMatter } from '../../view/chat'
import { conversationView } from '../../view/conversation'
import { nativeStartLines, providerName } from '../../view/continue'
import { canSubmit } from '../../view/connection'
import { HANDOFF_RECHECK, handoffBlock, handoffErrorDot, handoffErrorText, handoffSheetLines } from '../../view/handoff'
import { uuid } from '../../net/uuid'
import { progressView, canStop } from '../../view/progress'
import { inputRows } from '../../view/matter-input'

const NO_INPUTS: readonly MatterInputT[] = []

// 进展页:状态标签在「CC 的进展」概括之上;概括没到时用骨架占位;下面是这件事的真对话。
// 主人自己那条聊天(只认它,Ruling 9)改道去 /chat;访客的聊天照常显示。
export default function Matter() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const params = useLocalSearchParams<{ id: string }>()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  // 打开就拉新:有缓存也重拉详情与概括(旧缓存先摆着,拿到新的再换)。
  const detail = useQuery(`matter:${id}`, l => backend.matter(id, l), { refreshOnMount: true })
  const localInputs = useMatterInputs(id, detail.data?.inputs ?? NO_INPUTS)
  const inputReceipts = inputRows(detail.data?.inputs ?? NO_INPUTS, localInputs)
  const insight = useQuery(`insight:${id}`, l => backend.insight(id, l), { refreshOnMount: true })
  const changes = useQuery(`changes:${id}`, () => backend.changes(id))
  const isChat = detail.data?.matter.kind === 'chat'
  // 只有聊天类才需要知道主人对话是哪一件;与 /chat、一起做共用同一份缓存
  const ownerChat = useQuery('chat:latest', () => backend.chat({}), { enabled: isChat })
  const ver = useTopic<{ version?: unknown }>(`matter/${id}`)
  const seen = useRef<unknown>(undefined)
  const verKey = ver === undefined ? undefined : JSON.stringify(ver)
  // 额度用完 ⇒ 交给另一位继续(spec continue-sessions §7-3):确认卡、提交、失败那一句。requestId 每次点开卡换一个,
  // 卡里重试沿用同一个(daemon 按它去重;一件事也只交一次,换了 requestId 也回已交出的那件)。
  const conn = useConnection()
  const submit = useSubmit()
  const [sheet, setSheet] = useState(false)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<{ text: string; dot: 'bad' | 'warn' | 'unknown' } | null>(null)
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const [openErrors, setOpenErrors] = useState<ReadonlySet<number>>(() => new Set())
  // 停下这一轮(2026-10-06):点一下先「再点一次」(3 秒内),免得手滑停掉在跑的活;只停手机看到的那一轮(runId)。
  const [stopArmed, setStopArmed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)
  const [wtArmed, setWtArmed] = useState<'remove' | 'merge' | null>(null)
  const [wtBusy, setWtBusy] = useState(false)
  const [wtNote, setWtNote] = useState<string | null>(null)
  useEffect(() => { if (!stopArmed) return; const tm = setTimeout(() => setStopArmed(false), 3000); return () => clearTimeout(tm) }, [stopArmed])
  const handoffReq = useRef('')
  const idRef = useRef(id)
  idRef.current = id
  useEffect(() => { setSheet(false); setFailure(null); setInputNotice(null); setOpenErrors(new Set()); setStopArmed(false); setStopNote(null) }, [id])
  const { refresh: refreshDetail } = detail
  const { refresh: refreshInsight } = insight
  const { refresh: refreshChanges } = changes
  useEffect(() => {
    if (verKey === undefined) return
    if (seen.current !== undefined && seen.current !== verKey) {
      void refreshDetail(); void refreshInsight(); void refreshChanges()
    }
    seen.current = verKey
  }, [verKey, refreshDetail, refreshInsight, refreshChanges])

  const header = (
    <>
      <TopBar title={t(lang, 'common.wordmark')} onBack={() => router.back()} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
    </>
  )
  const ownerChatId = ownerChat.data?.matterId ?? null
  if (detail.data && isOwnerChatMatter(detail.data.matter, ownerChatId)) return <Redirect href="/chat" />
  // 聊天类但还不知道主人对话是哪件:等一下再决定改不改道(读失败 / 没主人 ⇒ 当普通的事显示)
  const decidingChat = isChat && ownerChatId === null && !ownerChat.error
  if (!detail.data || decidingChat) {
    return (
      <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
        {header}
        <Txt tone="inkSoft" style={{ padding: space.xl }}>{detail.error && !detail.data ? t(lang, 'progress.loadFailed') : t(lang, 'progress.loading')}</Txt>
      </SafeAreaView>
    )
  }
  const d = detail.data
  const v = progressView(d, insight.data ?? null, changes.data ?? null, !!insight.error && !insight.data)
  const files = changes.data?.files ?? []
  const conv = conversationView(d.events)
  const hb = handoffBlock(d.quotaHandoff, lang, Date.now())
  const online = canSubmit(conn)
  const stop = async () => {
    const runId = d.runId
    if (!runId || stopping) return
    if (!stopArmed) { setStopArmed(true); setStopNote(null); return }
    setStopArmed(false); setStopping(true)
    const r = await submit(`stop:${id}`, () => backend.stop({ id, runId }))
    setStopping(false)
    if (r !== 'ok') setStopNote(t(lang, r !== 'busy' && r.error === 'input_stale' ? 'progress.stopStale' : 'progress.stopFailed'))
    void refreshDetail()
  }
  // 独立工作区(2026-10-07):提交到分支 / 合回项目(10-08,只快进)/ 删除工作区;合回、删除都点两下。
  const worktreeAct = async (action: 'commit' | 'remove' | 'merge') => {
    if (wtBusy) return
    if (action !== 'commit' && wtArmed !== action) { setWtArmed(action); setWtNote(null); return }
    setWtArmed(null); setWtBusy(true); setWtNote(null)
    const r = await submit(`worktree:${id}:${action}`, async () => { await backend.worktree({ id, action }) })
    setWtBusy(false)
    const err = r === 'ok' || r === 'busy' ? null : r.error
    if (r === 'ok') setWtNote(t(lang, action === 'commit' ? 'progress.wtCommitted' : action === 'merge' ? 'progress.wtMerged' : 'progress.wtRemoved'))
    else if (err === 'worktree_dirty') setWtNote(t(lang, 'progress.wtDirty'))
    else if (err === 'worktree_uncommitted') setWtNote(t(lang, 'progress.wtUncommitted'))
    else if (err === 'merge_manual') setWtNote(t(lang, 'progress.wtMergeManual'))
    else if (err === 'project_busy') setWtNote(t(lang, 'progress.wtProjectBusy'))
    else setWtNote(t(lang, r === 'busy' || err === 'busy' ? (action === 'remove' ? 'progress.wtBusyRemove' : 'progress.wtBusyCommit') : 'progress.wtFailed'))
    void refreshDetail()
  }
  const openHandoff = () => { handoffReq.current = uuid(); setFailure(null); setSheet(true) }
  const confirmHandoff = async () => {
    const h = d.quotaHandoff
    if (sending || h?.state !== 'offer') return
    const myId = id
    setSending(true); setFailure(null)
    const box: { id: string | null } = { id: null }
    const r = await submit(`handoff:${myId}`, async () => { box.id = (await backend.handoff({ id: myId, requestId: handoffReq.current, providerId: h.to })).matterId })
    setSending(false)
    if (idRef.current !== myId || r === 'busy') return
    if (r === 'ok' && box.id) {
      // daemon 回成功之前页面上不出现任何「在跑」;成了就进新那件,返回是原来这件(现在说「已经交给 X 继续」)
      setSheet(false); void refreshDetail()
      router.push(`/matter/${encodeURIComponent(box.id)}`)
      return
    }
    const code = r === 'ok' ? 'unknown' : r.error
    setFailure({ text: handoffErrorText(code, lang), dot: handoffErrorDot(code) })
    if (HANDOFF_RECHECK.has(code)) void refreshDetail()
  }
  const restoreInput = (row: InputSnapshot) => {
    const draft = getDraft(id)
    if (draft.trim() && draft !== row.rawText) { setInputNotice(t(lang, 'input.draftProtected')); return }
    setDraft(id, row.rawText)
    router.push(`/compose?matter=${encodeURIComponent(id)}`)
  }
  const failureRow = failure ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind={failure.dot} size={8} />
      <Txt testID="handoff-error" role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{failure.text}</Txt>
    </View>
  ) : null

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      {header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        <Txt role="small" tone="inkSoft">{t(lang, 'progress.breadcrumb')}</Txt>
        <Txt role="title" content="user" accessibilityRole="header">{v.title}</Txt>
        <View testID="progress-status"><StatusPill status={v.status} /></View>
        {d.task?.error === 'execution_model_unsupported' ? <Txt testID="progress-model-guidance" role="meta" tone="inkSoft">{t(lang, 'progress.modelUnavailable')}</Txt> : null}
        {d.nativeStart ? (
          // 接过来、还没发第一句的电脑会话(spec D12):第一句会怎样 + 先让原来那个停下;发过第一句就没有了
          <View testID="progress-native-start" style={{ gap: space.xs }}>
            {nativeStartLines(d.nativeStart, lang).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
          </View>
        ) : null}

        <Card style={{ gap: space.m }}>
          <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'progress.ccProgress')}</Txt>
          {v.summaryState === 'failed' ? (
            <Pressable testID="progress-summary" accessibilityRole="button" accessibilityLabel={t(lang, 'progress.summaryUnavailable')} onPress={() => void insight.refresh()}>
              <Txt role="bubble" tone="inkSoft">{t(lang, 'progress.summaryUnavailable')}</Txt>
            </Pressable>
          ) : v.summaryState === 'loading' ? (
            <View testID="progress-summary" accessibilityLabel={t(lang, 'progress.loading')} style={{ gap: space.s }}>
              <View style={{ height: 14, borderRadius: 7, backgroundColor: c.hair, width: '92%' }} />
              <View style={{ height: 14, borderRadius: 7, backgroundColor: c.hair, width: '70%' }} />
            </View>
          ) : v.summaryState === 'none' ? (
            <Txt testID="progress-summary" role="bubble" tone="inkSoft">{t(lang, 'progress.noSummary')}</Txt>
          ) : (
            <Txt testID="progress-summary" role="body" content="user">{v.summary}</Txt>
          )}
          {v.steps.map((s, i) => (
            <View key={i} accessible accessibilityLabel={`${s.done ? t(lang, 'progress.stepDone') : t(lang, 'progress.stepWaiting')}: ${s.title}${s.detail ? `, ${s.detail}` : ''}`}
              style={{ flexDirection: 'row', gap: space.m, alignItems: 'flex-start', paddingTop: space.m, borderTopWidth: 1, borderTopColor: c.hair }}>
              {/* 状态色只上点:做完 = 绿点,等你 = 琥珀点 */}
              <View style={{ paddingTop: space.s }}><Dot kind={s.done ? 'ok' : 'warn'} size={8} /></View>
              <View style={{ flex: 1 }}>
                <Txt role="bubble" content="user">{s.title}</Txt>
                {s.detail ? <Txt role="meta" tone="inkSoft" content="user">{s.detail}</Txt> : null}
              </View>
            </View>
          ))}
        </Card>

        <Card testID="progress-conversation" style={{ gap: space.m }}>
          <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'progress.conversation')}</Txt>
          {conv.length === 0 ? <Txt role="meta" tone="inkSoft">{t(lang, 'progress.noEvents')}</Txt> : null}
          {conv.map((e, i) =>
            e.kind === 'steps' ? (
              <Txt key={i} role="small" tone="inkSoft" numberOfLines={1}>
                {t(lang, 'progress.stepsN', { n: e.count ?? 1 })} · {e.text}
              </Txt>
            ) : e.kind === 'error' ? (
              <View key={i} style={{ flexDirection: 'row', gap: space.s, alignItems: 'flex-start' }}>
                <View style={{ paddingTop: space.s }}><Dot kind="warn" size={8} /></View>
                <View style={{ flex: 1, gap: space.s }}>
                  <Txt role="meta" tone="inkSoft" content="user">{e.text}</Txt>
                  {e.diagnostic ? <>
                    <Pressable testID={`progress-error-raw-toggle-${i}`} accessibilityRole="button" accessibilityState={{ expanded: openErrors.has(i) }} accessibilityLabel={t(lang, 'progress.rawError')} onPress={() => setOpenErrors(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })} style={{ minHeight: 36, justifyContent: 'center' }}>
                      <Txt role="small" tone="inkSoft" style={{ textDecorationLine: 'underline' }}>{t(lang, 'progress.rawError')}</Txt>
                    </Pressable>
                    {openErrors.has(i) ? <Txt testID={`progress-error-raw-${i}`} role="code" tone="inkSoft" content="user" selectable>{e.diagnostic}</Txt> : null}
                  </> : null}
                </View>
              </View>
            ) : (
              <View key={i} style={{ alignItems: e.kind === 'me' ? 'flex-end' : 'flex-start' }}>
                {/* 「我」靠右、CC 靠左;说话人独立一行,原文按钮和链接各自可访问 */}
                <View style={{ maxWidth: '88%', gap: space.xs }}>
                  <Txt role="caption" tone="inkSoft" style={{ textAlign: e.kind === 'me' ? 'right' : 'left' }}>{t(lang, e.kind === 'me' ? 'chat.me' : 'cc.label')}</Txt>
                  <MessageText role={e.kind === 'me' ? 'user' : 'assistant'} text={e.text} typeRole="bubble" userAlign="right" />
                </View>
              </View>
            ),
          )}
        </Card>

        {inputReceipts.length ? <InputReceipts rows={inputReceipts} onRestore={restoreInput} /> : null}
        {inputNotice ? <Txt role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{inputNotice}</Txt> : null}
        {canStop(d) ? (
          <Button kind="secondary" testID="progress-stop" label={t(lang, stopArmed ? 'progress.stopConfirm' : 'progress.stop')} onPress={() => void stop()} disabled={!online} busy={stopping} />
        ) : null}
        {stopNote ? <Txt testID="progress-stop-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{stopNote}</Txt> : null}
        {d.task?.worktree ? (
          <View testID="progress-worktree" style={{ gap: space.s }}>
            <Txt role="meta" tone="inkSoft">{t(lang, d.task.worktree.removed ? 'progress.wtGone' : d.task.worktree.merged ? 'progress.wtOnMerged' : 'progress.wtOn', { branch: d.task.worktree.branch })}</Txt>
            {!d.task.worktree.removed ? (
              <View style={{ flexDirection: 'row', gap: space.s, flexWrap: 'wrap' }}>
                <Button kind="secondary" testID="progress-wt-commit" label={t(lang, 'progress.wtCommit')} onPress={() => void worktreeAct('commit')} disabled={!online} busy={wtBusy} />
                {d.task.workspace?.mode !== 'isolated' ? <Button kind="secondary" testID="progress-wt-merge" label={t(lang, wtArmed === 'merge' ? 'progress.wtMergeConfirm' : 'progress.wtMerge')} onPress={() => void worktreeAct('merge')} disabled={!online || wtBusy} /> : null}
                <Button kind="secondary" testID="progress-wt-remove" label={t(lang, wtArmed === 'remove' ? 'progress.wtRemoveConfirm' : 'progress.wtRemove')} onPress={() => void worktreeAct('remove')} disabled={!online || wtBusy} />
              </View>
            ) : null}
            {wtNote ? <Txt testID="progress-wt-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{wtNote}</Txt> : null}
          </View>
        ) : null}
        {v.pendingCount > 0 ? (
          <Button kind="primary" testID="progress-view-approval" label={t(lang, 'progress.viewApproval')} onPress={() => router.push(`/approval/${encodeURIComponent(d.task?.id ?? id)}`)} />
        ) : null}

        {d.artifacts.length ? <Artifacts matterId={id} artifacts={d.artifacts} backend={backend} lang={lang} online={online} /> : null}

        <Sheet testID="progress-changes" title={t(lang, 'progress.viewChangesN', { n: v.changedFiles })}>
            {files.length === 0 ? <Txt role="meta" tone="inkSoft">{t(lang, 'progress.noChanges')}</Txt> : null}
            {files.map((f, i) => (
              <View key={i} style={{ paddingVertical: space.s, gap: space.xs }}>
                <Txt role="code">{f.path}</Txt>
                {f.kind === 'not_reviewed' ? (
                  <>
                    <Txt role="small" tone="inkSoft">{t(lang, 'progress.notReviewed')}</Txt>
                    {f.reason ? <Txt role="caption" tone="inkSoft">{f.reason}</Txt> : null}
                  </>
                ) : f.truncated ? (
                  <Txt role="small" tone="inkSoft">{t(lang, 'progress.tooBig')}</Txt>
                ) : f.diff ? (
                  <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
                    <Txt role="code" tone="inkSoft">{f.diff}</Txt>
                  </ScrollView>
                ) : f.reason ? (
                  <Txt role="small" tone="inkSoft">{f.reason}</Txt>
                ) : null}
              </View>
            ))}
          </Sheet>

        <Sheet testID="progress-process" title={t(lang, 'progress.viewProcess')}>
            <View style={{ gap: space.s }}>
              {d.task ? (
                <>
                  <Txt role="meta">{t(lang, 'progress.executor')}: {d.task.providerId}</Txt>
                  <Txt role="code">{t(lang, 'progress.path')}: {d.task.path}</Txt>
                </>
              ) : <Txt role="meta" tone="inkSoft">{t(lang, 'progress.noEvents')}</Txt>}
            </View>
          </Sheet>
      </ScrollView>
      {hb.kind === 'none' ? null : (
        // 额度用完那一块:状态只上点(琥珀),文字一律 inkSoft;唯一的强调按钮是「交给 X 继续」
        <View testID="progress-handoff" style={{ paddingHorizontal: space.xl, paddingBottom: space.s, gap: space.s }}>
          {hb.kind === 'handed' ? (
            <>
              <Txt testID="progress-handoff-note" role="meta" tone="inkSoft">{hb.note}</Txt>
              <Button kind="secondary" testID="progress-handoff-open" label={hb.open} onPress={() => router.push(`/matter/${encodeURIComponent(hb.matterId)}`)} />
            </>
          ) : (
            <>
              {(hb.kind === 'offer' ? [hb.note] : hb.lines).map((line, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                  {i === 0 ? <Dot kind="warn" size={8} /> : <View style={{ width: 8 }} />}
                  <Txt testID={i === 0 ? 'progress-handoff-note' : undefined} role="meta" tone="inkSoft" style={{ flex: 1 }}>{line}</Txt>
                </View>
              ))}
              {hb.kind === 'offer' ? <Button kind="primary" testID="progress-handoff-action" label={hb.action} onPress={openHandoff} disabled={!online} /> : null}
              {sheet ? null : failureRow}
            </>
          )}
        </View>
      )}
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="progress-say" placeholder={t(lang, 'progress.continueSay')} onPress={() => router.push(`/compose?matter=${encodeURIComponent(id)}`)} />
      </View>

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable accessibilityLabel={t(lang, 'handoff.later')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setSheet(false)} />
        <View testID="handoff-sheet" style={{ backgroundColor: c.paper, padding: space.xl, gap: space.m, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
          {d.quotaHandoff?.state === 'offer' ? (
            <>
              <Txt role="item" accessibilityRole="header">{t(lang, 'handoff.title', { to: providerName(d.quotaHandoff.to, lang) })}</Txt>
              {handoffSheetLines(d.quotaHandoff, lang, Date.now()).map((line, i) => <Txt key={i} testID={`handoff-line-${i}`} role="bubble">{line}</Txt>)}
              {failureRow}
              <Button kind="primary" testID="handoff-confirm" label={hb.kind === 'offer' ? hb.action : ''} onPress={() => void confirmHandoff()} disabled={!online} busy={sending} />
            </>
          ) : (
            // 卡开着时电脑那边变了(额度恢复 / 已经交出去 / 没人能接):收起主按钮,只说为什么
            <>{failureRow ?? <Txt testID="handoff-sheet-note" role="bubble" tone="inkSoft">{t(lang, 'handoff.changed')}</Txt>}</>
          )}
          <Button kind="secondary" testID="handoff-cancel" label={t(lang, 'handoff.later')} onPress={() => setSheet(false)} />
        </View>
      </Modal>
    </SafeAreaView>
  )
}
