import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError, type MatterInputT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { conversationText } from '../i18n/minimal-conversation'
import { useLang } from '../i18n/useLang'
import { deleteDraft, dropDraftImages, getDraft, materialDraftId, pairingGen, peekDraftImages, requestIdFor, setDraft } from '../state/drafts'
import { ImageTray } from '../ui/ImageTray'
import { Icon } from '../ui/Icon'
import { bytesToBase64, uploadImages, type PickedImage } from '../state/image-upload'
import { PHONE_CHAT_MAX_IMAGES as MAX_IMAGES } from '@wechat-cc/protocol'
import { useConnection, useQuery, useSubmit, useTopic } from '../state/hooks'
import { useBackendCtx } from '../state/BackendProvider'
import { consumeMatterInputDraft, matchesMatterInput, matterInputState, matterInputs, updateMatterInput, type InputSnapshot } from '../state/matter-inputs'
import { useInputRecovery, useMatterInputs } from '../state/useMatterInputs'
import { InputJournalError } from '../state/input-journal'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ChoiceRow } from '../ui/Rows'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Dot } from '../ui/Dot'
import { InputReceipts } from '../ui/InputReceipts'
import { TextField } from '../ui/TextField'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { composeOutcome, composeOutcomeDot, composeOutcomeText, composeTooLong, type ComposeOutcome } from '../view/compose'
import { nativeStartLines } from '../view/continue'
import { canSubmit } from '../view/connection'
import { inputFailure, inputRows, matterInputHint } from '../view/matter-input'
import { clampRounds, UNTIL_DEFAULT_ROUNDS, UNTIL_MAX_ROUNDS, untilConfirmation, untilDraftError, untilRequest } from '../view/until'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const NO_INPUTS: readonly MatterInputT[] = []

