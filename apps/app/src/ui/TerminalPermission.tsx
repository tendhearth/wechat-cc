import type { RefObject } from 'react'
import { ScrollView, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { terminalPermission } from '../view/terminal'
import { Icon } from './Icon'
import { PermissionOperation } from './PermissionOperation'
import { PermissionSource, usePermissionSource } from './PermissionSource'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

export function TerminalPermission({ pending, source, cwd, scroll }: {
  pending: Parameters<typeof terminalPermission>[0]; source: string; cwd: string; scroll: RefObject<ScrollView | null>
}) {
  const lang = useLang()
  const { c } = useTheme()
  const { display, raw, action, truncated } = terminalPermission(pending, source, lang)
  const sheet = usePermissionSource(scroll)

  return <View style={{ gap: space.s }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon name="terminal" color={c.inkSoft} />
      </View>
      <Txt testID="terminal-detail-pending-actor" role="small" tone="inkSoft" style={{ flex: 1 }}>{action}</Txt>
    </View>
    {display ? <>
      <PermissionOperation testID="terminal-detail-pending" display={display} cwd={cwd} lang={lang} open={sheet.openFromPreview} />
      {truncated ? <Txt testID="terminal-detail-pending-truncated" role="small" tone="inkSoft">{t(lang, 'terminal.pendingTruncated')}</Txt> : null}
      {sheet.expanded ? <PermissionSource source={raw} cwd={cwd} lang={lang} sheet={sheet} /> : null}
    </> : null}
  </View>
}
