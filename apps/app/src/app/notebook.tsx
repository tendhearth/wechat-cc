import { NotebookBody, type NotebookEntryT, type NotebookPenT } from '@wechat-cc/protocol'
import { isLoaded, loadAsync } from 'expo-font'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type TextLayoutEvent, type TextStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type Lang } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useNotebook } from '../state/notebook'
import { PEN_FONT_FILES } from '../ui/font-files'
import { useMotionEnabled } from '../ui/motion'
import { TextField } from '../ui/TextField'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { NOTEBOOK_UNSAVED_MS, notebookDate, notebookLineKey, notebookLines, notebookNeighbors, notebookPen, notebookSignature } from '../view/notebook'

const LINE = 36
const ownerText = { fontSize: 17, lineHeight: LINE, includeFontPadding: false, letterSpacing: 0 }
const ccText = { ...ownerText, fontSize: 19 }
const metaText = { lineHeight: LINE, includeFontPadding: false }

type PenFamily = keyof typeof PEN_FONT_FILES
const failedPens = new Set<PenFamily>()
function usePen(pen: NotebookPenT | undefined, pending: boolean) {
  const style = pen && notebookPen(pen)
  const family = pending ? undefined : style?.family
  const [, update] = useState(0)
  useEffect(() => {
    if (!family || failedPens.has(family) || isLoaded(family)) return
    let mounted = true
    void loadAsync(family, PEN_FONT_FILES[family])
      .catch(() => { failedPens.add(family) })
      .then(() => { if (mounted) update(n => n + 1) })
    return () => { mounted = false }
  }, [family])
  const loaded = family && isLoaded(family)
  return { ready: !pending && (!family || loaded || failedPens.has(family)), family: loaded ? family : undefined, color: style?.color }
}

function Rules({ height }: { height: number }) {
  const { c } = useTheme()
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      {Array.from({ length: Math.max(0, Math.ceil((height - 29) / LINE)) }, (_, i) => <View key={i} style={{
        position: 'absolute', left: 0, right: 0, top: i * LINE + 29, height: StyleSheet.hairlineWidth, backgroundColor: c.hair,
      }} />)}
    </View>
  )
}

