import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery, useSubmit, useTopic } from '../../state/hooks'
import type { SubmitResult } from '../../state/store'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CCFigure } from '../../ui/CCFigure'
import { monoFamily, serifFamily } from '../../ui/fonts'
import { Sheet } from '../../ui/Sheet'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { approvalView, buildAnswers, type ApprovalView } from '../../view/approval'

type Outcome = null | 'handled' | 'uncertain' | 'failed'
type CardView = Extract<ApprovalView, { kind: 'card' }>
type QuestionView = Extract<ApprovalView, { kind: 'question' }>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// 批准页。硬要求:说明来自模型时,原始命令首行 + 工作目录直接可见、不折叠;
// 提交中两个按钮都锁;以返回结果为准(不做乐观成功);超时 ⇒「不确定」并重新拉详情。
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
  const detail = useQuery(`matter:${id}`, () => backend.matter(id))
  const insight = useQuery(`insight:${id}:${lang}`, () => backend.insight(id, lang))
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

  const backToMatter = () => router.dismissTo(`/matter/${encodeURIComponent(id)}`)

  async function send(key: string, kind: 'allow' | 'deny' | 'answer', run: () => Promise<void>) {
    if (pending || refreshing) return
    setPending(kind)
    setOutcome(null)
    const r: SubmitResult = await submit(key, run)
    if (!alive.current) return
    if (r === 'ok') {
      void refreshDetail(); void refreshInsight()
      backToMatter()
      return
    }
    setPending(null)
    if (r === 'busy') return
    if (r.error === 'stale') {
      setOutcome('handled')
      void refreshDetail()
    } else if (r.error === 'uncertain') {
      setOutcome('uncertain')
      setRefreshing(true)
      await Promise.all([refreshDetail(), refreshInsight()])
      if (alive.current) setRefreshing(false)
    } else {
      setOutcome('failed')
    }
  }

  const header = (
    <TopBar title={t(lang, 'common.wordmark')} onBack={() => router.back()} connection={conn.state === 'online' ? 'online' : 'offline'} onAvatar={() => router.push('/settings')} />
  )
  const shell = (body: ReactNode, footer?: ReactNode) => (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
          {body}
        </ScrollView>
        {footer ? <View style={{ paddingHorizontal: space.xl, paddingTop: space.m, paddingBottom: space.m, gap: space.s }}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  if (!detail.data) {
    return shell(<Text style={{ color: c.muted, paddingTop: space.xl }}>{detail.error ? t(lang, 'progress.loadFailed') : t(lang, 'progress.loading')}</Text>)
  }

  const d = detail.data
  const v = approvalView(d, insight.data?.explanations ?? {}, requestParam)
  const matterTitle = d.matter.title

  if (outcome === 'handled' || v.kind === 'none') {
    return shell(
      <View testID="approval-handled" style={{ gap: space.l, paddingTop: space.xl, alignItems: 'flex-start' }}>
        <CCFigure size={72} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, lineHeight: 32, fontFamily: serifFamily, fontWeight: '600' }}>{t(lang, 'approval.handled')}</Text>
        <Text style={{ color: c.muted, fontSize: 15 }}>{matterTitle}</Text>
      </View>,
      <Button kind="primary" testID="approval-back" label={t(lang, 'approval.backToMatter')} onPress={backToMatter} />,
    )
  }

  if (v.kind === 'choose') {
    return shell(
      <>
        <Eyebrow title={matterTitle} eyebrow={t(lang, 'approval.eyebrow')} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, lineHeight: 36, fontFamily: serifFamily, fontWeight: '600' }}>{t(lang, 'approval.chooseTitle')}</Text>
        <Text style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'approval.chooseOne')}</Text>
        {v.items.map(item => (
          <Pressable
            key={item.requestId}
            testID={`approval-choose-${item.requestId}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.kind === 'permission' ? t(lang, 'approval.kindPermission') : t(lang, 'approval.kindQuestion')}: ${item.summary}`}
            onPress={() => router.push(`/approval/${encodeURIComponent(id)}?request=${encodeURIComponent(item.requestId)}`)}
          >
            <Card style={{ gap: space.s }}>
              <Text style={{ color: c.warn, fontSize: 12, fontWeight: '600' }}>{item.kind === 'permission' ? t(lang, 'approval.kindPermission') : t(lang, 'approval.kindQuestion')}</Text>
              <Text style={{ color: c.ink, fontSize: 14, lineHeight: 20, fontFamily: item.kind === 'permission' ? monoFamily : undefined }}>{item.summary}</Text>
            </Card>
          </Pressable>
        ))}
      </>,
    )
  }

  const locked = pending !== null || refreshing
  const status = (
    <>
      {pending ? <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 13, textAlign: 'center' }}>{t(lang, 'approval.submitting')}</Text> : null}
      {outcome === 'uncertain' ? <Text testID="approval-uncertain" accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14, lineHeight: 20 }}>{t(lang, 'approval.uncertain')}</Text> : null}
      {outcome === 'failed' ? <Text testID="approval-failed" accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14, lineHeight: 20 }}>{t(lang, 'approval.failed')}</Text> : null}
    </>
  )

  if (v.kind === 'question') {
    return (
      <QuestionForm
        key={v.requestId}
        v={v}
        matterTitle={matterTitle}
        shell={shell}
        locked={locked}
        busy={pending === 'answer'}
        status={status}
        onSkip={() => (router.canGoBack() ? router.back() : backToMatter())}
        onSubmit={answers => void send(`answer:${v.requestId}`, 'answer', () => backend.answer({ id, runId: v.runId, requestId: v.requestId, answers }))}
      />
    )
  }

  const decide = (decision: 'allow' | 'deny') =>
    void send(`approve:${v.requestId}`, decision, () => backend.decide({ id, runId: v.runId, requestId: v.requestId, decision }))

  return shell(
    <PermissionCard v={v} matterTitle={matterTitle} />,
    <>
      {status}
      <View style={{ flexDirection: 'row', gap: space.m }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" testID="approval-deny" label={t(lang, 'approval.deny')} onPress={() => decide('deny')} disabled={locked} busy={pending === 'deny'} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind="primary" testID="approval-allow" label={t(lang, 'approval.allow')} onPress={() => decide('allow')} disabled={locked} busy={pending === 'allow'} />
        </View>
      </View>
      <Text style={{ color: c.muted, fontSize: 13, textAlign: 'center' }}>{t(lang, 'approval.onlyThisRequest')}</Text>
    </>,
  )
}

