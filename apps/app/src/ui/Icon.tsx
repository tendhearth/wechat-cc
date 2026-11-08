import { Image } from 'react-native'
import { useTheme } from './useTheme'

export type IconName = 'arrowUp' | 'mic' | 'stop' | 'close' | 'help' | 'check' | 'chevronDown' | 'chevronRight' | 'refresh' | 'info' | 'alert' | 'clock' | 'pause' | 'back' | 'settings' | 'monitor' | 'plus' | 'search' | 'more' | 'shield' | 'book' | 'mail' | 'folder' | 'calendar' | 'terminal' | 'device' | 'link' | 'image' | 'camera' | 'done' | 'message' | 'restore' | 'edit' | 'unlink'

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
  back: require('../../assets/icons/chevron-left.png'),
  settings: require('../../assets/icons/settings.png'),
  monitor: require('../../assets/icons/monitor.png'),
  plus: require('../../assets/icons/plus.png'),
  search: require('../../assets/icons/search.png'),
  more: require('../../assets/icons/ellipsis.png'),
  shield: require('../../assets/icons/shield-question.png'),
  book: require('../../assets/icons/book-open.png'),
  mail: require('../../assets/icons/mail.png'),
  folder: require('../../assets/icons/folder.png'),
  calendar: require('../../assets/icons/calendar-clock.png'),
  terminal: require('../../assets/icons/terminal.png'),
  device: require('../../assets/icons/smartphone.png'),
  link: require('../../assets/icons/link.png'),
  image: require('../../assets/icons/image.png'),
  camera: require('../../assets/icons/camera.png'),
  done: require('../../assets/icons/circle-check.png'),
  message: require('../../assets/icons/message-circle.png'),
  restore: require('../../assets/icons/undo-2.png'),
  edit: require('../../assets/icons/pencil-line.png'),
  unlink: require('../../assets/icons/unlink.png'),
}

/** Decorative: the enclosing control/status owns the complete accessible label. */
export function Icon({ name, size = 18, color, testID }: { name: IconName; size?: number; color?: string; testID?: string }) {
  const { c } = useTheme()
  return <Image source={sources[name]} testID={testID} accessible={false} accessibilityElementsHidden importantForAccessibility="no" resizeMode="contain" style={{ width: size, height: size, tintColor: color ?? c.ink }} />
}
