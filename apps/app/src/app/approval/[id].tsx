import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, tCount } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery, useSubmit, useTopic } from '../../state/hooks'
import type { SubmitResult } from '../../state/store'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CCFigure } from '../../ui/CCFigure'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Dot } from '../../ui/Dot'
import { Sheet } from '../../ui/Sheet'
import { Icon } from '../../ui/Icon'
import { BusyIndicator } from '../../ui/motion'
import { StatusHint } from '../../ui/StatusHint'
import { TextField } from '../../ui/TextField'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { canSubmit } from '../../view/connection'
import { ccPresence } from '../../view/presence'
import { ANSWER_MAX_CHARS, ANSWER_MAX_MULTI, answersTooLong, approvalOutcome, approvalView, buildAnswers, multiLimitReached, pinnedRequest, togglePick, type ApprovalView } from '../../view/approval'

type Outcome = null | { requestId: string; kind: 'handled' | 'uncertain' | 'failed' | 'ccBusy' | 'tooLong' | 'revoked' }
type CardView = Extract<ApprovalView, { kind: 'card' }>
type QuestionView = Extract<ApprovalView, { kind: 'question' }>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// 批准页。硬要求:说明来自模型时,原始命令首行 + 工作目录直接可见、不折叠;
// 提交中两个按钮都锁;以返回结果为准(不做乐观成功);超时 ⇒「不确定」并重新拉详情。
// 打开就拉新(有缓存也拉):拿到挂载之后发出的详情之前按钮一直锁,钉住的请求也只从新详情里取。
// 不在线(连接中 / 离线 / 撤销)⇒ 按钮锁 + ConnectionNotice(离线带上次同步时间,撤销给「重新配对」)。
// 回答 JSON 超过 20 000 字 ⇒ 手机上就拦下,请求不发。CC 这一轮还在跑(busy)⇒ 专门的一句,不算失败。
export default function Approval() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const params = useLocalSearchParams<{ id: string; request?: string }>()
  const id = one(params.id) ?? ''
  const requestParam = one(params.request) || undefined
  const detail = useQuery(`matter:${id}`, l => backend.matter(id, l), { refreshOnMount: true })
  const insight = useQuery(`insight:${id}`, l => backend.insight(id, l), { refreshOnMount: true })
  const online = canSubmit(conn)
  const { refresh: refreshDetail } = detail
  const { refresh: refreshInsight } = insight

  // 电脑上处理掉了也要跟上:matter 主题版本变了就重拉(与进展页同一套 key,共用缓存)。
  const ver = useTopic<{ version?: unknown }>(`matter/${id}`)
  const seen = useRef<unknown>(undefined)
  const verKey = ver === undefined ? undefined : JSON.stringify(ver)
  useEffect(() => {
    if (verKey === undefined) return
    if (seen.current !== undefined && seen.current !== verKey) { void refreshDetail(); void refreshInsight() }
    seen.current = verKey
  }, [verKey, refreshDetail, refreshInsight])

  const [outcome, setOutcome] = useState<Outcome>(null)
  const [pending, setPending] = useState<null | 'allow' | 'deny' | 'answer'>(null)
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  // 同步锁:连点两下时 React state 还没更新,靠 ref 挡住第二次。
  const inflight = useRef(false)
  // 钉住的请求:第一次解析出具体一条后,之后的重拉(主题版本、不确定后刷新)只认这一条。
  const pin = useRef<string | undefined>(undefined)

  const backToMatter = () => router.dismissTo(`/matter/${encodeURIComponent(id)}`)

  async function send(requestId: string, key: string, kind: 'allow' | 'deny' | 'answer', run: () => Promise<void>) {
    if (inflight.current || pending || refreshing || !detail.fresh || !online) return
    inflight.current = true
    setPending(kind)
    setOutcome(null)
    const r: SubmitResult = await submit(key, run)
    if (!alive.current) return
    if (r === 'ok') {
      void refreshDetail(); void refreshInsight()
      backToMatter()
      return
    }
    if (r === 'busy') {
      // 同一条已有提交在飞(别处发起的):保持锁定,结果以重拉为准(处理掉了就变「已处理」)。
      void refreshDetail(); void refreshInsight()
      return
    }
    inflight.current = false
    setPending(null)
    const shown = approvalOutcome(r.error)
    setOutcome({ requestId, kind: shown })
    if (shown === 'handled') {
      void refreshDetail()
    } else if (shown === 'uncertain') {
      setRefreshing(true)
      await Promise.all([refreshDetail(), refreshInsight()])
      if (alive.current) setRefreshing(false)
    }
  }

  const header = (
    <TopBar title={t(lang, 'common.wordmark')} onBack={() => router.back()} />
  )
  const shell = (body: ReactNode, footer?: ReactNode) => (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
          {body}
        </ScrollView>
        {footer ? <View style={{ paddingHorizontal: space.xl, paddingTop: space.m, paddingBottom: space.m, gap: space.s }}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  // 旧缓存算出来的「已处理」不作数:没拿到新详情前照样显示加载中。
  const staleNone = !detail.fresh && detail.data !== undefined && approvalView(detail.data, {}, requestParam ?? pin.current).kind === 'none'
  if (!detail.data || staleNone) {
    return shell(
      detail.error && !detail.loading ? (
        <StatusHint testID="approval-load-failed" label={t(lang, 'feedback.loadingFailed')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'approval.refreshFailed')}>
          <Button kind="secondary" label={t(lang, 'feedback.check')} onPress={() => void refreshDetail()} />
        </StatusHint>
      ) : (
        <BusyIndicator label={t(lang, 'progress.loading')} />
      ),
    )
  }

  const d = detail.data
  const explanations = insight.data?.explanations ?? {}
  const v = approvalView(d, explanations, requestParam ?? pin.current)
  // 第一次从新详情(挂载之后拉的)解析出具体一条就钉住(幂等:只在还没钉时写一次)。钉住的不在了 ⇒ approvalView 给 none,不会落到别的请求。
  if (!requestParam && !pin.current && detail.fresh) pin.current = pinnedRequest(undefined, undefined, v)
  const matterTitle = d.matter.title
  const shownOutcome = outcome && (v.kind === 'card' || v.kind === 'question') && outcome.requestId === v.requestId ? outcome.kind : null

  if (shownOutcome === 'handled' || v.kind === 'none') {
    return shell(
      <View testID="approval-handled" style={{ gap: space.l, paddingTop: space.xl, alignItems: 'flex-start' }}>
        <CCFigure size={72} presence={ccPresence(conn)} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
          <Icon name="check" color={c.inkSoft} />
          <Txt role="meta" accessibilityRole="header">{t(lang, 'approval.handled')}</Txt>
        </View>
        <Txt role="bubble" tone="inkSoft" content="user">{matterTitle}</Txt>
      </View>,
      <Button kind="primary" testID="approval-back" label={t(lang, 'approval.backToMatter')} onPress={backToMatter} />,
    )
  }

  if (v.kind === 'choose') {
    return shell(
      <>
        <MatterContext title={matterTitle} />
        <Txt role="title" accessibilityRole="header">{t(lang, 'approval.chooseTitle')}</Txt>
        {v.items.map(item => (
          <Pressable
            key={item.requestId}
            testID={`approval-choose-${item.requestId}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.kind === 'permission' ? t(lang, 'approval.kindPermission') : t(lang, 'approval.kindQuestion')}: ${item.summary}`}
            onPress={() => router.push(`/approval/${encodeURIComponent(id)}?request=${encodeURIComponent(item.requestId)}`)}
            style={({ pressed }) => ({ minHeight: 56, paddingVertical: space.s, opacity: pressed ? 0.7 : 1 })}
          >
            <Card style={{ gap: space.s }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
                <Dot kind="warn" size={8} />
                <Txt role="caption" tone="inkSoft">{item.kind === 'permission' ? t(lang, 'approval.kindPermission') : t(lang, 'approval.kindQuestion')}</Txt>
              </View>
              {item.kind === 'permission' ? <Txt role="code">{item.summary}</Txt> : <Txt role="meta" content="user">{item.summary}</Txt>}
            </Card>
          </Pressable>
        ))}
      </>,
    )
  }

  // editing:提交中 / 不确定后重拉中 ⇒ 表单也锁。locked 再加上「还没拿到新详情」「电脑不在线」⇒ 只锁提交。
  const editing = pending !== null || refreshing
  const locked = editing || !detail.fresh || !online
  const status = (
    <>
      <ConnectionNotice />
      {online && !detail.fresh && !pending && !refreshing ? (
        detail.error && !detail.loading ? (
          <StatusHint testID="approval-refresh-failed" label={t(lang, 'feedback.loadingFailed')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'approval.refreshFailed')}>
            <Button kind="secondary" label={t(lang, 'feedback.check')} onPress={() => void refreshDetail()} />
          </StatusHint>
        ) : (
          <BusyIndicator label={t(lang, 'progress.loading')} />
        )
      ) : null}
      {shownOutcome === 'uncertain' ? <Notice testID="approval-uncertain" text={t(lang, 'approval.uncertain')} /> : null}
      {shownOutcome === 'tooLong' ? <Notice testID="approval-too-long" text={t(lang, 'approval.answerTooLong')} /> : null}
      {shownOutcome === 'ccBusy' ? <Notice testID="approval-cc-busy" text={t(lang, 'common.ccBusy')} /> : null}
      {shownOutcome === 'revoked' ? <Notice testID="approval-revoked" text={t(lang, 'conn.revokedTitle')} /> : null}
      {shownOutcome === 'failed' ? <Notice testID="approval-failed" text={t(lang, 'approval.failed')} /> : null}
    </>
  )

  if (v.kind === 'question') {
    return (
      <QuestionForm
        key={v.requestId}
        v={v}
        matterTitle={matterTitle}
        shell={shell}
        locked={editing}
        submitLocked={locked}
        busy={pending === 'answer'}
        status={status}
        onSkip={() => (router.canGoBack() ? router.back() : backToMatter())}
        onSubmit={answers => {
          if (answersTooLong(answers)) { setOutcome({ requestId: v.requestId, kind: 'tooLong' }); return }
          void send(v.requestId, `answer:${v.requestId}`, 'answer', () => backend.answer({ id, runId: v.runId, requestId: v.requestId, answers }))
        }}
      />
    )
  }

  const decide = (decision: 'allow' | 'deny') =>
    void send(v.requestId, `approve:${v.requestId}`, decision, () => backend.decide({ id, runId: v.runId, requestId: v.requestId, decision }))

  return shell(
    <PermissionCard key={v.requestId} v={v} matterTitle={matterTitle} />,
    <View key={v.requestId} style={{ gap: space.s }}>
      {status}
      <View style={{ flexDirection: 'row', gap: space.m }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" testID="approval-deny" label={t(lang, 'approval.deny')} onPress={() => decide('deny')} disabled={locked} busy={pending === 'deny'} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind="primary" testID="approval-allow" label={t(lang, 'approval.allow')} onPress={() => decide('allow')} disabled={locked} busy={pending === 'allow'} />
        </View>
      </View>
      <Txt role="small" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'approval.onlyThisRequest')}</Txt>
    </View>,
  )
}

