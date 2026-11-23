import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { Txt } from './Txt'
import { space } from './tokens'

// 演示模式:一行小字说明这里是示例数据(不是一块横幅)。
export function DemoBanner() {
  const lang = useLang()
  return <Txt testID="demo-banner" role="small" tone="inkSoft" numberOfLines={1} style={{ marginVertical: space.s }}>{t(lang, 'demo.banner')}</Txt>
}
