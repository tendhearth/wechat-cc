import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError, type MemoryVerdict } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { canSubmit } from '../view/connection'
import { TopBar } from '../ui/TopBar'
import { radius, space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

const VERDICTS: MemoryVerdict[] = ['wrong', 'outdated', 'delete']

// 「CC 记得你」(2026-10-06,与手机网页「CC 眼中的你」同一份):每晚整理出来的记忆;点一条可以说它记错了 / 过时了 / 不用记 ——
// 立刻拿掉,CC 记下这次纠正、当晚整理不写回(记忆整理步骤 A)。
export default function Memory() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const online = canSubmit(useConnection())
  const memory = useQuery('memory', () => backend.memory(), { refreshOnMount: true })
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const v = memory.data

  const correct = async (id: string, verdict: MemoryVerdict) => {
    if (busy) return
    setBusy(true); setNote(null)
    try { await backend.correctMemory(id, verdict); setOpen(null); await memory.refresh(); setNote(t(lang, 'memory.done')) }
    catch (e) { setNote(t(lang, e instanceof BackendError && e.code === 'not_found' ? 'memory.gone' : 'memory.failed')) }
    finally { setBusy(false) }
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'memory.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!v ? <Txt testID="memory-state" role="meta" tone="inkSoft">{t(lang, memory.error ? 'memory.unavailable' : 'progress.loading')}</Txt> : null}
        {v ? (
          <View style={{ gap: space.xs }}>
            <Txt role="title">{t(lang, v.mood === 'first' ? 'memory.first' : v.mood === 'changed' ? 'memory.changed' : 'memory.steady')}</Txt>
            {v.when_label ? <Txt role="meta" tone="inkSoft">{t(lang, 'memory.updated', { when: v.when_label })}</Txt> : null}
          </View>
        ) : null}
        {v?.sections.map(s => (
          <View key={s.name} style={{ gap: space.s }}>
            <Txt role="caption" tone="inkSoft" accessibilityRole="header">{s.name}</Txt>
            {s.items.map(it => (
              <View key={it.id ?? it.text} style={{ borderBottomWidth: 1, borderBottomColor: c.hair, paddingBottom: space.s, gap: space.s }}>
                <Pressable testID={`memory-item-${it.id ?? 'x'}`} accessibilityRole="button" accessibilityState={{ expanded: open === it.id }} disabled={!it.id}
                  onPress={() => { setOpen(open === it.id ? null : it.id); setNote(null) }}>
                  <Txt role="bubble" content="user">{it.person ? `${it.person.name} · ${it.person.rel}` : it.display}{it.due_label ? `  ${it.due_label}` : ''}</Txt>
                </Pressable>
                {it.id && open === it.id ? (
                  <View testID="memory-fix" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
                    {VERDICTS.map(vd => (
                      <Pressable key={vd} testID={`memory-fix-${vd}`} accessibilityRole="button" disabled={busy || !online} onPress={() => void correct(it.id!, vd)}
                        style={({ pressed }) => ({ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, opacity: busy || !online ? 0.55 : pressed ? 0.7 : 1 })}>
                        <Txt role="meta">{t(lang, `memory.verdict.${vd}`)}</Txt>
                      </Pressable>
                    ))}
                    <Pressable testID="memory-fix-cancel" accessibilityRole="button" onPress={() => setOpen(null)} style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m }}>
                      <Txt role="meta" tone="inkSoft">{t(lang, 'memory.cancel')}</Txt>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ))}
        {note ? <Txt testID="memory-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
        {v && v.mood !== 'first' ? <Txt role="meta" tone="inkSoft">{t(lang, 'memory.hint')}</Txt> : null}
      </ScrollView>
    </SafeAreaView>
  )
}