// 这几条(不确定 / 失败 / 撤销 / 太长 / CC 正忙 / 选满)是按钮旁唯一的提示,不是重复说明:
// 保持看得见 + 读屏自动念,不收进状态入口(收进去就只剩一个和「信息」一样的小 i)。
function Notice({ text, testID }: { text: string; testID?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind="warn" size={8} />
      <Txt testID={testID} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}>{text}</Txt>
    </View>
  )
}

function MatterContext({ title, eventKey }: { title: string; eventKey?: string }) {
  const conn = useConnection()
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingTop: space.m }}>
    <CCFigure size={36} presence={ccPresence(conn)} behavior={eventKey ? 'wait' : 'idle'} eventKey={eventKey} />
    <Txt role="meta" tone="inkSoft" content="user" style={{ flex: 1 }}>{title}</Txt>
  </View>
}

function PermissionCard({ v, matterTitle }: { v: CardView; matterTitle: string }) {
  const lang = useLang()
  // 没有模型说明时 what 就是原始命令:等宽、最多 4 行,完整内容在「查看具体操作」里。
  const rows: Array<[string, string, boolean]> = [
    [t(lang, 'approval.what'), v.what, !v.aiSummary],
    [t(lang, 'approval.scope'), v.scope, false],
    [t(lang, 'approval.effect'), v.effect, false],
  ]
  const shown = rows.filter(([, body]) => body.trim() !== '')
  return (
    <>
      <MatterContext title={matterTitle} eventKey={v.requestId} />
      <View style={{ gap: space.s }}>
        <Txt testID="approval-title" role="title" content="user" accessibilityRole="header">{v.title}</Txt>
        {v.aiSummary ? (
          <View testID="approval-ai-summary" accessible accessibilityLabel={`${t(lang, 'approval.aiTag')}. ${t(lang, 'approval.aiSummary')}`} style={{ gap: space.xs }}>
            <Txt role="caption">{t(lang, 'approval.aiTag')}</Txt>
            <Txt role="small" tone="inkSoft">{t(lang, 'approval.aiSummary')}</Txt>
          </View>
        ) : null}
      </View>

      {/* 模型写的说明可能不准:原始命令首行与工作目录直接摆出来,不折叠。 */}
      {v.showRawInline ? (
        <View testID="approval-raw-inline" style={{ gap: space.s, paddingVertical: space.m }}>
          <Txt role="caption" tone="inkSoft">{t(lang, 'approval.rawCommand')}</Txt>
          <Txt selectable role="code">{v.rawFirstLine}{v.rawFirstLineCut ? '…' : ''}</Txt>
          {v.rawMoreLines > 0 ? <Txt testID="approval-raw-more" role="caption" tone="inkSoft">{tCount(lang, 'approval.moreLines', v.rawMoreLines)}</Txt> : null}
          <Txt role="caption" tone="inkSoft">{t(lang, 'approval.workingDir')}</Txt>
          <Txt selectable role="code">{v.workingDir || '—'}</Txt>
        </View>
      ) : null}

      {shown.length > 0 ? (
        <Card style={{ gap: 0, paddingVertical: space.s }}>
          {shown.map(([label, body, raw]) => (
            <View key={label} style={{ paddingVertical: space.m, gap: space.xs }}>
              <Txt role="meta" tone="inkSoft">{label}</Txt>
              {raw ? (
                <Txt role="code" numberOfLines={4}>{body}</Txt>
              ) : (
                <Txt role="bubble" content="user">{body}</Txt>
              )}
            </View>
          ))}
        </Card>
      ) : null}

      <Sheet testID="approval-view-exact" title={t(lang, 'approval.viewExact')}>
        <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
          <Txt selectable role="code">{v.rawFull}</Txt>
        </ScrollView>
        {v.workingDir ? (
          <Txt selectable role="code" tone="inkSoft" style={{ marginTop: space.s }}>
            {t(lang, 'approval.workingDir')}: {v.workingDir}
          </Txt>
        ) : null}
      </Sheet>
    </>
  )
}

