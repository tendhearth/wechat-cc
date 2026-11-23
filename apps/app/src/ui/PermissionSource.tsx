import { useRef, useState, type RefObject } from 'react'
import { ScrollView, View } from 'react-native'
import { labelJoin, t, type Lang } from '../i18n'
import { useMotionEnabled } from './motion'
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

export function PermissionSource({ source, cwd, lang, sheet }: {
  source: string; cwd: string; lang: Lang; sheet: ReturnType<typeof usePermissionSource>
}) {
  const { anchor, expanded, onExpandedChange, onOpened } = sheet
  return <View ref={anchor} collapsable={false}>
    <Sheet quiet testID="approval-view-exact" title={t(lang, 'approval.viewExact')} expanded={expanded}
      onExpandedChange={onExpandedChange} onOpened={onOpened}>
      <View style={{ gap: space.s }}>
        <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
          <Txt selectable accessible accessibilityRole="text" role="code" testID="approval-exact-source">{source}</Txt>
        </ScrollView>
        {cwd ? <Txt selectable testID="approval-exact-cwd" role="small" tone="inkSoft">{labelJoin(t(lang, 'approval.workingDir'), cwd)}</Txt> : null}
      </View>
    </Sheet>
  </View>
}