export default function Compose() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const params = useLocalSearchParams<{ matter?: string; focus?: string; fork?: string; project?: string; exclude?: string }>()
  const matter = one(params.matter) || undefined
  // 「另做一份」(2026-10-08):从一件独立工作区的事进来 —— 同一个项目、独立工作区、换一位执行者;草稿单独存,不盖掉「新的一件」的草稿
  const fork = matter ? undefined : one(params.fork) || undefined
  // 新交办带的图(2026-10-06;补充一句暂不带图)。只在这一屏里,交出去才清。
  // 分享进来的图(2026-10-18)只给「新的一件」(分享页放在 'new' 草稿旁边);补一句 / 另做一份不接
  const takesShared = !matter && !fork
  const [images, setImages] = useState<PickedImage[]>(() => (takesShared ? peekDraftImages('new') : []))
  useEffect(() => { if (takesShared) dropDraftImages('new') }, [takesShared])
  const [imageNote, setImageNote] = useState<string | null>(null)
  const addImages = async () => {
    // 用到才加载:相册与哈希是原生模块,不进页面的静态依赖(测试与首屏都不需要它)
    const { pickImages } = await import('../net/image-pick')
    const r = await pickImages(MAX_IMAGES - images.length)
    if (!r) return
    setImages(cur => [...cur, ...r.images].slice(0, MAX_IMAGES))
    setImageNote(r.skipped === 'too_large' ? t(lang, 'images.tooLarge') : r.skipped === 'unsupported' ? t(lang, 'images.unsupported') : null)
  }
  const { backend } = useBackendCtx()
  const session = useSession()
  const recovery = useInputRecovery()
  const excludeProvider = one(params.exclude) || null
  // 从「接着做」进来:输入框直接聚焦,主人接着打字(spec §4.4)
  const focus = one(params.focus) === '1'
  const draftKey = matter ?? (fork ? `fork:${fork}` : 'new')
  const [text, setTextState] = useState(() => getDraft(draftKey))
  const textRef = useRef(text)
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey
  const setText = (v: string) => { textRef.current = v; setDraft(draftKey, v); setTextState(v) }
  const [adjust, setAdjust] = useState(!!fork)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<null | ComposeOutcome>(null)
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(() => (fork && one(params.project)) || null)
  const [isolated, setIsolated] = useState(!!fork)
  // 从哪个分支开始(10-08):留空 = 最新提交;格式和 daemon 同一条(字母数字开头,只含 ._/-,不含 ..)
  const [base, setBase] = useState('')
  const baseName = base.trim()
  const baseInvalid = !!baseName && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseName) || baseName.includes('..') || baseName.includes('//') || /(\/|\.lock|\.)$/.test(baseName))
  const [providerId, setProviderId] = useState<string | null>(null)
  // 直到这条命令通过(10-20):默认收起;只在独立工作区里出现。命令原文提交前在主屏整条显示一遍(安全 6)。
  const [untilOn, setUntilOn] = useState(false)
  const [untilCmd, setUntilCmd] = useState('')
  const [untilRounds, setUntilRounds] = useState(UNTIL_DEFAULT_ROUNDS)
  // 交办时选模型 / 思考强度(2026-10-06,对标 Paseo / Orca);null = 用执行者自己的默认。换执行者 / 项目就回到默认。
  const [modelId, setModelId] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  useEffect(() => { setModelId(null); setEffort(null) }, [providerId, projectId])
  const sending = useRef(false)
  const options = useQuery('entryOptions', l => backend.entryOptions(l), { enabled: !matter })
  // 说的是一件事:读它的详情(与进展页共用缓存)—— 接过来还没发第一句的,顶上说清第一句会怎样;失败句要知道执行者叫什么
  const detail = useQuery(`matter:${matter ?? ''}`, l => backend.matter(matter ?? '', l), { enabled: !!matter, refreshOnMount: true })
  const localInputs = useMatterInputs(matter ?? '', detail.data?.inputs ?? NO_INPUTS)
  const rows = inputRows(detail.data?.inputs ?? NO_INPUTS, localInputs)
  const ver = useTopic<{ version?: unknown }>(`matter/${matter ?? ''}`)
  const verKey = ver === undefined ? undefined : JSON.stringify(ver)
  const seen = useRef<unknown>(undefined)
  const { refresh: refreshDetail } = detail
  useEffect(() => {
    if (!matter || verKey === undefined) return
    if (seen.current !== undefined && seen.current !== verKey) void refreshDetail()
    seen.current = verKey
  }, [matter, verKey, refreshDetail])
  useEffect(() => {
    textRef.current = getDraft(draftKey); setTextState(textRef.current)
    setOutcome(null); setInputNotice(null)
  }, [draftKey, backend])
  useEffect(() => {
    let alive = true
    if (matter) void consumeMatterInputDraft(matter).then(cleared => {
      if (cleared && alive && draftKeyRef.current === matter) { textRef.current = getDraft(matter); setTextState(textRef.current) }
    }).catch(() => {})
    return () => { alive = false }
  }, [matter, localInputs])
  const isTask = detail.data?.matter.kind === 'task'
  const inputHint = matterInputHint(detail.data, lang)
  const nativeStart = matter ? detail.data?.nativeStart : undefined
  const opt = options.data
  // 另做一份:默认挑一位不是原来那位的可用执行者(主人可以再换)
  useEffect(() => {
    if (!fork || providerId || !opt) return
    const other = opt.providers.find(p => p.available && p.id !== excludeProvider)
    if (other) setProviderId(other.id)
  }, [fork, providerId, opt, excludeProvider])
  const project = opt?.projects.find((p) => p.id === projectId) ?? opt?.projects[0]
  const provider = providerId ? opt?.providers.find((p) => p.id === providerId) : null
  const canPickModel = !matter && !!provider?.capabilities.features.modelCatalog
  const models = useQuery(`entryModels:${provider?.id ?? ''}:${project?.id ?? ''}`, () => backend.entryModels(provider!.id, project?.id), { enabled: adjust && canPickModel })
  const model = modelId ? models.data?.models.find(m => m.id === modelId) : undefined
  const execution = model ? { model: model.id, ...(effort ? { reasoningEffort: effort } : {}) } : undefined
  // 实际会接手的执行者:没选 ⇒ 项目自己的 ⇒ 电脑的默认(与 daemon 建任务同一个顺序);免审的不收 until
  const effectiveProvider = provider ?? opt?.providers.find(p => p.id === (project?.providerId ?? opt?.defaultProviderId))
  const unattended = effectiveProvider?.capabilities.permissions === 'unattended'
  const untilShown = !matter && !!project && isolated
  const untilFilled = untilShown && untilOn && !!untilCmd.trim()
  const untilErr = untilFilled ? untilDraftError(untilCmd) : null
  const until = untilShown && untilOn ? untilRequest({ command: untilCmd, maxRounds: untilRounds }, { isolated, unattended }) : undefined
  // 填了却带不出去(格式不对 / 免审执行者)⇒ 锁住提交,不悄悄当成没填
  const untilBlocked = untilFilled && !until
  const untilConfirm = until ? untilConfirmation(until, lang) : null

  // 不在线(连接中 / 离线 / 撤销)⇒ 草稿照写,「交给 CC」锁住,ConnectionNotice 说明原因。
  const online = canSubmit(conn) && recovery.phase === 'ready' && (backend.mode !== 'live' || !!recovery.scope && recovery.scope === session.inputScope)
  const firstSendReady = !matter || (detail.fresh && !detail.loading && !detail.error)
  const retryDraft = localInputs.some(row => row.text === text.trim() && ['uncertain', 'failed'].includes(row.status))
  const sendInput = async (rawText: string, runId?: string, retry?: InputSnapshot) => {
    if (sending.current || !online) return
    const atGen = pairingGen()
    const journalGen = matterInputState.generation()
    sending.current = true; setBusy(true); setOutcome(null); setInputNotice(null)
    let snapshot: InputSnapshot
    try {
      // 补一句带的图(2026-10-06):新的一句才带当前选的图;重发沿用记录里那一组(图已经在电脑上了)
      const materials = !retry && images.length ? { draftId: materialDraftId(matter!), attachmentIds: images.map(i => i.id) } : undefined
      snapshot = await matterInputState.prepare(matter!, rawText, runId, retry, backend.mode === 'live', materials)
    } catch (e) {
      sending.current = false
      if (atGen === pairingGen()) {
        setBusy(false)
        setInputNotice(e instanceof InputJournalError && e.code === 'input_scope' ? null : t(lang, e instanceof InputJournalError && e.code === 'input_capacity' ? 'input.capacity' : 'input.storageNotSent'))
      }
      return
    }
    if (atGen !== pairingGen() || journalGen !== matterInputState.generation() || !canSubmit(backend.connection())) { sending.current = false; setBusy(false); return }
    const r = await submit(`compose:${snapshot.taskId}`, async () => {
      const withImages = snapshot.attachmentIds?.length && snapshot.draftId ? { draftId: snapshot.draftId, attachmentIds: snapshot.attachmentIds } : undefined
      // 这一屏里还拿着图的就先传(断点续传;传完的不再传);只剩记录、图已不在手里的,直接按 id 引用
      if (withImages) {
        const local = images.filter(i => withImages.attachmentIds.includes(i.id))
        if (local.length) await uploadImages(backend, withImages.draftId, local, bytesToBase64)
      }
      const opts = { ...(snapshot.runId ? { runId: snapshot.runId } : {}), ...(withImages ?? {}) }
      const result = await backend.say(snapshot.taskId, snapshot.text, snapshot.requestId, Object.keys(opts).length ? opts : undefined)
      if (result.kind !== 'task' || result.task.id !== snapshot.taskId) throw new BackendError('unknown')
      if (result.input && !matchesMatterInput(snapshot, result.input)) throw new BackendError('input_conflict')
      // A subscription/GET may already have a newer receipt while this POST waited.
      // Compare the prepared row itself so even a later retry cannot accept this response.
      const current = matterInputs(snapshot.taskId).find(row => row.requestId === snapshot.requestId)
      if (current !== snapshot || current.status !== 'submitting') return
      await updateMatterInput(snapshot, { status: result.input?.status ?? 'accepted' }, atGen, journalGen)
    })
    sending.current = false
    if (atGen !== pairingGen() || journalGen !== matterInputState.generation() || draftKeyRef.current !== snapshot.taskId) return
    setBusy(false)
    if (r === 'ok' && snapshot.attachmentIds?.length) { setImages(cur => cur.filter(i => !snapshot.attachmentIds!.includes(i.id))); setImageNote(null) }
    if (r !== 'ok') {
      // 重连查询若已核实真正回执,较晚的传输错误不能把它降成“不确定”。
      const current = matterInputs(snapshot.taskId).find(row => row.requestId === snapshot.requestId)
      if (!current || ['submitting', 'accepted', 'uncertain', 'failed', 'refused'].includes(current.status)) {
        await updateMatterInput(snapshot, inputFailure(r === 'busy' ? 'busy' : r.error), atGen, journalGen).catch(() => {})
      }
    }
    void refreshDetail()
  }
  const send = async () => {
    const rawText = textRef.current
    const body = rawText.trim()
    if (!body || sending.current || !online) return
    // 说一句 / 交办超过 20 000 字:必然被拒,就在手机上拦下,请求不发、草稿留着
    if (composeTooLong(body)) { setOutcome('tooLong'); return }
    if (matter) {
      const retry = matterInputs(matter).findLast(row => row.text === body && ['uncertain', 'failed'].includes(row.status))
      if (retry) { await sendInput(retry.rawText, retry.runId, retry); return }
      if (!firstSendReady) return
      if (isTask) { await sendInput(rawText, detail.data?.runId); return }
    }
    const atGen = pairingGen()
    const myKey = draftKey
    sending.current = true
    setBusy(true); setOutcome(null)
    let newId: string | null = null
    const r = await submit(`compose:${draftKey}`, async () => {
      // 同一份草稿、同样正文重发(「不确定」之后再点)⇒ 同一个 requestId,daemon 去重,不会说两遍。
      const materials = !matter && images.length ? { draftId: materialDraftId(draftKey), attachmentIds: images.map(i => i.id) } : undefined
      // 换了图或模型就是新的一件:requestId 跟着正文、图、模型一起定
      const requestId = requestIdFor(draftKey, [body, materials?.attachmentIds.join(',') ?? '', execution ? JSON.stringify(execution) : '', project && isolated ? `worktree:${baseName}` : '', until ? `until:${until.maxRounds}:${until.command}` : ''].join('\u0000'))
      if (matter) await backend.say(matter, body, requestId)
      else {
        if (materials) await uploadImages(backend, materials.draftId, images, bytesToBase64)
        newId = (await backend.create({ requestId, text: body, projectId: project?.id, ...(project && isolated ? { isolation: true, ...(baseName ? { base: baseName } : {}) } : {}), providerId: provider?.id, ...(materials ?? {}), ...(execution ? { execution } : {}), ...(until ? { until } : {}) })).matterId
      }
    })
    sending.current = false
    if (atGen !== pairingGen() || draftKeyRef.current !== myKey) return
    setBusy(false)
    if (r === 'busy') {
      setOutcome('busy')
    } else if (r === 'ok') {
      if (getDraft(myKey) === rawText) { deleteDraft(myKey); textRef.current = ''; setTextState('') }
      setImages([]); setImageNote(null)
      if (matter) router.back()
      else router.replace(`/matter/${encodeURIComponent(newId ?? '')}`)
    } else {
      setOutcome(composeOutcome(r.error))
    }
  }
  const restoreInput = (row: InputSnapshot) => {
    if (textRef.current.trim() && textRef.current !== row.rawText) { setInputNotice(t(lang, 'input.draftProtected')); return }
    setText(row.rawText); setInputNotice(null)
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        title={matter ? t(lang, 'compose.continueHint') : conversationText(lang, 'handoff')}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
          {matter ? (
            <>
              {inputHint ? <Txt role="meta" tone="inkSoft">{inputHint}</Txt> : null}
              {nativeStart ? (
                <View testID="compose-native-start" style={{ gap: space.xs }}>
                  {nativeStartLines(nativeStart, lang, detail.data?.matter.agentNames).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
                </View>
              ) : null}
            </>
          ) : null}
            <TextField
              testID="compose-input"
              autoFocus={focus}
              accessibilityLabel={matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.handoffTitle')}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={t(lang, 'compose.placeholder')}
              role="item"
              style={{ minHeight: matter ? 140 : 220, textAlignVertical: 'top' }}
            />
          <View style={{ gap: space.s }}>
              <ImageTray testID="compose-images" images={images} lang={lang} onRemove={id => { setImages(cur => cur.filter(i => i.id !== id)); setImageNote(null) }} />
              {imageNote ? <Txt testID="compose-image-note" role="meta" tone="inkSoft">{imageNote}</Txt> : null}
              <Pressable testID="compose-add-image" accessibilityRole="button" accessibilityLabel={t(lang, 'images.add')}
                disabled={busy || images.length >= MAX_IMAGES} onPress={() => { void addImages() }}
                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.s, opacity: busy || images.length >= MAX_IMAGES ? 0.55 : pressed ? 0.7 : 1 })}>
                <Icon name="plus" color={c.inkSoft} />
                <Txt role="meta" tone="inkSoft">{t(lang, 'images.add')}</Txt>
              </Pressable>
          </View>
          {matter ? null : (
            <Pressable accessibilityRole="button" testID="compose-adjust" accessibilityLabel={conversationText(lang, 'options')}
              onPress={() => setAdjust(true)} disabled={!opt}
              style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.s, opacity: !opt ? 0.55 : pressed ? 0.7 : 1 })}>
              <Txt role="meta" tone="inkSoft" style={{ flex: 1 }}>{conversationText(lang, 'options')}</Txt>
              <Icon name="chevronDown" color={c.inkSoft} />
            </Pressable>
          )}
          {untilConfirm ? (
            // 提交前把要无人值守跑的命令整条摆出来:等宽、不截断、不限行数(安全 6)
            <Card testID="compose-until-confirm" style={{ gap: space.xs }}>
              <Txt role="meta" tone="inkSoft">{untilConfirm.heading}</Txt>
              <Txt testID="compose-until-confirm-command" role="code" content="user" selectable>{untilConfirm.command}</Txt>
              <Txt role="meta" tone="inkSoft">{untilConfirm.rounds}</Txt>
              <Txt role="caption" tone="inkSoft">{untilConfirm.note}</Txt>
            </Card>
          ) : null}
          {untilBlocked ? (
            <Pressable accessibilityRole="button" testID="compose-until-blocked" onPress={() => setAdjust(true)} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Txt role="meta" tone="inkSoft">{t(lang, unattended ? 'until.unattended' : untilErr === 'multiline' ? 'until.multiline' : 'until.tooLong')}</Txt>
            </Pressable>
          ) : null}
          <Button kind="primary" testID="compose-send" label={t(lang, isTask ? 'input.send' : 'compose.send')} onPress={send} disabled={!text.trim() || !online || (!firstSendReady && !retryDraft) || (!matter && !!project && isolated && baseInvalid) || untilBlocked} busy={busy} />
          <ConnectionNotice />
          {recovery.phase !== 'ready' ? <View style={{ gap: space.s }}>
            <Txt testID="input-recovery-state" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, recovery.phase === 'loading' ? 'input.recovering' : 'input.recoveryFailed')}</Txt>
            {recovery.phase === 'error' ? <Button kind="secondary" testID="input-recovery-retry" label={t(lang, 'input.recoveryRetry')} onPress={() => void matterInputState.retryStorage(session.pairing).catch(() => {})} /> : null}
          </View> : null}
          {matter && !firstSendReady ? <View style={{ gap: space.xs }}>
            <Txt testID="compose-detail-state" role="meta" tone="inkSoft">{t(lang, detail.error ? 'input.detailUnavailable' : 'input.detailLoading')}</Txt>
            {detail.error ? <Button kind="secondary" testID="compose-detail-reload" label={t(lang, 'input.reload')} onPress={() => void refreshDetail()} disabled={!online} busy={detail.loading} /> : null}
          </View> : null}
          {outcome ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
              <Dot kind={composeOutcomeDot(outcome)} size={8} />
              <Txt testID={`compose-${outcome}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{composeOutcomeText(outcome, lang, matter ? detail.data?.task?.providerId ?? null : provider?.id ?? null, !!matter, matter ? detail.data?.matter.agentNames : provider ? { [provider.id]: provider.displayName } : undefined)}</Txt>
            </View>
          ) : null}
          {rows.length ? <InputReceipts rows={rows} onRestore={restoreInput} onRetry={row => void sendInput(row.rawText, row.runId, row)} disabled={busy || !online} /> : null}
          {inputNotice ? <Txt testID="compose-input-notice" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{inputNotice}</Txt> : null}
          {matter && rows.length ? <Button kind="secondary" testID="compose-progress" label={t(lang, 'input.viewProgress')} onPress={() => router.canGoBack() ? router.back() : router.replace(`/matter/${encodeURIComponent(matter)}`)} /> : null}
          <Txt role="small" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'compose.willAskYou')}</Txt>
          {matter ? null : (
            <Pressable accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setText(text.trim() ? `${text}\n${t(lang, 'compose.placeholder')}` : t(lang, 'compose.placeholder'))}>
              <Txt role="small" tone="inkSoft" style={{ textAlign: 'center', textDecorationLine: 'underline' }}>{t(lang, 'compose.orSay')}</Txt>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal visible={adjust} transparent animationType="slide" onRequestClose={() => setAdjust(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setAdjust(false)} />
        {/* 项目、执行者、模型、until 加起来会超过一屏:整张卡可以滚 */}
        <View testID="compose-adjust-sheet" style={{ backgroundColor: c.paper, maxHeight: '85%', borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.s }}>
          <Txt role="item" accessibilityRole="header">{t(lang, 'compose.adjustTitle')}</Txt>
          <Txt role="meta" tone="inkSoft" testID="compose-current-context">
            {t(lang, 'compose.usingContext')}{project?.name ?? '…'} · {provider?.displayName ?? t(lang, 'compose.ccArranges')}{model ? ` · ${model.displayName}${effort ? ` · ${effortLabel(effort, lang)}` : ''}` : ''}
          </Txt>
          <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.project')}</Txt>
          {opt?.projects.map((p) => <ChoiceRow key={p.id} label={p.name} content="user" on={p.id === project?.id} onPress={() => setProjectId(p.id)} />)}
          {project ? <ChoiceRow testID="compose-isolation" label={t(lang, 'compose.isolation')} on={isolated} onPress={() => setIsolated(v => !v)} /> : null}
          {project && isolated ? <Txt role="caption" tone="inkSoft">{t(lang, 'compose.isolationHint')}</Txt> : null}
          {project && isolated ? (
            <View style={{ gap: space.xs }}>
              <Txt role="caption" tone="inkSoft">{t(lang, 'compose.base')}</Txt>
              <TextField testID="compose-base" value={base} onChangeText={setBase} placeholder={t(lang, 'compose.basePlaceholder')} autoCapitalize="none" autoCorrect={false} maxLength={200}
                style={{ paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: baseInvalid ? c.bad : c.hair }} />
              {baseInvalid ? <Txt role="caption" tone="bad">{t(lang, 'compose.baseInvalid')}</Txt> : null}
            </View>
          ) : null}
          {untilShown ? <ChoiceRow testID="compose-until" label={t(lang, 'until.toggle')} on={untilOn} onPress={() => setUntilOn(v => !v)} /> : null}
          {untilShown && untilOn ? (
            <View testID="compose-until-section" style={{ gap: space.xs }}>
              {unattended ? <Txt testID="compose-until-unattended" role="caption" tone="inkSoft">{t(lang, 'until.unattended')}</Txt> : null}
              <Txt role="caption" tone="inkSoft">{t(lang, 'until.command')}</Txt>
              {/* 不设 maxLength:粘贴超长会被悄悄截掉,跑的就不是主人写的那条了;超了只提示 */}
              <TextField testID="compose-until-command" role="code" value={untilCmd} onChangeText={setUntilCmd} placeholder={t(lang, 'until.commandPlaceholder')}
                accessibilityLabel={t(lang, 'until.command')} autoCapitalize="none" autoCorrect={false} spellCheck={false}
                style={{ paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: untilErr ? c.bad : c.hair }} />
              {untilErr ? <Txt testID="compose-until-error" role="caption" tone="bad">{t(lang, untilErr === 'multiline' ? 'until.multiline' : 'until.tooLong')}</Txt> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, marginTop: space.s }}>
                <Txt role="caption" tone="inkSoft" style={{ flex: 1 }}>{t(lang, 'until.rounds')}</Txt>
                <Pressable testID="compose-until-fewer" accessibilityRole="button" accessibilityLabel={t(lang, 'until.fewer')} disabled={untilRounds <= 1} onPress={() => setUntilRounds(n => clampRounds(n - 1))}
                  style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: untilRounds <= 1 ? 0.4 : 1 }}>
                  <Txt role="item" tone="accent">−</Txt>
                </Pressable>
                <Txt testID="compose-until-rounds" role="item" accessibilityLiveRegion="polite">{t(lang, 'until.roundsValue', { n: untilRounds })}</Txt>
                <Pressable testID="compose-until-more" accessibilityRole="button" accessibilityLabel={t(lang, 'until.more')} disabled={untilRounds >= UNTIL_MAX_ROUNDS} onPress={() => setUntilRounds(n => clampRounds(n + 1))}
                  style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: untilRounds >= UNTIL_MAX_ROUNDS ? 0.4 : 1 }}>
                  <Txt role="item" tone="accent">+</Txt>
                </Pressable>
              </View>
              <Txt role="caption" tone="inkSoft">{t(lang, 'until.note')}</Txt>
            </View>
          ) : null}
          <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.executor')}</Txt>
          <ChoiceRow label={t(lang, 'compose.ccArranges')} on={!provider} onPress={() => setProviderId(null)} />
          {opt?.providers.filter((p) => p.available).map((p) => <ChoiceRow key={p.id} label={p.displayName} on={p.id === provider?.id} onPress={() => setProviderId(p.id)} />)}
          {canPickModel ? (
            <>
              <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.model')}</Txt>
              {models.loading && !models.data ? <Txt testID="compose-models-loading" role="meta" tone="inkSoft">{t(lang, 'progress.loading')}</Txt> : null}
              {models.error && !models.data ? <Txt testID="compose-models-failed" role="meta" tone="inkSoft">{t(lang, 'compose.modelsUnavailable')}</Txt> : null}
              {models.data ? <ChoiceRow label={t(lang, 'compose.modelDefault')} on={!modelId} onPress={() => { setModelId(null); setEffort(null) }} /> : null}
              {models.data?.models.map(m => <ChoiceRow key={m.id} label={m.displayName} on={m.id === modelId} onPress={() => { setModelId(m.id); setEffort(null) }} />)}
              {model && model.reasoningEfforts.length > 1 ? (
                <>
                  <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.effort')}</Txt>
                  <ChoiceRow label={t(lang, 'compose.modelDefault')} on={!effort} onPress={() => setEffort(null)} />
                  {model.reasoningEfforts.map(e => <ChoiceRow key={e} label={effortLabel(e, lang)} on={e === effort} onPress={() => setEffort(e)} />)}
                </>
              ) : null}
            </>
          ) : null}
          <View style={{ marginTop: space.m }}><Button kind="secondary" label={t(lang, 'compose.done')} onPress={() => setAdjust(false)} /></View>
        </ScrollView>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  )
}

/** 思考强度的说法:常见几档翻成人话,认不出的原样给。 */
function effortLabel(e: string, lang: Lang): string {
  const known = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
  return (known as readonly string[]).includes(e) ? t(lang, `compose.effort.${e as typeof known[number]}`) : e
}
