import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { deleteDraft, getDraft, requestIdFor, setDraft } from '../state/drafts'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { useBackendCtx } from '../state/BackendProvider'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { serifFamily } from '../ui/fonts'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { composeOutcome, composeTooLong } from '../view/compose'
import { canSubmit } from '../view/connection'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default function Compose() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const matter = one(useLocalSearchParams<{ matter?: string }>().matter) || undefined
  const draftKey = matter ?? 'new'
  const [text, setTextState] = useState(() => getDraft(draftKey))
  const setText = (v: string) => { setDraft(draftKey, v); setTextState(v) }
  const [note, setNote] = useState(false)
  const [adjust, setAdjust] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<null | 'failed' | 'uncertain' | 'busy' | 'ccBusy' | 'tooLong' | 'revoked'>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const sending = useRef(false)
  const options = useQuery('entryOptions', l => backend.entryOptions(l), { enabled: !matter })
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
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        connection={conn.state === 'online' ? 'online' : 'offline'}
        onAvatar={() => router.push('/settings')}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
          <Text style={{ color: c.muted, fontSize: 12, letterSpacing: 1 }}>{matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.handoffEyebrow')}</Text>
          {matter ? null : (
            <>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 30, lineHeight: 38, fontFamily: serifFamily }}>{t(lang, 'compose.handoffTitle')}</Text>
              <Text style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'compose.handoffHint')}</Text>
            </>
          )}
          <Card>
            <TextInput
              testID="compose-input"
              accessibilityLabel={matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.handoffTitle')}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={t(lang, 'compose.placeholder')}
              placeholderTextColor={c.muted}
              style={{ color: c.ink, fontSize: 17, lineHeight: 24, minHeight: 140, textAlignVertical: 'top' }}
            />
            <Pressable accessibilityRole="button" testID="compose-add-image" onPress={() => setNote(true)} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ color: c.muted, fontSize: 14 }}>＋ {t(lang, 'compose.addImage')}</Text>
            </Pressable>
            {note ? <Text testID="compose-image-note" accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 13 }}>{t(lang, 'compose.noImage')}</Text> : null}
          </Card>
          {matter ? null : (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m }}>
              <Text numberOfLines={2} style={{ flex: 1, color: c.muted, fontSize: 14 }}>
                {t(lang, 'compose.usingContext')}{project?.name ?? '…'} · {provider?.displayName ?? t(lang, 'compose.ccArranges')}
              </Text>
              <Pressable accessibilityRole="button" testID="compose-adjust" onPress={() => setAdjust(true)} style={{ minHeight: 44, justifyContent: 'center' }} disabled={!opt}>
                <Text style={{ color: c.ink, fontSize: 14, fontWeight: '600' }}>{t(lang, 'compose.adjust')}</Text>
              </Pressable>
            </View>
          )}
          <Button kind="primary" testID="compose-send" label={t(lang, 'compose.send')} onPress={send} disabled={!text.trim() || !online} busy={busy} />
          <ConnectionNotice />
          {outcome ? <Text testID={`compose-${outcome}`} accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14 }}>{t(lang, outcome === 'uncertain' ? 'compose.uncertain' : outcome === 'busy' ? 'compose.busy' : outcome === 'ccBusy' ? 'common.ccBusy' : outcome === 'tooLong' ? 'compose.tooLong' : outcome === 'revoked' ? 'conn.revokedTitle' : 'compose.failed')}</Text> : null}
          <Text style={{ color: c.muted, fontSize: 13, textAlign: 'center' }}>{t(lang, 'compose.willAskYou')}</Text>
          {matter ? null : (
            <Pressable accessibilityRole="button" onPress={() => setText(text.trim() ? `${text}\n${t(lang, 'compose.placeholder')}` : t(lang, 'compose.placeholder'))}>
              <Text style={{ color: c.muted, fontSize: 13, textAlign: 'center', textDecorationLine: 'underline' }}>{t(lang, 'compose.orSay')}</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal visible={adjust} transparent animationType="slide" onRequestClose={() => setAdjust(false)}>
        <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setAdjust(false)} />
        <View testID="compose-adjust-sheet" style={{ backgroundColor: c.card, padding: space.xl, gap: space.m, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card }}>
          <Text style={{ color: c.ink, fontSize: 18, fontFamily: serifFamily }}>{t(lang, 'compose.adjustTitle')}</Text>
          <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'compose.project')}</Text>
          {opt?.projects.map((p) => <Choice key={p.id} label={p.name} on={p.id === project?.id} onPress={() => setProjectId(p.id)} />)}
          <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'compose.executor')}</Text>
          <Choice label={t(lang, 'compose.ccArranges')} on={!provider} onPress={() => setProviderId(null)} />
          {opt?.providers.filter((p) => p.available).map((p) => <Choice key={p.id} label={p.displayName} on={p.id === provider?.id} onPress={() => setProviderId(p.id)} />)}
          <Button kind="secondary" label={t(lang, 'compose.done')} onPress={() => setAdjust(false)} />
        </View>
      </Modal>
    </SafeAreaView>
  )
}

function Choice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ minHeight: 44, paddingHorizontal: space.m, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? c.navOnBg : 'transparent' }}
    >
      <Text style={{ color: on ? c.navOnInk : c.ink, fontSize: 15 }}>{label}</Text>
    </Pressable>
  )
}
