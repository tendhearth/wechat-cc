import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Pressable, View } from 'react-native'
import { Icon } from './Icon'
import { useMotionEnabled } from './motion'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** Mount lazily; optionally retain stateful editors after closing, while immediately hiding their controls. */
export function Expansion({ open, children, onClosed, keepMounted = false }: { open: boolean; children: ReactNode; onClosed?: () => void; keepMounted?: boolean }) {
  const enabled = useMotionEnabled()
  const [rendered, setRendered] = useState(open)
  const [measured, setMeasured] = useState(0)
  const height = useRef(new Animated.Value(0)).current
  const opacity = useRef(new Animated.Value(open ? 1 : 0)).current
  const isOpen = useRef(open)
  const pendingClose = useRef(false)
  const generation = useRef(0)
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  const initialOpen = useRef(open)
  const interacted = useRef(false)
  if (initialOpen.current !== open) interacted.current = true
  if (isOpen.current && !open) pendingClose.current = true
  if (open) pendingClose.current = false
  isOpen.current = open
  useEffect(() => {
    const current = ++generation.current
    const finishClose = () => {
      if (current !== generation.current || isOpen.current) return
      if (!keepMounted) setRendered(false)
      if (pendingClose.current) { pendingClose.current = false; onClosedRef.current?.() }
    }
    if (open) setRendered(true)
    height.stopAnimation(); opacity.stopAnimation()
    if (!enabled || !interacted.current) {
      height.setValue(open ? measured : 0); opacity.setValue(open ? 1 : 0)
      if (!open) finishClose()
      return
    }
    const animation = Animated.parallel([
      Animated.timing(height, { toValue: open ? measured : 0, duration: 210, easing: Easing.out(Easing.ease), useNativeDriver: false }),
      Animated.timing(opacity, { toValue: open ? 1 : 0, duration: 210, easing: Easing.out(Easing.ease), useNativeDriver: false }),
    ])
    animation.start(({ finished }) => { if (finished) finishClose() })
    return () => { generation.current += 1; animation.stop() }
  }, [open, enabled, measured, height, opacity, keepMounted])
  if (!rendered) return null
  return <Animated.View pointerEvents={open ? 'auto' : 'none'} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
    style={{ overflow: 'hidden', height: enabled && interacted.current ? height : open ? undefined : 0, opacity }}>
    <View style={enabled && interacted.current ? { position: 'absolute', top: 0, left: 0, right: 0 } : undefined}
      onLayout={e => setMeasured(e.nativeEvent.layout.height)}>{children}</View>
  </Animated.View>
}

// 可展开区块:标题一行,点开看内容;沿用页面纸色与留白,不再画一层卡片。
export function Sheet({ title, children, defaultOpen = false, testID }: { title: string; children: ReactNode; defaultOpen?: boolean; testID?: string }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <View style={{ backgroundColor: c.paper, overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        testID={testID}
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((v) => !v)}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Txt role="bubble" style={{ flex: 1 }}>{title}</Txt>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} color={c.inkSoft} />
      </Pressable>
      <Expansion open={open}><View style={{ paddingVertical: space.l }}>{children}</View></Expansion>
    </View>
  )
}
