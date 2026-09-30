import { useColorScheme } from 'react-native'
import { palette, type Scheme } from './tokens'

export function useTheme() {
  const scheme: Scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  return { scheme, c: palette[scheme] }
}