function QuestionForm({ v, matterTitle, shell, locked, submitLocked, busy, status, onSkip, onSubmit }: {
  v: QuestionView
  matterTitle: string
  shell: (body: ReactNode, footer?: ReactNode) => ReactNode
  /** 提交中:整张表单锁住。 */
  locked: boolean
  /** 提交锁(提交中 / 还没拿到新详情 / 电脑不在线):只锁「回答」按钮,还能先选好。 */
  submitLocked: boolean
  busy: boolean
  status: ReactNode
  onSkip: () => void
  onSubmit: (answers: Record<string, string[]>) => void
}) {
  const { c } = useTheme()
  const lang = useLang()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answers = buildAnswers(v.items, picked, other)

  const toggle = (itemId: string, label: string, multi: boolean) => {
    setPicked(p => {
      const cur = p[itemId] ?? []
      const next = togglePick(cur, label, multi)
      return next === cur ? p : { ...p, [itemId]: next }
    })
    if (!multi) setOther(o => ({ ...o, [itemId]: '' })) // 单选:点了选项就不再用「其他」
  }
  const typeOther = (itemId: string, text: string, multi: boolean) => {
    setOther(o => ({ ...o, [itemId]: text }))
    if (!multi && text.trim() !== '') setPicked(p => ({ ...p, [itemId]: [] })) // 单选:写了「其他」就顶替选项
  }

  return shell(
    <>
      <MatterContext title={matterTitle} eventKey={v.requestId} />
      {v.items.map(item => {
        const cur = picked[item.id] ?? []
        const full = multiLimitReached(item.multiSelect, cur)
        return (
          <View key={item.id} style={{ gap: space.m }}>
            {item.header ? <Txt role="small" tone="inkSoft" content="user">{item.header}</Txt> : null}
            <Txt role="title" content="user" accessibilityRole="header">{item.question}</Txt>
            {item.multiSelect ? <Txt role="small" tone="inkSoft">{t(lang, 'approval.multiHint')}</Txt> : null}
            <View style={{ gap: space.xs }}>
              {item.options.map((o, i) => {
                const on = cur.includes(o.label)
                const blocked = locked || (full && !on) // 选满 8 项:没选的不能再点
                return (
                  <Pressable
                    key={i}
                    testID={`answer-option-${item.id}-${i}`}
                    accessibilityRole={item.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: on, disabled: blocked }}
                    accessibilityLabel={o.description ? `${o.label}, ${o.description}` : o.label}
                    disabled={blocked}
                    onPress={() => toggle(item.id, o.label, item.multiSelect)}
                    style={{
                      minHeight: 52, justifyContent: 'center', paddingVertical: space.m,
                      opacity: blocked ? 0.55 : 1,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
                      <View style={{ flex: 1, gap: space.xs }}>
                        <Txt role="bubble" content="user">{o.label}</Txt>
                        {o.description ? <Txt role="caption" tone="inkSoft" content="user">{o.description}</Txt> : null}
                      </View>
                      {on ? <Icon name="check" color={c.inkSoft} /> : null}
                    </View>
                  </Pressable>
                )
              })}
            </View>
            {full ? <Notice testID={`answer-max-${item.id}`} text={t(lang, 'approval.maxChoices', { n: ANSWER_MAX_MULTI })} /> : null}
            {item.allowOther ? (
              <View style={{ gap: space.xs }}>
                <Txt role="small" tone="inkSoft">{t(lang, 'approval.otherLabel')}</Txt>
                <TextField
                  testID={`answer-other-${item.id}`}
                  accessibilityLabel={`${item.question} ${t(lang, 'approval.otherLabel')}`}
                  editable={!locked}
                  value={other[item.id] ?? ''}
                  onChangeText={text => typeOther(item.id, text, item.multiSelect)}
                  placeholder={t(lang, 'approval.otherPlaceholder')}
                  multiline
                  maxLength={ANSWER_MAX_CHARS}
                  role="bubble"
                  style={{ minHeight: 44, paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.sheet, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper }}
                />
              </View>
            ) : null}
          </View>
        )
      })}
    </>,
    <>
      {status}
      <View style={{ flexDirection: 'row', gap: space.m }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" testID="answer-skip" label={t(lang, 'approval.skip')} onPress={onSkip} disabled={locked} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind="primary" testID="answer-submit" label={t(lang, 'approval.submitAnswer')} onPress={() => answers && onSubmit(answers)} disabled={submitLocked || !answers} busy={busy} />
        </View>
      </View>
    </>,
  )
}
