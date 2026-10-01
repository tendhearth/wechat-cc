import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { deleteDraft, getDraft, requestIdFor, setDraft } from '../state/drafts'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { useBackendCtx } from '../state/BackendProvider'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ChoiceRow } from '../ui/Rows'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Dot } from '../ui/Dot'
import { TextField } from '../ui/TextField'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { composeOutcome, composeOutcomeDot, composeOutcomeText, composeTooLong, type ComposeOutcome } from '../view/compose'
import { nativeStartLines } from '../view/continue'
import { canSubmit } from '../view/connection'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default function Compose() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const params = useLocalSearchParams<{ matter?: string; focus?: string }>()
  const matter = one(params.matter) || undefined
  // 从「接着做」进来:输入框直接聚焦,主人接着打字(spec §4.4)
  const focus = one(params.focus) === '1'
  const draftKey = matter ?? 'new'
  const [text, setTextState] = useState(() => getDraft(draftKey))
  const setText = (v: string) => { setDraft(draftKey, v); setTextState(v) }
  const [adjust, setAdjust] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<null | ComposeOutcome>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const sending = useRef(false)
  const options = useQuery('entryOptions', l => backend.entryOptions(l), { enabled: !matter })
  // 说的是一件事:读它的详情(与进展页共用缓存)—— 接过来还没发第一句的,顶上说清第一句会怎样;失败句要知道执行者叫什么
  const detail = useQuery(`matter:${matter ?? ''}`, l => backend.matter(matter ?? '', l), { enabled: !!matter })
  const nativeStart = matter ? detail.data?.nativeStart : undefined
  const opt = options.data
  const project = opt?.projects.find((p) => p.id === projectId) ?? opt?.projects[0]
  const provider = providerId ? opt?.providers.find((p) => p.id === providerId) : null

  // 不在线(连接中 / 离线 / 撤销)⇒ 草稿照写,「交给 CC」锁住,ConnectionNotice 说明原因。
  // busy = 同一份草稿已在发(本机);ccBusy = CC 这一轮还在跑(daemon 409),草稿留着,等这一轮做完再发;tooLong = 正文超过上限(说一句与交办同一上限)。
  const online = canSubmit(conn)
  const send = async () => {
    const body = text.trim()
    if (!body || sending.current || !online) return
    // 说一句 / 交办超过 20 000 字:必然被拒,就在手机上拦下,请求不发、草稿留着
    if (composeTooLong(body)) { setOutcome('tooLong'); return }
    sending.current = true
    setBusy(true); setOutcome(null)
    let newId: string | null = null
    const r = await submit(`compose:${draftKey}`, async () => {
      // 同一份草稿、同样正文重发(「不确定」之后再点)⇒ 同一个 requestId,daemon 去重,不会说两遍。
      const requestId = requestIdFor(draftKey, body)
      if (matter) await backend.say(matter, body, requestId)
      else newId = (await backend.create({ requestId, text: body, projectId: project?.id, providerId: provider?.id })).matterId
    })
    sending.current = false
    setBusy(false)
    if (r === 'busy') {
      setOutcome('busy')
    } else if (r === 'ok') {
      deleteDraft(draftKey)
      if (matter) router.back()
      else router.replace(`/matter/${encodeURIComponent(newId ?? '')}`)
    } else {
      setOutcome(composeOutcome(r.error))
    }
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onAvatar={() => router.push('/settings')}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
          {matter ? (
            <>
              <Txt role="caption" tone="inkSoft">{t(lang, 'compose.continueHint')}</Txt>
              {nativeStart ? (
                <View testID="compose-native-start" style={{ gap: space.xs }}>
                  {nativeStartLines(nativeStart, lang).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
                </View>
              ) : null}
            </>
          ) : (
            <>
              <Txt role="title" accessibilityRole="header">{t(lang, 'compose.handoffTitle')}</Txt>
              <Txt role="bubble" tone="inkSoft">{t(lang, 'compose.handoffHint')}</Txt>
            </>
          )}
          <Card>
            <TextField
              testID="compose-input"
              autoFocus={focus}
              accessibilityLabel={matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.handoffTitle')}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={t(lang, 'compose.placeholder')}
              role="item"
              style={{ minHeight: 140, textAlignVertical: 'top' }}
            />
          </Card>
          {matter ? null : (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m }}>
              <Txt role="meta" tone="inkSoft" numberOfLines={2} style={{ flex: 1 }}>
                {t(lang, 'compose.usingContext')}{project?.name ?? '…'} · {provider?.displayName ?? t(lang, 'compose.ccArranges')}
              </Txt>
              <Pressable accessibilityRole="button" testID="compose-adjust" onPress={() => setAdjust(true)} style={{ minHeight: 44, justifyContent: 'center' }} disabled={!opt}>
                <Txt role="meta" tone="accent">{t(lang, 'compose.adjust')}</Txt>
              </Pressable>
            </View>
          )}
          <Button kind="primary" testID="compose-send" label={t(lang, 'compose.send')} onPress={send} disabled={!text.trim() || !online} busy={busy} />
          <ConnectionNotice />
          {outcome ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
              <Dot kind={composeOutcomeDot(outcome)} size={8} />
              <Txt testID={`compose-${outcome}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{composeOutcomeText(outcome, lang, matter ? detail.data?.task?.providerId ?? null : provider?.id ?? null)}</Txt>
            </View>
          ) : null}
          <Txt role="small" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'compose.willAskYou')}</Txt>
          {matter ? null : (
            <Pressable accessibilityRole="button" onPress={() => setText(text.trim() ? `${text}\n${t(lang, 'compose.placeholder')}` : t(lang, 'compose.placeholder'))}>
              <Txt role="small" tone="inkSoft" style={{ textAlign: 'center', textDecorationLine: 'underline' }}>{t(lang, 'compose.orSay')}</Txt>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal visible={adjust} transparent animationType="slide" onRequestClose={() => setAdjust(false)}>
        <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setAdjust(false)} />
        <View testID="compose-adjust-sheet" style={{ backgroundColor: c.paper, padding: space.xl, gap: space.s, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
          <Txt role="item" accessibilityRole="header">{t(lang, 'compose.adjustTitle')}</Txt>
          <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.project')}</Txt>
          {opt?.projects.map((p) => <ChoiceRow key={p.id} label={p.name} content="user" on={p.id === project?.id} onPress={() => setProjectId(p.id)} />)}
          <Txt role="meta" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'compose.executor')}</Txt>
          <ChoiceRow label={t(lang, 'compose.ccArranges')} on={!provider} onPress={() => setProviderId(null)} />
          {opt?.providers.filter((p) => p.available).map((p) => <ChoiceRow key={p.id} label={p.displayName} on={p.id === provider?.id} onPress={() => setProviderId(p.id)} />)}
          <View style={{ marginTop: space.m }}><Button kind="secondary" label={t(lang, 'compose.done')} onPress={() => setAdjust(false)} /></View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}
