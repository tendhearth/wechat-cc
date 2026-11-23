import { useRef, useState, type RefObject } from 'react'
import { ScrollView, View } from 'react-native'
import { t, type Lang } from '../i18n'
import { approvalDirectory } from '../view/approval'
import { useMotionEnabled } from './motion'
import { PermissionText } from './PermissionText'
import { Sheet } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'

// React Native exposes this on the ScrollView ref. The legacy declarations
// omit it, and measureLayout needs a native view reference under Fabric.
type ScrollWithContent = ScrollView & { getInnerViewRef(): ReturnType<ScrollView['getNativeScrollRef']> }

export function usePermissionSource(scroll: RefObject<ScrollView | null> | undefined) {
  const animated = useMotionEnabled()
  const anchor = useRef<View>(null)
  const [expanded, setExpanded] = useState(false)
  const jump = useRef(false)
  const ready = useRef(false)

  const scrollToSource = () => {
    if (!jump.current) return
    const target = scroll?.current as ScrollWithContent | null | undefined
    if (!target) return
    const content = target.getInnerViewRef?.()
    if (content) anchor.current?.measureLayout(content, (_x, y) => {
      if (jump.current) {
        jump.current = false
        target.scrollTo({ y, animated })
      }
    })
  }

  return {
    anchor, expanded,
    openFromPreview: () => {
      jump.current = true
      if (expanded && ready.current) scrollToSource()
      else setExpanded(true)
    },
    onExpandedChange: (open: boolean) => {
      jump.current = false
      ready.current = false
      setExpanded(open)
    },
    onOpened: () => {
      ready.current = true
      scrollToSource()
    },
  }
}

export function PermissionSource({ source, projectPath, cwd, lang, sheet, kind = 'original', summaryOnly = false }: {
  source: string; projectPath: string; cwd?: string | undefined; lang: Lang; sheet: ReturnType<typeof usePermissionSource>
  kind?: 'original' | 'received' | 'summary'; summaryOnly?: boolean
}) {
  const { anchor, expanded, onExpandedChange, onOpened } = sheet
  const directory = approvalDirectory(cwd, projectPath, lang)
  const title = kind === 'summary' ? 'terminal.viewSummary' : kind === 'received' ? 'terminal.expandReceived' : 'approval.viewExact'
  const testID = kind === 'original' ? 'approval-view-exact' : `terminal-view-${kind}`
  const sourceID = kind === 'original' ? 'approval-exact-source' : `terminal-${kind}-source`
  return <View ref={anchor} collapsable={false}>
    <Sheet quiet testID={testID} title={t(lang, title)} expanded={expanded}
      onExpandedChange={onExpandedChange} onOpened={onOpened}>
      <View style={{ gap: space.s }}>
        {kind === 'summary' && !summaryOnly ? <Txt role="small" tone="inkSoft">{t(lang, 'terminal.summaryWhitespace')}</Txt> : null}
        <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
          <PermissionText selectable accessible accessibilityRole="text" role="code" testID={sourceID} lang={lang} value={source} />
        </ScrollView>
        {directory ? <PermissionText selectable testID="approval-exact-cwd" role="small" tone="inkSoft" lang={lang} value={directory} /> : null}
      </View>
    </Sheet>
  </View>
}
