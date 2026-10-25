import { useEffect, useRef } from 'react'
import { Animated, Easing, Image } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import type { CCPresence } from '../view/presence'
import { useMotionEnabled } from './motion'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')
type Behavior = 'idle' | 'receive' | 'done' | 'wait'

/** Canonical PNGs retain one geometry. Only confirmed presence lights CC; Dark remains still. */
export function CCFigure({ size, presence, mood, behavior = 'idle', eventKey }: { size: number; presence: CCPresence; mood?: string; behavior?: Behavior; eventKey?: string | number }) {
  const lang = useLang()
  const enabled = useMotionEnabled()
  const scale = useRef(new Animated.Value(1)).current
  const y = useRef(new Animated.Value(0)).current
  const tilt = useRef(new Animated.Value(0)).current
  const light = useRef(new Animated.Value(presence === 'here' ? 1 : 0)).current
  const previousPresence = useRef(presence)
  const seen = useRef(new Set<string | number>())

  useEffect(() => {
    const reconnect = previousPresence.current === 'away' && presence === 'here'
    previousPresence.current = presence
    const target = presence === 'here' ? 1 : 0
    light.setValue(target)
    if (!enabled || !reconnect) return
    light.setValue(0)
    const animation = Animated.timing(light, { toValue: 1, duration: 720, easing: Easing.out(Easing.ease), useNativeDriver: true, isInteraction: false })
    animation.start()
    return () => { animation.stop(); light.stopAnimation(); light.setValue(target) }
  }, [presence, enabled, light])

  useEffect(() => {
    const fresh = eventKey !== undefined && !seen.current.has(eventKey)
    if (eventKey !== undefined) seen.current.add(eventKey)
    const rest = () => { scale.setValue(1); y.setValue(0); tilt.setValue(0) }
    rest()
    if (!enabled || presence !== 'here') return
    let animation: Animated.CompositeAnimation | undefined
    let alive = true
    const timing = (value: Animated.Value, toValue: number, duration: number) => Animated.timing(value, { toValue, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true, isInteraction: false })
    const breathe = () => {
      if (!alive || behavior === 'wait') return
      animation = Animated.loop(Animated.sequence([timing(scale, 1.02, 2000), timing(scale, 1, 2000)]))
      animation.start()
    }
    if (fresh && behavior !== 'idle') {
      if (behavior === 'wait') {
        tilt.setValue(-1.2)
        animation = timing(tilt, 0, 360)
      } else {
        const receive = behavior === 'receive'
        const first = receive ? 176 : 230, last = receive ? 264 : 410
        animation = Animated.sequence([
          Animated.parallel([timing(scale, receive ? 0.986 : 1.012, first), timing(y, receive ? 1 : -2, first)]),
          Animated.parallel([timing(scale, 1, last), timing(y, 0, last)]),
        ])
      }
      animation.start(({ finished }) => { if (finished && alive) breathe() })
    } else breathe()
    return () => { alive = false; animation?.stop(); scale.stopAnimation(); y.stopAnimation(); tilt.stopAnimation(); rest() }
  }, [enabled, presence, behavior, eventKey, scale, y, tilt])

  return (
    <Animated.View accessible accessibilityRole="image" accessibilityLabel={mood ? t(lang, 'cc.labelMood', { mood }) : t(lang, 'cc.label')} style={{ width: size, height: size, transformOrigin: [size / 2, size * 470 / 512, 0], transform: [{ translateY: y }, { scale }, { rotate: tilt.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1deg'] }) }] }}>
      <Animated.View testID="cc-unlit" accessible={false} style={{ position: 'absolute', width: size, height: size, opacity: light.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
        <Image source={unlit} style={{ width: size, height: size }} resizeMode="contain" accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
      </Animated.View>
      <Animated.View testID="cc-lit" accessible={false} style={{ width: size, height: size, opacity: light }}>
        <Image source={lit} style={{ width: size, height: size }} resizeMode="contain" accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
      </Animated.View>
    </Animated.View>
  )
}
