import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, AppState, Easing, View, type StyleProp, type ViewStyle } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Icon } from './Icon'
import { useTheme } from './useTheme'

/** Motion needs affirmative permission from all three lifecycle signals. Unknown reads stay static. */
export function useMotionEnabled(): boolean {
  const [reduced, setReduced] = useState(true)
  const [foreground, setForeground] = useState(false)
  const [focused, setFocused] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [armed, setArmed] = useState(-1)
  const rearm = useCallback(() => setGeneration(value => value + 1), [])
  // Commit one static frame before enabling a resumed/frozen screen. Consumers consume queued IDs there.
  useEffect(() => { setArmed(generation) }, [generation])
  useFocusEffect(useCallback(() => {
    rearm()
    setFocused(true)
    return () => setFocused(false)
  }, [rearm]))
  useEffect(() => {
    let alive = true, changed = false
    let subscription: { remove(): void } | undefined
    try {
      subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
        changed = true
        if (alive) { if (value === false) rearm(); setReduced(value !== false) }
      })
      if (!subscription || typeof subscription.remove !== 'function') return
      // A later change event is newer evidence than an outstanding initial read.
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then(value => {
        if (alive && !changed) { if (value === false) rearm(); setReduced(value !== false) }
      }).catch(() => { if (alive && !changed) setReduced(true) })
    } catch { setReduced(true) }
    return () => { alive = false; subscription?.remove() }
  }, [rearm])
  useEffect(() => {
    let subscription: { remove(): void } | undefined
    try {
      subscription = AppState.addEventListener('change', state => { if (state === 'active') rearm(); setForeground(state === 'active') })
      if (!subscription || typeof subscription.remove !== 'function') return
      setForeground(AppState.currentState === 'active')
    } catch { setForeground(false) }
    return () => subscription?.remove()
  }, [rearm])
  return !reduced && foreground && focused && armed === generation
}

/** Continuous progress retains a complete accessible status even while the visual is static. */
export function BusyIndicator({ label, size = 18, color, testID }: { label: string; size?: number; color?: string; testID?: string }) {
  const { c } = useTheme()
  const enabled = useMotionEnabled()
  const turn = useRef(new Animated.Value(0)).current
  useEffect(() => {
    turn.setValue(0)
    if (!enabled) return
    const animation = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true, isInteraction: false }))
    animation.start()
    return () => { animation.stop(); turn.stopAnimation(); turn.setValue(0) }
  }, [enabled, turn])
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} testID={testID} style={{ width: size, height: size }}>
      <Animated.View accessible={false} testID={testID ? `${testID}-motion` : undefined} style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
        <Icon name="refresh" size={size} color={color ?? c.inkSoft} />
      </Animated.View>
    </View>
  )
}

/** Explicit live identities only. Hidden/interrupted events are consumed rather than replayed on return. */
export function MotionView({ children, eventKey, kind = 'enter', style, testID }: { children: ReactNode; eventKey?: string | number; kind?: 'enter' | 'status'; style?: StyleProp<ViewStyle>; testID?: string }) {
  const enabled = useMotionEnabled()
  const seen = useRef(new Set<string | number>())
  const opacity = useRef(new Animated.Value(1)).current
  const offset = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const fresh = eventKey !== undefined && !seen.current.has(eventKey)
    if (eventKey !== undefined) seen.current.add(eventKey)
    opacity.setValue(1); offset.setValue(0)
    if (!enabled || !fresh) return
    opacity.setValue(0); offset.setValue(2)
    const duration = kind === 'status' ? 120 : 180
    const config = { duration, easing: Easing.out(Easing.ease), useNativeDriver: true, isInteraction: false }
    const animation = Animated.parallel([
      Animated.timing(opacity, { ...config, toValue: 1 }),
      Animated.timing(offset, { ...config, toValue: 0 }),
    ])
    animation.start()
    return () => { animation.stop(); opacity.stopAnimation(); offset.stopAnimation(); opacity.setValue(1); offset.setValue(0) }
  }, [enabled, eventKey, kind, opacity, offset])
  return <Animated.View testID={testID} style={[style, { opacity, transform: [{ translateY: offset }] }]}>{children}</Animated.View>
}
