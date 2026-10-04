import { useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { getDraft, setDraft } from '../state/drafts'
import { inputNeedsChecking, matterInputState, type InputSnapshot } from '../state/matter-inputs'
import { useSession } from '../state/session'
import { useAllMatterInputs, useInputRecovery } from '../state/useMatterInputs'
import { Button } from '../ui/Button'
import { InputReceipts } from '../ui/InputReceipts'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

/** Kept requests stay discoverable even when a task is archived or its detail exceeds a relay frame. */
export default function SavedInputs() {
  const { c } = useTheme(), lang = useLang(), router = useRouter(), session = useSession()
  const rows = useAllMatterInputs().filter(inputNeedsChecking)
  const recovery = useInputRecovery()
  const [notice, setNotice] = useState<string | null>(null)
  const open = (row: InputSnapshot, restore: boolean) => {
    const draft = getDraft(row.taskId)
    if (restore && draft.trim() && draft !== row.rawText) { setNotice(t(lang, 'input.draftProtected')); return }
    if (restore) setDraft(row.taskId, row.rawText)
    router.push(`/compose?matter=${encodeURIComponent(row.taskId)}`)
  }
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
    <TopBar title={t(lang, 'input.savedTitle')} onBack={() => router.back()} onAvatar={() => router.push('/settings')} />
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.l }}>
      <Txt role="meta" tone="inkSoft">{t(lang, 'input.savedHint')}</Txt>
      {recovery.phase !== 'ready' ? <View style={{ gap: space.s }}>
        <Txt role="meta" tone="inkSoft">{t(lang, recovery.phase === 'loading' ? 'input.recovering' : 'input.recoveryFailed')}</Txt>
        {recovery.phase === 'error' ? <Button kind="secondary" label={t(lang, 'input.recoveryRetry')} onPress={() => void matterInputState.retryStorage(session.pairing).catch(() => {})} /> : null}
      </View> : null}
      {rows.length === 0 && recovery.phase === 'ready' ? <Txt role="bubble" tone="inkSoft">{t(lang, 'input.savedEmpty')}</Txt> : null}
      {rows.map(row => <View key={`${row.taskId}:${row.requestId}`} style={{ gap: space.s }}>
        <InputReceipts rows={[row]} onRestore={r => open(r, true)} />
        <Button kind="secondary" label={t(lang, 'input.openTask')} onPress={() => open(row, false)} />
      </View>)}
      {notice ? <Txt role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{notice}</Txt> : null}
    </ScrollView>
  </SafeAreaView>
}
