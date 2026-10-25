import { Image } from 'react-native'
import { useTheme } from './useTheme'

export type IconName = 'arrowUp' | 'mic' | 'stop' | 'close' | 'help' | 'check' | 'chevronDown' | 'chevronRight' | 'refresh' | 'info' | 'alert' | 'clock' | 'pause'

// Literal requires let Metro collect every bundled asset; no runtime SVG renderer or network.
const sources: Record<IconName, number> = {
  arrowUp: require('../../assets/icons/arrow-up.png'),
  mic: require('../../assets/icons/mic.png'),
  stop: require('../../assets/icons/square.png'),
  close: require('../../assets/icons/x.png'),
  help: require('../../assets/icons/circle-help.png'),
  check: require('../../assets/icons/check.png'),
  chevronDown: require('../../assets/icons/chevron-down.png'),
  chevronRight: require('../../assets/icons/chevron-right.png'),
  refresh: require('../../assets/icons/refresh-cw.png'),
  info: require('../../assets/icons/info.png'),
  alert: require('../../assets/icons/circle-alert.png'),
  clock: require('../../assets/icons/clock.png'),
  pause: require('../../assets/icons/pause.png'),
}

/** Decorative: the enclosing control/status owns the complete accessible label. */
export function Icon({ name, size = 18, color, testID }: { name: IconName; size?: number; color?: string; testID?: string }) {
  const { c } = useTheme()
  return <Image source={sources[name]} testID={testID} accessible={false} accessibilityElementsHidden importantForAccessibility="no" resizeMode="contain" style={{ width: size, height: size, tintColor: color ?? c.ink }} />
}
