import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { MatterInputT } from '../../backend/types'
import { t } from '../../i18n'
import { conversationText } from '../../i18n/minimal-conversation'
import { useLang } from '../../i18n/useLang'
import { Artifacts } from '../../ui/Artifacts'
import { ChangeReview, CommentsSend, HunkComments } from '../../ui/ChangeReview'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery, useSubmit, useTopic } from '../../state/hooks'
import { getDraft, setDraft } from '../../state/drafts'
import { useMatterInputs } from '../../state/useMatterInputs'
import type { InputSnapshot } from '../../state/matter-inputs'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Dot } from '../../ui/Dot'
import { MessageText } from '../../ui/Markdown'
import { InputReceipts } from '../../ui/InputReceipts'
import { SayBar } from '../../ui/SayBar'
import { Expansion } from '../../ui/Sheet'
import { StatusPill } from '../../ui/StatusPill'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { AgentAvatars } from '../../ui/AgentAvatars'
import { agentsLabel, matterAgents } from '../../view/agents'
import { OriginMark } from '../../ui/OriginMark'
import { matterOrigin, originKey } from '../../view/origin'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { isOwnerChatMatter } from '../../view/chat'
import { conversationView, type ConvItem } from '../../view/conversation'
import { nativeStartLines, providerName } from '../../view/continue'
import { canSubmit } from '../../view/connection'
import { HANDOFF_RECHECK, handoffBlock, handoffErrorDot, handoffErrorText, handoffSheetLines } from '../../view/handoff'
import { uuid } from '../../net/uuid'
import { progressView, canStop, changesCoverage } from '../../view/progress'
import { inputRows } from '../../view/matter-input'
import { untilLine } from '../../view/until'
import { scriptOutcome, scriptsBlock } from '../../view/worktree-scripts'
import { usageLine } from '../../view/usage'
import { canOfferRewind, discardedLines, rewindBlockedNotice } from '../../view/rewind'
import { RewindSheet } from '../../ui/RewindSheet'
import { canComment, fileHunks, sendBlock } from '../../view/review-comments'

const NO_INPUTS: readonly MatterInputT[] = []