function WordButton({ label, children, testID, disabled, emphasis, onPress }: {
  label: string; children?: string; testID?: string; disabled?: boolean; emphasis?: boolean; onPress(): void
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    testID={testID} disabled={disabled} onPress={onPress} hitSlop={emphasis ? 4 : undefined}
    style={{ minHeight: emphasis ? LINE : 44, minWidth: children ? 36 : undefined, justifyContent: 'center', alignItems: 'center', opacity: disabled ? 0.4 : 1 }}>
    <Txt role={children ? 'item' : 'meta'} tone={emphasis ? 'accent' : 'inkSoft'}>{children ?? label}</Txt>
  </Pressable>
}

export default function Notebook() {
  const { backend } = useBackendCtx()
  // The old native input must lose its draft and focus when the paired computer changes.
  const instance = useNotebook()
  return <NotebookScreen key={instance.notebook.id} {...instance} backend={backend} />
}

function NotebookScreen({ notebook, value, backend }: ReturnType<typeof useNotebook> & { backend: ReturnType<typeof useBackendCtx>['backend'] }) {
  const lang = useLang()
  const { c } = useTheme()
  const router = useRouter()
  const active = useRef(false)
  const [clock, setClock] = useState(Date.now)
  const [ref, setRef] = useState<{ id: string; day: string }>()
  const [menu, setMenu] = useState<NotebookEntryT>()
  const [keyboard, setKeyboard] = useState(false)
  const [composeHeight, setComposeHeight] = useState(0)
  const seenCc = useRef(new Set<string>())
  const pen = usePen(value.pen, value.penPending)
  const motion = useMotionEnabled()
  const today = value.day === value.today
  const ruled = value.paper === 'ruled'
  const { previous, next } = notebookNeighbors(value.day, value.days)
  const pending = new Map(value.pending.map(row => [row.clientId, row]))
  const saveable = NotebookBody.safeParse(value.draft).success

  useFocusEffect(useCallback(() => {
    active.current = true
    const isActive = () => active.current && AppState.currentState !== 'background'
    const sync = () => { if (isActive()) { void notebook.refresh(); void notebook.flush(isActive) } }
    let epoch: number | undefined
    const off = backend.onConnection(connection => {
      if (connection.state !== 'online' || epoch === connection.epoch) return
      epoch = connection.epoch
      queueMicrotask(sync)
    })
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') sync() })
    const reads = setInterval(() => { if (isActive()) void notebook.refresh() }, 60_000)
    const writes = setInterval(() => { if (isActive()) void notebook.flush(isActive) }, 30_000)
    sync()
    return () => {
      active.current = false
      off()
      foreground.remove()
      clearInterval(reads)
      clearInterval(writes)
    }
  }, [backend, notebook]))

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])

  useEffect(() => {
    const deadline = Math.min(...value.pending.map(row => row.createdAt + NOTEBOOK_UNSAVED_MS).filter(at => at > clock))
    if (!Number.isFinite(deadline)) return
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [value.pending, clock])

  const entries = notebookLines(value.entries, value.pending, value.day, value.today)
    .filter(entry => entry.author === 'owner' || (!today || !value.draft || seenCc.current.has(entry.id)))
  useEffect(() => {
    for (const entry of entries) if (entry.author === 'cc' && pen.ready) seenCc.current.add(entry.id)
  }, [entries, pen.ready])

  function turn(day?: string) {
    setRef(undefined)
    if (day !== value.today) Keyboard.dismiss()
    notebook.select(day)
  }

  return (
    <SafeAreaView edges={keyboard ? ['top'] : ['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'notebook.title')} onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />
      <View style={styles.header}>
        <View style={styles.dateNav}>
          <WordButton testID="notebook-previous" label={t(lang, 'notebook.previous')} disabled={!previous} onPress={() => turn(previous)}>‹</WordButton>
          <Txt role="meta">{notebookDate(value.day, lang, value.today)}</Txt>
          <WordButton testID="notebook-next" label={t(lang, 'notebook.next')} disabled={!next} onPress={() => turn(next)}>›</WordButton>
        </View>
        <WordButton label={t(lang, ruled ? 'notebook.plain' : 'notebook.ruled')} onPress={() => void notebook.paper(ruled ? 'plain' : 'ruled')} />
      </View>
      {!today ? <View style={styles.return}><WordButton testID="notebook-today" label={t(lang, 'notebook.back')} onPress={() => turn(value.today)} /></View> : null}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <NotebookPaper key={today ? 'today' : value.day} entries={entries} pending={pending} now={clock} lang={lang}
          pen={pen} ruled={ruled} follow={today} motion={motion} target={ref?.day === value.day ? ref : undefined}
          onStrike={setMenu} onReference={(day, id) => { notebook.select(day); if (day !== value.today) Keyboard.dismiss(); setRef({ id, day }) }} />
        {today ? (
          <View onLayout={event => setComposeHeight(event.nativeEvent.layout.height)} style={styles.composer}>
            {ruled ? <Rules height={composeHeight} /> : null}
            <TextField testID="notebook-input" accessibilityLabel={t(lang, 'notebook.placeholder')}
              autoFocus multiline submitBehavior="newline" value={value.draft} onChangeText={notebook.setDraft}
              placeholder={t(lang, 'notebook.placeholder')} style={styles.input} />
            {saveable ? <WordButton testID="notebook-write" label={t(lang, 'notebook.write')} emphasis
              onPress={() => notebook.write(() => active.current && AppState.currentState !== 'background')} /> : null}
          </View>
        ) : null}
      </KeyboardAvoidingView>
      <Modal visible={!!menu} transparent animationType="none" onRequestClose={() => setMenu(undefined)}>
        <View style={styles.flex}>
          <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setMenu(undefined)} />
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: c.paper, paddingHorizontal: space.xl }}>
            <WordButton label={t(lang, menu?.struckAt == null ? 'notebook.strike' : 'notebook.restore')}
              onPress={() => { if (menu) void notebook.strike(menu); setMenu(undefined) }} />
            <WordButton label={t(lang, 'common.cancel')} onPress={() => setMenu(undefined)} />
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

function NotebookPaper({ entries, pending, now, lang, pen, ruled, follow, motion, target, onStrike, onReference }: {
  entries: NotebookEntryT[]; pending: ReadonlyMap<string, { createdAt: number }>; now: number; lang: Lang;
  pen: ReturnType<typeof usePen>; ruled: boolean; follow: boolean; motion: boolean; target?: { id: string };
  onStrike(entry: NotebookEntryT): void; onReference(day: string, id: string): void
}) {
  const { c } = useTheme()
  const [height, setHeight] = useState(0)
  const [flash, setFlash] = useState<string>()
  const scroll = useRef<ScrollView>(null)
  const positions = useRef(new Map<string, number>())
  const atEnd = useRef(true)
  const handled = useRef<typeof target>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const locate = useCallback(() => {
    if (!target) { handled.current = undefined; return }
    const y = positions.current.get(target.id)
    if (y === undefined || handled.current === target) return
    handled.current = target
    scroll.current?.scrollTo({ y: Math.max(0, y - LINE), animated: motion })
    if (motion) {
      setFlash(target.id)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setFlash(undefined), 1500)
    }
  }, [motion, target])
  useEffect(locate, [locate])
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.fill} keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} scrollEventThrottle={32}
      onScroll={event => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
        atEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < LINE * 2
      }}
      onContentSizeChange={() => {
        if (target) locate()
        else if (follow && atEnd.current) scroll.current?.scrollToEnd({ animated: false })
      }}>
      <View style={styles.sheet} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
        {ruled ? <Rules height={height} /> : null}
        {entries.map((entry, i) => {
          const key = notebookLineKey(entry)
          const waiting = pending.get(key)
          const canStrike = entry.author === 'owner' && !waiting
          const signature = notebookSignature(entry, entries[i + 1], lang)
          const cc = entry.author === 'cc'
          const reference = entry.refDay && entry.refId ? { day: entry.refDay, id: entry.refId } : undefined
          if (cc && !pen.ready) return null
          return <View key={key} onLayout={event => {
            positions.current.set(entry.id, event.nativeEvent.layout.y)
            if (entry.id === target?.id) locate()
          }} style={[cc && styles.cc, styles.entry, flash === entry.id && motion ? { backgroundColor: c.hair } : undefined]}>
            {cc ? <>
              <PenText body={entry.body} family={pen.family} color={pen.color} />
              {signature ? <PenText body={signature} family={pen.family} color={pen.color} signature /> : null}
              {reference ? <Pressable accessibilityRole="button" onPress={() => onReference(reference.day, reference.id)}>
                <Txt role="meta" tone="inkSoft" style={styles.reference}>{reference.day === entry.day
                  ? t(lang, 'notebook.referenceAbove')
                  : t(lang, 'notebook.reference', { date: notebookDate(reference.day, lang) })}</Txt>
              </Pressable> : null}
            </> : (
              <Pressable disabled={!canStrike} onLongPress={canStrike ? () => onStrike(entry) : undefined}
                accessibilityActions={canStrike ? [{ name: 'longpress', label: t(lang, entry.struckAt === null ? 'notebook.strike' : 'notebook.restore') }] : undefined}
                onAccessibilityAction={canStrike ? () => onStrike(entry) : undefined} style={styles.ownerRow}>
                <Txt content="user" testID="notebook-owner-line" tone={entry.struckAt === null ? 'ink' : 'inkSoft'}
                  style={[ownerText, styles.flex, entry.struckAt === null ? undefined : styles.struck]}>{entry.body}</Txt>
                {waiting && now - waiting.createdAt >= NOTEBOOK_UNSAVED_MS
                  ? <Txt role="meta" tone="inkSoft" style={styles.unsaved}>{t(lang, 'notebook.unsaved')}</Txt> : null}
              </Pressable>
            )}
          </View>
        })}
      </View>
    </ScrollView>
  )
}

