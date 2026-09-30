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
import { serifFamily } from '../ui/fonts'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'

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
  const [outcome, setOutcome] = useState<null | 'failed' | 'uncertain' | 'busy'>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const sending = useRef(false)
  const options = useQuery('entryOptions', l => backend.entryOptions(l), { enabled: !matter })
  const opt = options.data
  const project = opt?.projects.find((p) => p.id === projectId) ?? opt?.projects[0]
  const provider = providerId ? opt?.providers.find((p) => p.id === providerId) : null

  // 电脑不在线 ⇒ 草稿照写,「交给 CC」锁住。TODO(计划 3):撤销(revoked)与暂时离线分开表达,并显示上次同步时间。
  const online = conn.state === 'online'
  const send = async () => {
    const body = text.trim()
    if (!body || sending.current || !online) return
    sending.current = true
    setBusy(true); setOutcome(null)
    let newId: string | null = null
    const r = await submit(`compose:${draftKey}`, async () => {
      if (matter) await backend.say(matter, body)
      else newId = (await backend.create({ requestId: requestIdFor(draftKey, body), text: body, projectId: project?.id, providerId: provider?.id })).matterId
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
      setOutcome(r.error === 'uncertain' ? 'uncertain' : 'failed')
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
          <Text style={{ color: c.muted, fontSize: 12, letterSpacing: 1 }}>{matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.eyebrow')}</Text>
          {matter ? null : (
            <>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 30, lineHeight: 38, fontFamily: serifFamily }}>{t(lang, 'compose.title')}</Text>
              <Text style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'compose.hint')}</Text>
            </>
          )}
          <Card>
            <TextInput
              testID="compose-input"
              accessibilityLabel={matter ? t(lang, 'compose.continueHint') : t(lang, 'compose.title')}
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
          {!online ? <Text testID="compose-offline" accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14, textAlign: 'center' }}>{t(lang, 'common.computerOffline')}</Text> : null}
          {outcome ? <Text testID={`compose-${outcome}`} accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14 }}>{t(lang, outcome === 'uncertain' ? 'compose.uncertain' : outcome === 'busy' ? 'compose.busy' : 'compose.failed')}</Text> : null}
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
