import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Image } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import type { CCPresence } from '../view/presence'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')

// 明暗只看真实连接(here=Light / away=Dark,Dark 的 CC 是「安静」:不呼吸)。系统开了「减少动态效果」也不动;否则 4 秒一个周期的轻微呼吸(1 → 1.02)。
export function CCFigure({ size, presence, mood }: { size: number; presence: CCPresence; mood?: string }) {
  const lang = useLang()
  const [reduceMotion, setReduceMotion] = useState(true)
  const scale = useRef(new Animated.Value(1)).current

  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduceMotion(v))
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      alive = false
      sub.remove()
    }
  }, [])

  useEffect(() => {
    if (reduceMotion || presence === 'away') {
      scale.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.02, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduceMotion, presence, scale])

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      <Image
        source={presence === 'here' ? lit : unlit}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel={mood ? t(lang, 'cc.labelMood', { mood }) : t(lang, 'cc.label')}
      />
    </Animated.View>
  )
}