function Eyebrow({ eyebrow, title }: { eyebrow: string; title: string }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingTop: space.s }}>
      <CCFigure size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.muted, fontSize: 12 }}>{eyebrow}</Text>
        <Text numberOfLines={2} style={{ color: c.ink, fontSize: 14 }}>{title}</Text>
      </View>
    </View>
  )
}

function PermissionCard({ v, matterTitle }: { v: CardView; matterTitle: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const rows: Array<[string, string]> = [
    [t(lang, 'approval.what'), v.what],
    [t(lang, 'approval.scope'), v.scope],
    [t(lang, 'approval.effect'), v.effect],
  ]
  const shown = rows.filter(([, body]) => body.trim() !== '')
  const truncated = v.rawFull.length > v.rawFirstLine.length
  return (
    <>
      <Eyebrow eyebrow={t(lang, 'approval.eyebrow')} title={matterTitle} />
      <View style={{ gap: space.s }}>
        <Text testID="approval-title" accessibilityRole="header" style={{ color: c.ink, fontSize: 30, lineHeight: 38, fontFamily: serifFamily, fontWeight: '600' }}>{v.title}</Text>
        {v.aiSummary ? (
          <View testID="approval-ai-summary" accessible accessibilityLabel={`${t(lang, 'approval.aiTag')}. ${t(lang, 'approval.aiSummary')}`} style={{ gap: space.xs }}>
            <View style={{ alignSelf: 'flex-start', backgroundColor: c.navOnBg, borderRadius: radius.pill, paddingHorizontal: space.s, paddingVertical: 2 }}>
              <Text style={{ color: c.navOnInk, fontSize: 12, fontWeight: '600' }}>{t(lang, 'approval.aiTag')}</Text>
            </View>
            <Text style={{ color: c.muted, fontSize: 13, lineHeight: 18 }}>{t(lang, 'approval.aiSummary')}</Text>
          </View>
        ) : null}
      </View>

      {shown.length > 0 ? (
        <Card style={{ gap: 0, paddingVertical: space.s }}>
          {shown.map(([label, body], i) => (
            <View key={label} style={{ paddingVertical: space.m, gap: space.xs, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line }}>
              <Text style={{ color: c.ink, fontSize: 14, fontWeight: '600' }}>{label}</Text>
              <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{body}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* 模型写的说明可能不准:原始命令首行与工作目录直接摆出来,不折叠。 */}
      {v.showRawInline ? (
        <View testID="approval-raw-inline" style={{ gap: space.s, padding: space.l, borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.accentSoft }}>
          <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600' }}>{t(lang, 'approval.rawCommand')}</Text>
          <Text selectable style={{ color: c.ink, fontSize: 13, lineHeight: 19, fontFamily: monoFamily }}>{v.rawFirstLine}{truncated ? ' …' : ''}</Text>
          <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600' }}>{t(lang, 'approval.workingDir')}</Text>
          <Text selectable style={{ color: c.ink, fontSize: 13, lineHeight: 19, fontFamily: monoFamily }}>{v.workingDir || '—'}</Text>
        </View>
      ) : null}

      <Sheet testID="approval-view-exact" title={t(lang, 'approval.viewExact')}>
        <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
          <Text selectable style={{ color: c.ink, fontSize: 12, lineHeight: 17, fontFamily: monoFamily }}>{v.rawFull}</Text>
        </ScrollView>
        {v.workingDir ? (
          <Text selectable style={{ color: c.muted, fontSize: 12, lineHeight: 17, fontFamily: monoFamily, marginTop: space.s }}>
            {t(lang, 'approval.workingDir')}: {v.workingDir}
          </Text>
        ) : null}
      </Sheet>
    </>
  )
}

function QuestionForm({ v, matterTitle, shell, locked, busy, status, onSkip, onSubmit }: {
  v: QuestionView
  matterTitle: string
  shell: (body: ReactNode, footer?: ReactNode) => ReactNode
  locked: boolean
  busy: boolean
  status: ReactNode
  onSkip: () => void
  onSubmit: (answers: Record<string, string | string[]>) => void
}) {
  const { c } = useTheme()
  const lang = useLang()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answers = buildAnswers(v.items, picked, other)

  const toggle = (itemId: string, label: string, multi: boolean) => {
    setPicked(p => {
      const cur = p[itemId] ?? []
      if (!multi) return { ...p, [itemId]: cur[0] === label ? [] : [label] }
      return { ...p, [itemId]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
    })
    if (!multi) setOther(o => ({ ...o, [itemId]: '' })) // 单选:点了选项就不再用「其他」
  }
  const typeOther = (itemId: string, text: string, multi: boolean) => {
    setOther(o => ({ ...o, [itemId]: text }))
    if (!multi && text.trim() !== '') setPicked(p => ({ ...p, [itemId]: [] })) // 单选:写了「其他」就顶替选项
  }

  return shell(
    <>
      <Eyebrow eyebrow={t(lang, 'approval.questionEyebrow')} title={matterTitle} />
      {v.items.map(item => {
        const cur = picked[item.id] ?? []
        return (
          <View key={item.id} style={{ gap: space.m }}>
            {item.header ? <Text style={{ color: c.muted, fontSize: 13, fontWeight: '600' }}>{item.header}</Text> : null}
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 26, lineHeight: 34, fontFamily: serifFamily, fontWeight: '600' }}>{item.question}</Text>
            {item.multiSelect ? <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'approval.multiHint')}</Text> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
              {item.options.map((o, i) => {
                const on = cur.includes(o.label)
                return (
                  <Pressable
                    key={i}
                    testID={`answer-option-${item.id}-${i}`}
                    accessibilityRole={item.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: on, disabled: locked }}
                    accessibilityLabel={o.description ? `${o.label}, ${o.description}` : o.label}
                    disabled={locked}
                    onPress={() => toggle(item.id, o.label, item.multiSelect)}
                    style={{
                      minHeight: 44, justifyContent: 'center', paddingHorizontal: space.l, paddingVertical: space.s,
                      borderRadius: radius.button, borderWidth: 1,
                      borderColor: on ? c.primary : c.line, backgroundColor: on ? c.accentSoft : c.card,
                      opacity: locked ? 0.55 : 1,
                    }}
                  >
                    <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '600' : '400' }}>{on ? '✓ ' : ''}{o.label}</Text>
                    {o.description ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 16 }}>{o.description}</Text> : null}
                  </Pressable>
                )
              })}
            </View>
            {item.allowOther ? (
              <View style={{ gap: space.xs }}>
                <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'approval.otherLabel')}</Text>
                <TextInput
                  testID={`answer-other-${item.id}`}
                  accessibilityLabel={`${item.question} ${t(lang, 'approval.otherLabel')}`}
                  editable={!locked}
                  value={other[item.id] ?? ''}
                  onChangeText={text => typeOther(item.id, text, item.multiSelect)}
                  placeholder={t(lang, 'approval.otherPlaceholder')}
                  placeholderTextColor={c.muted}
                  multiline
                  style={{ minHeight: 44, color: c.ink, fontSize: 15, paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.button, borderWidth: 1, borderColor: c.line, backgroundColor: c.card }}
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
          <Button kind="primary" testID="answer-submit" label={t(lang, 'approval.submitAnswer')} onPress={() => answers && onSubmit(answers)} disabled={locked || !answers} busy={busy} />
        </View>
      </View>
    </>,
  )
}