function PenText({ body, family, color, signature = false }: { body: string; family?: PenFamily; color?: string; signature?: boolean }) {
  const testID = signature ? undefined : 'notebook-cc-line'
  const face = { ...ccText, fontSize: signature ? 14 : 19, color }
  if (family) return <Txt content="user" testID={testID} style={{ ...face, fontFamily: family }}>{body}</Txt>
  return <SlantedText body={body} testID={testID} face={face} />
}

function SlantedText({ body, testID, face }: { body: string; testID?: string; face: TextStyle }) {
  const [lines, setLines] = useState<string[]>([])
  const penStyle: TextStyle = { ...face, fontFamily: 'NotoSerifSC-Regular' }
  function measure(event: TextLayoutEvent) {
    const next = event.nativeEvent.lines.map(line => line.text.replace(/[\r\n]+$/, ''))
    setLines(previous => previous.length === next.length && previous.every((line, i) => line === next[i]) ? previous : next)
  }
  return (
    <View accessible accessibilityLabel={body} testID={testID}>
      <Txt content="user" accessible={false} importantForAccessibility="no" style={[penStyle, styles.measure]}
        onTextLayout={measure}>{body}</Txt>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
        {lines.map((line, i) => <Txt key={i} content="user" numberOfLines={1} style={[penStyle, styles.slant, { top: i * LINE }]}>
          {line}
        </Txt>)}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  fill: { flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.l },
  dateNav: { flexDirection: 'row', alignItems: 'center' },
  return: { alignItems: 'flex-start', paddingHorizontal: space.xl },
  sheet: { flexGrow: 1, paddingTop: LINE, paddingHorizontal: space.xl },
  entry: { marginBottom: LINE },
  cc: { marginLeft: 32 },
  ownerRow: { flexDirection: 'row', gap: space.s, alignItems: 'flex-start' },
  struck: { textDecorationLine: 'line-through' },
  reference: { ...metaText, textDecorationLine: 'underline' },
  unsaved: { ...metaText, opacity: 0.55 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s, paddingHorizontal: space.xl },
  input: { ...ownerText, flex: 1, padding: 0, minHeight: LINE, maxHeight: LINE * 4, textAlignVertical: 'top' },
  measure: { opacity: 0 },
  slant: { position: 'absolute', left: 0, right: 0, transform: [{ skewX: '-9deg' }] },
})
