import { Image } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { matterOrigin, originKey, type MatterOrigin } from '../view/origin'
import { useTheme } from './useTheme'

// 白色透明底的线条图,按 ink 着色(tintColor):跟头像同一支笔,不带任何品牌色。
// 图形与桌面 / 手机网页共用(apps/desktop/src/shared/agent-avatars.js 的 ORIGIN_GLYPHS 渲成 PNG)。
const GLYPH: Record<MatterOrigin, number> = {
  wechat: require('../../assets/origins/wechat.png'),
  desktop: require('../../assets/origins/desktop.png'),
  app: require('../../assets/origins/app.png'),
  web: require('../../assets/origins/web.png'),
  cli: require('../../assets/origins/cli.png'),
  companion: require('../../assets/origins/companion.png'),
}

/** 这件事从哪来的:一个小字形,读屏念「从微信来的」。不知道 ⇒ 什么都不画。 */
export function OriginMark({ origin, size = 16, testID }: { origin: unknown; size?: number; testID?: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const o = matterOrigin(origin)
  if (!o) return null
  return (
    <Image
      testID={testID}
      source={GLYPH[o]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t(lang, originKey(o))}
      style={{ width: size, height: size, tintColor: c.ink }}
      resizeMode="contain"
    />
  )
}
