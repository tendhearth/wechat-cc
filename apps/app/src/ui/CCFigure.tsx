import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Image } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'

const lit = require('../../assets/cc/lit.png')

// 暂时一律 lit(明暗不再跟系统深浅;Task 4 改成跟真实连接信号)。系统开了「减少动态效果」就不动;否则 4 秒一个周期的轻微呼吸(1 → 1.02)。
export function CCFigure({ size, mood }: { size: number; mood?: string }) {
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
    if (reduceMotion) {
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
  }, [reduceMotion, scale])

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      <Image
        source={lit}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel={mood ? t(lang, 'cc.labelMood', { mood }) : t(lang, 'cc.label')}
      />
    </Animated.View>
  )
}
