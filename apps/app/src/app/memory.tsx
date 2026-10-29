import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError, type MemoryVerdict, type TodoStatus } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { canSubmit } from '../view/connection'
import { memoryImportLine } from '../view/memory'
import { todoActionNote, todosView, type TodoItem } from '../view/todos'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Icon } from '../ui/Icon'
import { Portrait } from '../ui/Portrait'
import { TopBar } from '../ui/TopBar'
import { space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

const VERDICTS: MemoryVerdict[] = ['wrong', 'outdated', 'delete']

// 「CC 记得你」(2026-10-06,与手机网页「CC 眼中的你」同一份):每晚整理出来的记忆;点一条可以说它记错了 / 过时了 / 不用记 ——
// 立刻拿掉,CC 记下这次纠正、当晚整理不写回(记忆整理步骤 A)。
// 「CC 画的你」与「待办」(收敛清单 ④,2026-10-21)也住这一页:都是 CC 眼中的你,网页上原本也和回忆放在一起。
// 事实先出现,待办单独一页签;画像和收回的话按需展开。离线时修改按钮仍然锁住。
export default function Memory() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend, store } = useBackendCtx()
  const online = canSubmit(useConnection())
  const memory = useQuery('memory', () => backend.memory(), { refreshOnMount: true })
  const [tab, setTab] = useState<'facts' | 'todos'>('facts')
  const [showPortrait, setShowPortrait] = useState(false)
  const [showRetractions, setShowRetractions] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const v = memory.data
  const submit = useSubmit()
  const pocket = useQuery('pocket', () => backend.pocket(), { refreshOnMount: true })
  const todos = pocket.data ? todosView(pocket.data.todos, lang) : null
  const [showSettled, setShowSettled] = useState(false)
  const [todoBusy, setTodoBusy] = useState<number | null>(null)
  const [todoNote, setTodoNote] = useState<string | null>(null)
  // 同一帧连点两下:state 还没更新,靠 ref 挡住第二下
  const todoInFlight = useRef(false)
  // 收回的话(架构终态 G6,主人 10-26 第 2 / 3 条):主人收回过的那几句,每条能恢复;恢复后显示电脑回的那句(随之删掉的笔记行不会回来)
  const retractions = useQuery('memory-retractions', () => backend.memoryRetractions(), { refreshOnMount: true })
  const revalidateMemory = () => {
    // A read issued before a confirmed mutation may still be in flight; wait it out, then read the new state.
    const since = store.clock()
    return Promise.all([
      store.query('memory', () => backend.memory()).revalidate(since),
      store.query('memory-retractions', () => backend.memoryRetractions()).revalidate(since),
    ])
  }
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const restore = async (key: string) => {
    if (restoring || !online) return
    setRestoring(key); setRestoreNote(null); setNote(null)
    try {
      const r = await backend.restoreMemory(key)
      setRestoreNote(r.note)
      await revalidateMemory()
    } catch (e) { setRestoreNote(t(lang, e instanceof BackendError && e.code === 'not_found' ? 'memory.gone' : 'memory.retractions.failed')) }
    finally { setRestoring(null) }
  }

  const setTodo = async (id: number, status: TodoStatus) => {
    if (todoInFlight.current || !online) return
    todoInFlight.current = true
    setTodoBusy(id); setTodoNote(null)
    try {
      const r = await submit(`todo:${id}`, () => backend.setTodo(id, status))
      const key = todoActionNote(status, r)
      if (key) setTodoNote(t(lang, key))
      await pocket.refresh().catch(() => {}) // 失败会落在 pocket.error ⇒ 下面那句「可能不是最新的」
    } finally {
      todoInFlight.current = false
      setTodoBusy(null)
    }
  }
  const todoRow = (it: TodoItem, status: TodoStatus) => {
    const off = !online || todoBusy !== null
    const settled = status === 'active'
    return (
      <View key={it.id} testID={`todo-${it.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s }}>
        <View style={{ flex: 1, gap: space.xs }}>
          <Txt role="bubble" content="user" tone={settled ? 'inkSoft' : 'ink'} style={settled ? { textDecorationLine: 'line-through' } : undefined}>{it.text}</Txt>
          <Txt role="meta" tone="inkSoft" content="user">{it.meta}</Txt>
        </View>
        <Pressable testID={`todo-${settled ? 'restore' : 'done'}-${it.id}`} accessibilityRole="button" accessibilityState={{ disabled: off, busy: todoBusy === it.id }} disabled={off}
          onPress={() => void setTodo(it.id, status)}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m, opacity: off ? 0.55 : pressed ? 0.7 : 1 })}>
          <Txt role="meta">{t(lang, settled ? 'todos.restore' : 'todos.done')}</Txt>
        </Pressable>
      </View>
    )
  }

  const correct = async (id: string, verdict: MemoryVerdict) => {
    if (busy || !online) return
    setBusy(true); setNote(null); setRestoreNote(null)
    try {
      await backend.correctMemory(id, verdict)
      setOpen(null)
      await revalidateMemory()
      setNote(t(lang, 'memory.done'))
    }
    catch (e) { setNote(t(lang, e instanceof BackendError && e.code === 'not_found' ? 'memory.gone' : 'memory.failed')) }
    finally { setBusy(false) }
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={st(lang, 'memory')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space.xl }}>
          {(['facts', 'todos'] as const).map(value => <Pressable key={value} testID={`memory-tab-${value}`} accessibilityRole="tab" accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)} style={{ minHeight: 44, justifyContent: 'center', borderBottomWidth: tab === value ? 1 : 0, borderBottomColor: c.ink }}>
            <Txt role="body" tone={tab === value ? 'ink' : 'inkSoft'}>{value === 'facts' ? st(lang, 'facts') : t(lang, 'todos.title')}</Txt>
          </Pressable>)}
        </View>
        {tab === 'facts' ? <View testID="memory-facts" style={{ gap: space.l }}>
          {!v ? <Txt testID="memory-state" role="meta" tone="inkSoft">{t(lang, memory.error ? 'memory.unavailable' : 'progress.loading')}</Txt> : null}
          {v?.when_label ? <Txt role="meta" tone="inkSoft">{t(lang, 'memory.updated', { when: v.when_label })}</Txt> : null}
          {v?.mood === 'first' ? <Txt role="bubble" tone="inkSoft">{t(lang, 'memory.first')}</Txt> : null}
          {v?.sections.map(s => (
            <View key={s.name} style={{ gap: space.s }}>
              <Txt role="caption" tone="inkSoft" accessibilityRole="header">{s.name}</Txt>
              {s.items.map(it => (
                <View key={it.id ?? it.text} style={{ paddingVertical: space.s, gap: space.s }}>
                  <Pressable testID={`memory-item-${it.id ?? 'x'}`} accessibilityRole="button" accessibilityState={{ expanded: open === it.id }} disabled={!it.id}
                    onPress={() => { setOpen(open === it.id ? null : it.id); setNote(null) }} style={{ minHeight: 44, justifyContent: 'center' }}>
                    <Txt role="bubble" content="user">{it.person ? `${it.person.name} · ${it.person.rel}` : it.display}{it.due_label ? `  ${it.due_label}` : ''}</Txt>
                  </Pressable>
                  {/* 从别的助手导入的(PR 440):点开才显示出处 */}
                  {open !== null && open === it.id && memoryImportLine(it.sources, lang) ? <Txt testID="memory-source" role="caption" tone="inkSoft">{memoryImportLine(it.sources, lang)}</Txt> : null}
                  {it.id && open === it.id ? (
                    <View testID="memory-fix" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
                      {VERDICTS.map(vd => (
                        <Pressable key={vd} testID={`memory-fix-${vd}`} accessibilityRole="button" disabled={busy || !online} onPress={() => void correct(it.id!, vd)}
                          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m, opacity: busy || !online ? 0.55 : pressed ? 0.7 : 1 })}>
                          <Txt role="meta">{t(lang, `memory.verdict.${vd}`)}</Txt>
                        </Pressable>
                      ))}
                      <Pressable testID="memory-fix-cancel" accessibilityRole="button" onPress={() => setOpen(null)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m }}>
                        <Txt role="meta" tone="inkSoft">{t(lang, 'memory.cancel')}</Txt>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
          {note ? <Txt testID="memory-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
          {memory.error && v ? <Txt role="meta" tone="inkSoft">{t(lang, 'feedback.stale')}</Txt> : null}
          {v && v.mood !== 'first' ? <Txt role="meta" tone="inkSoft">{t(lang, 'memory.hint')}</Txt> : null}
          {retractions.data?.length ? <Pressable testID="memory-retractions-toggle" accessibilityRole="button" accessibilityState={{ expanded: showRetractions }} onPress={() => setShowRetractions(!showRetractions)}
            style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space.s }}>
            <Txt role="body" tone="inkSoft" style={{ flex: 1 }}>{st(lang, 'withdrawn', { n: retractions.data.length })}</Txt>
            <Icon name={showRetractions ? 'chevronDown' : 'chevronRight'} />
          </Pressable> : null}
          {showRetractions && retractions.data && retractions.data.length ? (
            <View testID="memory-retractions" style={{ gap: space.s }}>
              <Txt role="meta" tone="inkSoft">{t(lang, 'memory.retractions.hint')}</Txt>
              {[...retractions.data].reverse().map(r => (
                <View key={r.key} testID={`memory-retraction-${r.key}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s }}>
                  <View style={{ flex: 1, gap: space.xs }}>
                    <Txt role="bubble" content="user" tone="inkSoft" style={{ textDecorationLine: 'line-through' }}>{r.text}</Txt>
                    <Txt role="meta" tone="inkSoft" content="user">{[r.section, r.day].filter(Boolean).join(' · ')}</Txt>
                  </View>
                  <Pressable testID={`memory-restore-${r.key}`} accessibilityRole="button" accessibilityState={{ disabled: !online || restoring !== null, busy: restoring === r.key }} disabled={!online || restoring !== null}
                    onPress={() => void restore(r.key)}
                    style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m, opacity: !online || restoring !== null ? 0.55 : pressed ? 0.7 : 1 })}>
                    <Txt role="meta">{t(lang, 'memory.retractions.restore')}</Txt>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {restoreNote ? <Txt testID="memory-restore-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{restoreNote}</Txt> : null}
          {pocket.data?.portraitPng ? <>
            <Pressable testID="memory-portrait-toggle" accessibilityRole="button" accessibilityState={{ expanded: showPortrait }} onPress={() => setShowPortrait(!showPortrait)}
              style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space.s }}>
              <Txt role="body" tone="inkSoft" style={{ flex: 1 }}>{st(lang, 'portrait')}</Txt>
              <Icon name={showPortrait ? 'chevronDown' : 'chevronRight'} />
            </Pressable>
            {showPortrait ? <View style={{ gap: space.m }}>
              <Txt testID="memory-portrait-note" role="meta" tone="inkSoft">{st(lang, 'portraitNote')}</Txt>
              <Portrait png={pocket.data.portraitPng} label={t(lang, 'portrait.caption')} />
            </View> : null}
          </> : null}
        </View> : <>
          {todos ? (
            <View testID="todos" style={{ gap: space.s }}>
              {todos.empty ? (
                <View testID="todos-empty" style={{ gap: space.xs }}>
                  <Txt role="bubble" tone="inkSoft">{todos.empty.line}</Txt>
                  <Txt role="meta" tone="inkSoft">{todos.empty.hint}</Txt>
                </View>
              ) : null}
              {todos.active.map(it => todoRow(it, 'resolved'))}
              {todos.settledToggle ? (
                <Pressable testID="todos-settled-toggle" accessibilityRole="button" accessibilityState={{ expanded: showSettled }} onPress={() => setShowSettled(!showSettled)}
                  style={{ minHeight: 44, justifyContent: 'center' }}>
                  <Txt role="meta" tone="inkSoft">{todos.settledToggle}</Txt>
                </Pressable>
              ) : null}
              {showSettled ? todos.settled.map(it => todoRow(it, 'active')) : null}
              {todoNote ? <Txt testID="todos-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{todoNote}</Txt> : null}
              {/* 手上有列表、但最近一次重拉失败了 ⇒ 别让人以为这就是现在的样子 */}
              {pocket.error ? <Txt testID="todos-stale" role="meta" tone="inkSoft">{t(lang, 'todos.stale')}</Txt> : null}
            </View>
          ) : pocket.error ? <Txt testID="todos-unavailable" role="meta" tone="inkSoft">{t(lang, 'todos.unavailable')}</Txt> : null}
          {!todos && !pocket.error ? <Txt role="meta" tone="inkSoft">{t(lang, 'progress.loading')}</Txt> : null}
        </>}
      </ScrollView>
    </SafeAreaView>
  )
}
