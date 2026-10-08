import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { canSubmit } from '../view/connection'
import { TextField } from '../ui/TextField'
import { TopBar } from '../ui/TopBar'
import { radius, space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

// 跟 CC 说用哪个后端 / 模型(2026-10-06,对标 Paseo / Orca 手机上换模型;与微信 `/api <模型>` 同一处):
// 只影响主人这条对话,下一句生效。模型列表借交办的模型目录(Claude / Codex 有),没有就手写;「跟随全局」= 不钉。
const MODEL_ID = /^[A-Za-z0-9._/:[\]-]{1,120}$/

export default function ChatModel() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const online = canSubmit(useConnection())
  const current = useQuery('chatModel', () => backend.chatModel(), { refreshOnMount: true })
  const v = current.data
  const [provider, setProvider] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { if (v && provider === null) { setProvider(v.provider); setModel(v.model) } }, [v, provider])
  const catalog = useQuery(`chatModelCatalog:${provider ?? ''}`, () => backend.entryModels(provider!), { enabled: !!provider })
  const models = catalog.data?.models ?? []
  const chosen = custom.trim() ? custom.trim() : model
  const invalid = !!custom.trim() && !MODEL_ID.test(custom.trim())
  const changed = !!v && !!provider && (provider !== v.provider || chosen !== v.model)

  const save = async () => {
    if (!provider || busy || invalid) return
    setBusy(true); setNote(null)
    try { await backend.setChatModel(provider, chosen ?? null); await current.refresh(); setCustom(''); setNote(t(lang, 'chatModel.saved')) }
    catch (e) { setNote(t(lang, e instanceof BackendError && e.code === 'unknown_provider' ? 'chatModel.unknown' : 'chatModel.failed')) }
    finally { setBusy(false) }
  }
  const option = (testID: string, label: string, selected: boolean, onPress: () => void, hint?: string) => (
    <Pressable key={testID} testID={testID} accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 44, paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}>
      <Txt role="meta" tone={selected ? 'ink' : 'inkSoft'}>{selected ? '●' : '○'}</Txt>
      <View style={{ flex: 1 }}>
        <Txt role="bubble" content="user">{label}</Txt>
        {hint ? <Txt role="caption" tone="inkSoft">{hint}</Txt> : null}
      </View>
    </Pressable>
  )

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'chatModel.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!v ? <Txt testID="chat-model-state" role="meta" tone="inkSoft">{t(lang, current.error ? 'chatModel.unavailable' : 'progress.loading')}</Txt> : null}
        {v && v.mode !== 'solo' ? <Txt role="meta" tone="inkSoft">{t(lang, 'chatModel.multi', { mode: v.mode })}</Txt> : null}
        {v ? (
          <View style={{ gap: space.xs }}>
            <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'chatModel.provider')}</Txt>
            {v.providers.map(p => option(`chat-model-provider-${p.id}`, p.name, provider === p.id, () => { if (provider !== p.id) { setProvider(p.id); setModel(null); setCustom('') } }))}
          </View>
        ) : null}
        {v && provider ? (
          <View style={{ gap: space.xs }}>
            <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'chatModel.model')}</Txt>
            {option('chat-model-default', t(lang, 'chatModel.followGlobal'), !custom.trim() && model === null, () => { setModel(null); setCustom('') },
              provider === v.provider && v.globalModel ? v.globalModel : undefined)}
            {models.map(m => option(`chat-model-${m.id}`, m.displayName || m.id, !custom.trim() && model === m.id, () => { setModel(m.id); setCustom('') }, m.displayName && m.displayName !== m.id ? m.id : undefined))}
            <TextField testID="chat-model-custom" value={custom} onChangeText={setCustom} placeholder={t(lang, 'chatModel.customPlaceholder')} autoCapitalize="none" autoCorrect={false}
              style={{ marginTop: space.s, paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: invalid ? c.bad : c.hair }} />
            {invalid ? <Txt role="caption" tone="bad">{t(lang, 'chatModel.invalid')}</Txt> : null}
          </View>
        ) : null}
        {v ? (
          <Pressable testID="chat-model-save" accessibilityRole="button" disabled={!online || busy || !changed || invalid} onPress={() => void save()}
            style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, opacity: !online || busy || !changed || invalid ? 0.5 : pressed ? 0.7 : 1 })}>
            <Txt role="meta">{t(lang, busy ? 'chatModel.saving' : 'chatModel.save')}</Txt>
          </Pressable>
        ) : null}
        {note ? <Txt testID="chat-model-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
        <Txt role="caption" tone="inkSoft">{t(lang, 'chatModel.scope')}</Txt>
      </ScrollView>
    </SafeAreaView>
  )
}