// 事项先呈现具体请求与成果,概括、过程和执行管理按需展开。
// 主人自己那条聊天(只认它,Ruling 9)改道去 /chat;访客的聊天照常显示。
/** 在跑时详情至多这么久拉一次(主题每 ~150ms 一跳)。 */
const DETAIL_REFRESH_MS = 1000

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
  // 工作区脚本(2026-10-20):运行 / 停下之后那一句
  const [scriptBusy, setScriptBusy] = useState(false)
  const [scriptNote, setScriptNote] = useState<string | null>(null)
  // 撤掉这一轮(回退切片 4):确认页开着没有、确认之后那一句(成了 / 不确定 / 停住)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [rewindNote, setRewindNote] = useState<string | null>(null)
  // 行评论(切片 4):「发出评论」之后那一句(发成后发出那一块会消失,这句留着)
  const [commentsNote, setCommentsNote] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => { if (!stopArmed) return; const tm = setTimeout(() => setStopArmed(false), 3000); return () => clearTimeout(tm) }, [stopArmed])
  const handoffReq = useRef('')
  const idRef = useRef(id)
  idRef.current = id
  useEffect(() => { setSheet(false); setFailure(null); setInputNotice(null); setOpenErrors(new Set()); setStopArmed(false); setStopNote(null); setRewindOpen(false); setRewindNote(null); setCommentsNote(null); setScriptNote(null) }, [id])
  const { refresh: refreshDetail } = detail
  const { refresh: refreshInsight } = insight
  const { refresh: refreshChanges } = changes
  // 主题在跑的时候大约每 150ms 变一次(逐字流):详情至多 1 秒拉一次(最后一次一定拉到);
  // 进展摘要和改动只在阶段变了(开始 / 停下 / 等你)时才重拉,免得每一截文字都多两个请求。
  const lastPhase = useRef<unknown>(undefined)
  const detailTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastDetailAt = useRef(0)
  useEffect(() => () => { if (detailTimer.current) clearTimeout(detailTimer.current) }, [])
  useEffect(() => {
    if (verKey === undefined) return
    const phase = (ver as { phase?: unknown } | undefined)?.phase
    if (seen.current !== undefined && seen.current !== verKey) {
      const wait = Math.max(0, DETAIL_REFRESH_MS - (Date.now() - lastDetailAt.current))
      if (!detailTimer.current) {
        detailTimer.current = setTimeout(() => { detailTimer.current = null; lastDetailAt.current = Date.now(); void refreshDetail() }, wait)
      }
      if (phase !== lastPhase.current) { void refreshInsight(); void refreshChanges() }
    }
    seen.current = verKey
    lastPhase.current = phase
  }, [verKey, ver, refreshDetail, refreshInsight, refreshChanges])

  const header = (
    <>
      <TopBar title={t(lang, 'together.title')} onBack={() => router.back()} />
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
  const untilRow = d.task?.until ? untilLine(d.task.until, lang) : null
  const scripts = scriptsBlock(d.task?.worktree, lang)
  const usage = usageLine(d.task?.usage, lang)
  const rewindBlocked = rewindBlockedNotice(d.task, lang)
  const turn = changes.data ?? null
  const gone = discardedLines(turn, lang)
  // 只审了一部分 / 记录不完整 / 放不下的文件:不能看起来和查全了的一轮一样(2026-10-20)
  const coverage = changesCoverage(turn, lang)
  const agents = matterAgents(d)
  // 出生地(2026-10-19):只画建这件事的那个表面;不知道 ⇒ 不画
  const origin = matterOrigin(d.matter.origin)
  const files = changes.data?.files ?? []
  const sendRow = sendBlock(turn, lang)
  const conv = conversationView(d.events)
  // Events from older daemons have no run identity. This is the latest conversation,
  // never a manufactured completion summary; earlier replies stay behind their own fold.
  const latestUser = conv.findLastIndex(e => e.kind === 'me')
  const recent = conv.slice(Math.max(0, latestUser))
  const earlier = conv.slice(0, Math.max(0, latestUser)).filter(e => e.kind === 'me' || e.kind === 'cc')
  const latest = conv.at(-1)
  const activity = canStop(d) && latest?.kind === 'steps' && latest.running ? latest : null
  const currentError = latest?.kind === 'error' ? latest : null
  const hb = handoffBlock(d.quotaHandoff, lang, Date.now(), d.matter.agentNames)
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
  const worktreeAct = async (action: 'commit' | 'remove' | 'merge' | 'reopen') => {
    if (wtBusy) return
    if ((action === 'remove' || action === 'merge') && wtArmed !== action) { setWtArmed(action); setWtNote(null); return }
    setWtArmed(null); setWtBusy(true); setWtNote(null)
    let mergedNow = true
    const r = await submit(`worktree:${id}:${action}`, async () => { mergedNow = (await backend.worktree({ id, action })).merged !== false })
    setWtBusy(false)
    const err = r === 'ok' || r === 'busy' ? null : r.error
    if (r === 'ok') setWtNote(t(lang, action === 'commit' ? 'progress.wtCommitted' : action === 'merge' ? (mergedNow ? 'progress.wtMerged' : 'progress.wtNothingToMerge') : action === 'reopen' ? 'progress.wtReopened' : 'progress.wtRemoved'))
    else if (err === 'worktree_dirty') setWtNote(t(lang, 'progress.wtDirty'))
    else if (err === 'worktree_uncommitted') setWtNote(t(lang, 'progress.wtUncommitted'))
    else if (err === 'merge_manual') setWtNote(t(lang, 'progress.wtMergeManual'))
    else if (err === 'project_busy') setWtNote(t(lang, 'progress.wtProjectBusy'))
    else if (err === 'worktree_branch_missing') setWtNote(t(lang, 'progress.wtBranchMissing'))
    else setWtNote(t(lang, r === 'busy' || err === 'busy' ? (action === 'remove' ? 'progress.wtBusyRemove' : 'progress.wtBusyCommit') : 'progress.wtFailed'))
    void refreshDetail()
  }
  // 工作区脚本(2026-10-20):运行不用点两下(批准已在电脑上做过);停下本来就安全。超时 ⇒ 不说成了。
  const scriptAct = async (action: 'run' | 'stop') => {
    if (scriptBusy) return
    setScriptBusy(true); setScriptNote(null)
    const box: { run?: string } = {}
    const r = await submit(`worktree-script:${id}`, async () => { box.run = (await backend.worktreeScript({ id, action })).run })
    setScriptBusy(false)
    setScriptNote(scriptOutcome(action, r, box, lang))
    void refreshDetail()
  }
  // 另做一份(2026-10-08):同样的要求、同一个项目、独立工作区,交给另一位执行者;最初那句要求在最近的记录里就带上,不在就留给主人写
  const forkToAnother = (projectId: string, from: string) => {
    const key = `fork:${id}`
    const first = d.events.find(e => e.kind === 'user')?.text
    if (first && !getDraft(key).trim()) setDraft(key, first)
    router.push(`/compose?fork=${encodeURIComponent(id)}&project=${encodeURIComponent(projectId)}&exclude=${encodeURIComponent(from)}`)
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
        <Txt role="title" content="user" accessibilityRole="header">{v.title}</Txt>
        <View testID="progress-status"><StatusPill status={v.status} /></View>
        {untilRow ? (
          // 直到…通过(10-20):状态在前、不截(命令再长也看得见结果);命令等宽,这里不是确认处,可以截;整句给读屏
          <View testID="progress-until" accessible accessibilityLabel={untilRow.accessibilityLabel} style={{ gap: 2 }}>
            <Txt testID="progress-until-status" role="meta" tone="inkSoft">{untilRow.status}</Txt>
            <Txt role="meta" tone="inkSoft" numberOfLines={2}>
              {untilRow.before}<Txt role="code" tone="ink" content="user">{untilRow.command}</Txt>{untilRow.after}
            </Txt>
          </View>
        ) : null}
        {rewindBlocked ? (
          // 回退停住(needs_owner):只读一句,没有按钮 —— 拍板只在电脑上
          <View testID="progress-rewind-blocked" style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
            <Dot kind="warn" size={8} />
            <Txt role="meta" tone="inkSoft" style={{ flex: 1 }}>{rewindBlocked}</Txt>
          </View>
        ) : null}
        {d.task?.error === 'execution_model_unsupported' ? <Txt testID="progress-model-guidance" role="meta" tone="inkSoft">{t(lang, 'progress.modelUnavailable')}</Txt> : null}
        {d.nativeStart ? (
          // 接过来、还没发第一句的电脑会话(spec D12):第一句会怎样 + 先让原来那个停下;发过第一句就没有了
          <View testID="progress-native-start" style={{ gap: space.xs }}>
            {nativeStartLines(d.nativeStart, lang, d.matter.agentNames).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
          </View>
        ) : null}

        {d.runId ? [...d.permissions.map(p => ({ id: p.id, label: insight.data?.explanations[p.id]?.title || p.description.split('\n')[0] || p.tool, permission: true })),
          ...d.questions.map(q => ({ id: q.id, label: q.questions[0]?.question || q.questions[0]?.header || t(lang, 'approval.kindQuestion'), permission: false }))].map((request, i) => (
          <Pressable key={request.id} testID={`progress-request-${i}`} accessibilityRole="button"
            accessibilityLabel={`${t(lang, request.permission ? 'approval.kindPermission' : 'approval.kindQuestion')}: ${request.label}`}
            onPress={() => router.push(`/approval/${encodeURIComponent(d.task?.id ?? id)}?request=${encodeURIComponent(request.id)}`)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: space.m, paddingVertical: space.m, opacity: pressed ? 0.7 : 1 })}>
            <Icon name={request.permission ? 'shield' : 'help'} color={c.inkSoft} />
            <Txt role="bubble" content="user" style={{ flex: 1 }}>{request.label}</Txt>
            <Icon name="chevronRight" color={c.inkSoft} />
          </Pressable>
        )) : null}
        <View testID="progress-latest-conversation" style={{ gap: space.l }}>
          {recent.filter(e => e.kind === 'me' || e.kind === 'cc').map((e, i) => <ConversationMessage key={i} event={e} />)}
        </View>
        {activity ? <Txt testID="progress-activity-now" role="meta" tone="inkSoft" selectable>{t(lang, 'progress.stepNow')} · {activity.text}</Txt> : null}
        {currentError ? <Txt testID="progress-current-error" role="body" tone="inkSoft" selectable>{currentError.text}</Txt> : null}
        {d.artifacts.length ? <Artifacts matterId={id} artifacts={d.artifacts} backend={backend} lang={lang} online={online} /> : null}

        {earlier.length ? <DetailSection key={`earlier:${id}`} testID="progress-earlier" title={conversationText(lang, 'earlier')}>
          <View testID="progress-earlier-conversation" style={{ gap: space.l }}>{earlier.map((e, i) => <ConversationMessage key={i} event={e} />)}</View>
        </DetailSection> : null}

        <DetailSection key={`summary:${id}`} testID="progress-summary-toggle" title={conversationText(lang, 'summary')}>
          <View style={{ gap: space.m }}>
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
                style={{ flexDirection: 'row', gap: space.m, alignItems: 'flex-start', paddingTop: space.m }}>
                {/* 状态色只上点:做完 = 绿点,等你 = 琥珀点 */}
                <View style={{ paddingTop: space.s }}><Dot kind={s.done ? 'ok' : 'warn'} size={8} /></View>
                <View style={{ flex: 1 }}>
                  <Txt role="bubble" content="user">{s.title}</Txt>
                  {s.detail ? <Txt role="meta" tone="inkSoft" content="user">{s.detail}</Txt> : null}
                </View>
              </View>
            ))}
          </View>
        </DetailSection>

        <DetailSection key={`process:${id}`} testID="progress-process" title={conversationText(lang, 'process')}>
          <View testID="progress-conversation" style={{ gap: space.m }}>
            <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'progress.conversation')}</Txt>
            {conv.length === 0 ? <Txt role="meta" tone="inkSoft">{t(lang, 'progress.noEvents')}</Txt> : null}
            {conv.map((e, i) =>
              e.kind === 'steps' ? (
                <Txt key={i} testID={e.running && i === conv.length - 1 ? 'progress-step-now' : undefined} role="small" tone={e.running && i === conv.length - 1 ? 'ink' : 'inkSoft'} numberOfLines={1}>
                  {e.running && i === conv.length - 1 ? `${t(lang, 'progress.stepNow')} · ` : ''}{t(lang, 'progress.stepsN', { n: e.count ?? 1 })} · {e.text}
                </Txt>
              ) : e.kind === 'error' ? (
                <View key={i} style={{ flexDirection: 'row', gap: space.s, alignItems: 'flex-start' }}>
                  <View style={{ paddingTop: space.s }}><Dot kind="warn" size={8} /></View>
                  <View style={{ flex: 1, gap: space.s }}>
                    <Txt role="meta" tone="inkSoft" content="user">{e.text}</Txt>
                    {e.diagnostic ? <>
                      <Pressable testID={`progress-error-raw-toggle-${i}`} accessibilityRole="button" accessibilityState={{ expanded: openErrors.has(i) }} accessibilityLabel={t(lang, 'progress.rawError')} onPress={() => setOpenErrors(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })} style={{ minHeight: 44, justifyContent: 'center' }}>
                        <Txt role="small" tone="inkSoft" style={{ textDecorationLine: 'underline' }}>{t(lang, 'progress.rawError')}</Txt>
                      </Pressable>
                      {openErrors.has(i) ? <Txt testID={`progress-error-raw-${i}`} role="code" tone="inkSoft" content="user" selectable>{e.diagnostic}</Txt> : null}
                    </> : null}
                  </View>
                </View>
              ) : null,
            )}
          </View>
          <View testID="progress-execution-details" style={{ gap: space.m }}>
            {agents.length || origin ? (
              <View testID="progress-agents" style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                <OriginMark origin={origin} size={18} testID="progress-origin" />
                <AgentAvatars ids={agents} names={d.matter.agentNames} size={28} />
                <Txt role="small" tone="inkSoft" style={{ flex: 1 }} numberOfLines={1}>{[agentsLabel(agents, d.matter.agentNames), origin ? t(lang, originKey(origin)) : ''].filter(Boolean).join(' · ')}</Txt>
              </View>
            ) : null}
            {usage ? <Txt testID="progress-usage" role="small" tone="inkSoft">{usage}</Txt> : null}
            {d.task ? <View style={{ gap: space.s }}>
              <Txt role="meta">{t(lang, 'progress.executor')}: {providerName(d.task.providerId, d.matter.agentNames)}</Txt>
              <Txt role="code" selectable>{t(lang, 'progress.path')}: {d.task.path}</Txt>
            </View> : null}
            {canStop(d) ? (
              <Button kind="secondary" testID="progress-stop" label={t(lang, stopArmed ? 'progress.stopConfirm' : 'progress.stop')} onPress={() => void stop()} disabled={!online} busy={stopping} />
            ) : null}
            {stopNote ? <Txt testID="progress-stop-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{stopNote}</Txt> : null}
            {d.task?.worktree ? (
              <View testID="progress-worktree" style={{ gap: space.s }}>
                <Txt role="meta" tone="inkSoft">{t(lang, d.task.worktree.removed ? 'progress.wtGone' : d.task.worktree.merged ? 'progress.wtOnMerged' : 'progress.wtOn', { branch: d.task.worktree.branch })}</Txt>
                {scripts ? (
                  <View testID="progress-scripts" style={{ gap: space.s }}>
                    <Txt testID="progress-scripts-status" role="meta" tone="inkSoft">{scripts.status}</Txt>
                    {scripts.note ? <Txt testID="progress-scripts-note" role="meta" tone="inkSoft">{scripts.note}</Txt> : null}
                    {scripts.lines.length ? (
                      <View testID="progress-scripts-output" accessible accessibilityLabel={`${t(lang, 'scripts.outputLabel')}: ${scripts.lines.join('\n')}`}
                        style={{ padding: space.s, borderRadius: radius.nav, borderWidth: 1, borderColor: c.hair }}>
                        <Txt role="code" tone="inkSoft" numberOfLines={scripts.lines.length * 2}>{scripts.lines.join('\n')}</Txt>
                      </View>
                    ) : null}
                    {scripts.button ? (
                      <Button kind="secondary" testID={`progress-scripts-${scripts.button}`} label={t(lang, scripts.button === 'run' ? 'scripts.run' : 'scripts.stop')}
                        onPress={() => void scriptAct(scripts.button!)} disabled={!online} busy={scriptBusy} />
                    ) : null}
                    {scriptNote ? <Txt testID="progress-scripts-result" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{scriptNote}</Txt> : null}
                  </View>
                ) : null}
                {d.task.worktree.removed ? <Button kind="secondary" testID="progress-wt-reopen" label={t(lang, 'progress.wtReopen')} onPress={() => void worktreeAct('reopen')} disabled={!online} busy={wtBusy} /> : null}
                {!d.task.worktree.removed ? (
                  <View style={{ flexDirection: 'row', gap: space.s, flexWrap: 'wrap' }}>
                    <Button kind="secondary" testID="progress-wt-commit" label={t(lang, 'progress.wtCommit')} onPress={() => void worktreeAct('commit')} disabled={!online} busy={wtBusy} />
                    <Button kind="secondary" testID="progress-wt-merge" label={t(lang, wtArmed === 'merge' ? 'progress.wtMergeConfirm' : 'progress.wtMerge')} onPress={() => void worktreeAct('merge')} disabled={!online || wtBusy} />
                    <Button kind="secondary" testID="progress-wt-remove" label={t(lang, wtArmed === 'remove' ? 'progress.wtRemoveConfirm' : 'progress.wtRemove')} onPress={() => void worktreeAct('remove')} disabled={!online || wtBusy} />
                    {d.task.worktree.projectId ? <Button kind="secondary" testID="progress-wt-fork" label={t(lang, 'progress.wtFork')} onPress={() => forkToAnother(d.task!.worktree!.projectId!, d.task!.providerId)} /> : null}
                  </View>
                ) : null}
                {wtNote ? <Txt testID="progress-wt-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{wtNote}</Txt> : null}
              </View>
            ) : null}
          </View>
        </DetailSection>

        {inputReceipts.length ? <InputReceipts rows={inputReceipts} onRestore={restoreInput} /> : null}
        {inputNotice ? <Txt role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{inputNotice}</Txt> : null}
        <DetailSection key={`changes:${id}:${turn?.artifactId ?? ''}`} keepMounted testID="progress-changes" title={t(lang, 'progress.viewChangesN', { n: v.changedFiles })}>
          {gone.discarded ? <Txt testID="progress-changes-discarded" role="meta" tone="inkSoft">{gone.discarded}</Txt> : null}
          {gone.after ? <Txt testID="progress-changes-discarded-after" role="small" tone="inkSoft">{gone.after}</Txt> : null}
          {canOfferRewind(turn, !!rewindBlocked) ? (
            <View style={{ paddingBottom: space.s }}>
              <Button kind="secondary" testID="progress-rewind" label={t(lang, 'rewind.button')} disabled={!online} onPress={() => { setRewindNote(null); setRewindOpen(true) }} />
            </View>
          ) : null}
          {rewindNote ? <Txt testID="progress-rewind-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{rewindNote}</Txt> : null}
          {coverage.lines.map((line, i) => <Txt key={`cov-${i}`} testID={i === 0 ? 'progress-changes-coverage' : undefined} role={i === 0 ? 'meta' : 'caption'} tone="inkSoft">{line}</Txt>)}
          {files.length === 0 && coverage.showEmpty ? <Txt role="meta" tone="inkSoft">{t(lang, 'progress.noChanges')}</Txt> : null}
          {files.map((f, i) => (
            // 已撤掉的那一轮灰着(没有审阅按钮)
            <View key={i} style={{ paddingVertical: space.s, gap: space.xs, opacity: turn?.discarded ? 0.55 : 1 }}>
              <Txt role="code">{f.path}</Txt>
              {/* 该多看一眼的原因(B6):一个强调色的「注意 · 原因」,只是提醒,不拦操作 */}
              {f.risk?.length ? <Txt role="caption" tone="accent" testID={`review-risk-${f.path}`}>{t(lang, 'review.risk', { why: f.risk.join('、') })}</Txt> : null}
              {f.kind === 'not_reviewed' ? (
                <>
                  <Txt role="small" tone="inkSoft">{t(lang, 'progress.notReviewed')}</Txt>
                  {f.reason ? <Txt role="caption" tone="inkSoft">{f.reason}</Txt> : null}
                </>
              ) : f.truncated ? (
                <Txt role="small" tone="inkSoft">{t(lang, 'progress.tooBig')}</Txt>
              ) : f.diff && turn?.artifactId && canComment(turn, f) ? (
                // 行评论(切片 4):块对得上 ⇒ 按块显示,每块「评论这一块」;对不上 ⇒ 照旧整段
                <HunkComments matterId={id} artifactId={turn.artifactId} file={f} pieces={fileHunks(f)!} backend={backend} lang={lang} online={online}
                  onDone={() => { void refreshChanges() }} />
              ) : f.diff ? (
                <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
                  <Txt role="code" tone="inkSoft">{f.diff}</Txt>
                </ScrollView>
              ) : f.reason ? (
                <Txt role="small" tone="inkSoft">{f.reason}</Txt>
              ) : null}
              {changes.data?.artifactId && !changes.data.discarded && f.kind !== 'not_reviewed' && !f.path.startsWith('…') ? (
                <ChangeReview matterId={id} artifactId={changes.data.artifactId} path={f.path} {...(f.mark ? { mark: f.mark } : {})}
                  backend={backend} lang={lang} online={online} onDone={() => { void refreshChanges(); void refreshDetail() }} />
              ) : null}
            </View>
          ))}
          {sendRow && turn ? (
            <CommentsSend matterId={id} block={sendRow}
              backend={backend} lang={lang} online={online} onNote={setCommentsNote} onDone={() => { void refreshChanges(); void refreshDetail() }} />
          ) : null}
          {commentsNote ? <Txt testID="line-comments-note" role="caption" tone={commentsNote.ok ? 'inkSoft' : 'bad'} accessibilityLiveRegion="polite">{commentsNote.text}</Txt> : null}
        </DetailSection>

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

      {rewindOpen && turn?.artifactId ? (
        <RewindSheet matterId={id} artifactId={turn.artifactId} backend={backend} lang={lang} online={online} submit={submit}
          onClose={() => setRewindOpen(false)} onStale={() => void refreshChanges()}
          onSettled={o => { setRewindOpen(false); setRewindNote(o.text); void refreshChanges(); void refreshDetail() }} />
      ) : null}
      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <View style={{ flex: 1 }}>
        <Pressable accessibilityLabel={t(lang, 'handoff.later')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setSheet(false)} />
        <SafeAreaView testID="handoff-sheet" edges={['bottom']} style={{ backgroundColor: c.paper, maxHeight: '90%', borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
          <ScrollView testID="handoff-sheet-scroll" style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.xl, gap: space.m }}>
          {d.quotaHandoff?.state === 'offer' ? (
            <>
              <Txt role="item" accessibilityRole="header">{t(lang, 'handoff.title', { to: providerName(d.quotaHandoff.to, d.matter.agentNames) })}</Txt>
              {handoffSheetLines(d.quotaHandoff, lang, Date.now(), d.matter.agentNames).map((line, i) => <Txt key={i} testID={`handoff-line-${i}`} role="bubble">{line}</Txt>)}
              {failureRow}
              <Button kind="primary" testID="handoff-confirm" label={hb.kind === 'offer' ? hb.action : ''} onPress={() => void confirmHandoff()} disabled={!online} busy={sending} />
            </>
          ) : (
            // 卡开着时电脑那边变了(额度恢复 / 已经交出去 / 没人能接):收起主按钮,只说为什么
            <>{failureRow ?? <Txt testID="handoff-sheet-note" role="bubble" tone="inkSoft">{t(lang, 'handoff.changed')}</Txt>}</>
          )}
          <Button kind="secondary" testID="handoff-cancel" label={t(lang, 'handoff.later')} onPress={() => setSheet(false)} />
          </ScrollView>
        </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

/** Stateful review editors survive collapsing; a new matter or change artifact starts fresh. */
function DetailSection({ title, testID, children, keepMounted = false }: { title: string; testID: string; children: ReactNode; keepMounted?: boolean }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  return <View>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(v => !v)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space.m }}>
      <Txt role="meta" tone="inkSoft" style={{ flex: 1 }}>{title}</Txt>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} color={c.inkSoft} />
    </Pressable>
    <Expansion open={open} keepMounted={keepMounted}><View style={{ paddingVertical: space.m, gap: space.l }}>{children}</View></Expansion>
  </View>
}


function ConversationMessage({ event }: { event: ConvItem }) {
  const lang = useLang()
  return <View style={{ gap: space.xs, alignSelf: event.kind === 'me' ? 'flex-end' : 'stretch', maxWidth: '100%' }}>
    <Txt role="caption" tone="inkSoft" style={{ textAlign: event.kind === 'me' ? 'right' : 'left' }}>{t(lang, event.kind === 'me' ? 'chat.me' : 'cc.label')}</Txt>
    <MessageText role={event.kind === 'me' ? 'user' : 'assistant'} text={event.text} userAlign="right" />
  </View>
}
