import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Image } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import type { CCPresence } from '../view/presence'
import { useMotionEnabled } from './motion'
import { CC_RESPONSE, createCCResponsePerformance, type CCPhase } from '@wechat-cc/protocol'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')
const inputUp = require('../../assets/cc/attention/input-up.png')
const readDown = require('../../assets/cc/attention/read-down.png')
const responseFrames = [lit, require('../../assets/cc/attention/speaking-1.png'), require('../../assets/cc/attention/speaking-2.png'), lit]
type Behavior = 'idle' | 'receive' | 'done' | 'wait' | 'look'

/** Canonical PNGs retain one geometry. Only confirmed presence lights CC; Dark remains still. */
export function CCFigure({ size, presence, mood, behavior = 'idle', eventKey, phase = 'idle' }: { size: number; presence: CCPresence; mood?: string; behavior?: Behavior; eventKey?: string | number; phase?: CCPhase }) {
  const lang = useLang()
  const description = phase !== 'idle' ? t(lang, `cc.${phase}`) : mood
  const enabled = useMotionEnabled()
  const scale = useRef(new Animated.Value(1)).current
  const y = useRef(new Animated.Value(0)).current
  const tilt = useRef(new Animated.Value(0)).current
  const light = useRef(new Animated.Value(presence === 'here' ? 1 : 0)).current
  const previousPresence = useRef(presence)
  const seen = useRef(new Set<string | number>())
  const response = useMemo(createCCResponsePerformance, [])
  const [responseFrame, setResponseFrame] = useState<number | null>(null)
  const [looking, setLooking] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const frame = response.frame(phase, Date.now(), enabled && presence === 'here')
      setResponseFrame(frame)
      if (frame !== null) timer = setTimeout(update, CC_RESPONSE.frameMs)
    }
    update()
    return () => clearTimeout(timer)
  }, [response, phase, enabled, presence])

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
    rest(); setLooking(false)
    if (!enabled || presence !== 'here') return
    let animation: Animated.CompositeAnimation | undefined
    let lookTimer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    const timing = (value: Animated.Value, toValue: number, duration: number) => Animated.timing(value, { toValue, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true, isInteraction: false })
    const breathe = () => {
      if (!alive || behavior === 'wait') return
      animation = Animated.loop(Animated.sequence([timing(scale, 1.02, 2000), timing(scale, 1, 2000)]))
      animation.start()
    }
    if (phase !== 'idle') {
      if (phase === 'listening') animation = timing(tilt, -2, 180)
      else if (phase === 'thinking') animation = Animated.loop(Animated.sequence([timing(tilt, 1, 600), timing(tilt, 0, 600), timing(tilt, 0, 8000)]))
      animation?.start()
    } else if (fresh && behavior !== 'idle') {
      if (behavior === 'wait' || behavior === 'look') {
        if (behavior === 'look') { setLooking(true); lookTimer = setTimeout(() => setLooking(false), 520) }
        tilt.setValue(behavior === 'look' ? 2 : -1.2)
        animation = timing(tilt, 0, behavior === 'look' ? 520 : 360)
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
    return () => { alive = false; clearTimeout(lookTimer); animation?.stop(); scale.stopAnimation(); y.stopAnimation(); tilt.stopAnimation(); rest() }
  }, [enabled, presence, behavior, eventKey, phase, scale, y, tilt])

  const source = !enabled || presence !== 'here' ? lit : phase === 'listening' ? inputUp : phase === 'speaking' && responseFrame !== null ? responseFrames[responseFrame] : phase === 'idle' && looking ? readDown : lit
  return (
    <Animated.View testID={`cc-phase-${phase}`} accessible accessibilityRole="image" accessibilityLabel={description ? t(lang, 'cc.labelMood', { mood: description }) : t(lang, 'cc.label')} style={{ width: size, height: size, transformOrigin: [size / 2, size * 470 / 512, 0], transform: [{ translateY: y }, { scale }, { rotate: tilt.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1deg'] }) }] }}>
      <Animated.View testID="cc-unlit" accessible={false} style={{ position: 'absolute', width: size, height: size, opacity: light.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
        <Image source={unlit} style={{ width: size, height: size }} resizeMode="contain" accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
      </Animated.View>
      <Animated.View testID="cc-lit" accessible={false} style={{ width: size, height: size, opacity: light }}>
        <Image testID="cc-authored-pose" source={source} style={{ width: size, height: size }} resizeMode="contain" accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
      </Animated.View>
    </Animated.View>
  )
}
