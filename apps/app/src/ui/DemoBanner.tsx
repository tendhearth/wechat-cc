import { Text, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// 演示模式的小横幅:让人一眼知道这里的任务都是示例。
export function DemoBanner() {
  const { c } = useTheme()
  const lang = useLang()
  return (
    <View testID="demo-banner" style={{ backgroundColor: c.accentSoft, borderRadius: radius.pill, paddingHorizontal: space.m, paddingVertical: space.s }}>
      <Text style={{ color: c.ink, fontSize: 12, lineHeight: 17 }}>{t(lang, 'demo.banner')}</Text>
    </View>
  )
}
