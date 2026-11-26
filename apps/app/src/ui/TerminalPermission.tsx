import type { RefObject } from 'react'
import { ScrollView, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { terminalPermission } from '../view/terminal'
import { Icon } from './Icon'
import { PermissionText } from './PermissionText'
import { PermissionOperation } from './PermissionOperation'
import { PermissionSource, usePermissionSource } from './PermissionSource'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

export function TerminalPermission({ pending, source, ago, projectPath, scroll }: {
  pending: Parameters<typeof terminalPermission>[0]; source: string; ago?: string; projectPath: string; scroll: RefObject<ScrollView | null>
}) {
  const lang = useLang()
  const { c } = useTheme()
  const { display, raw, received, summary, cwd, action, summaryTruncated, summaryOnly } = terminalPermission(pending, source, lang)
  const sheet = usePermissionSource(scroll)
  const summarySheet = usePermissionSource(scroll)
  const warning = raw === undefined && (summaryTruncated || display?.truncated)

  return <View style={{ gap: space.s }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon name="terminal" color={c.inkSoft} />
      </View>
      <PermissionText testID="terminal-detail-pending-actor" role="small" tone="inkSoft" style={{ flex: 1 }} value={ago ? `${action} · ${ago}` : action} lang={lang} />
    </View>
    {display?.note ? <PermissionText selectable role="small" tone="inkSoft" content="user" value={display.note} lang={lang} /> : null}
    {display ? <PermissionOperation testID="terminal-detail-pending" display={display} projectPath={projectPath} cwd={cwd} lang={lang} source={[raw ?? received, summary].filter(Boolean).join('\n')} summaryOnly={summaryOnly}
      moreLabel={raw === undefined ? t(lang, 'terminal.expandReceived') : undefined}
      open={raw !== undefined || received !== undefined ? sheet.openFromPreview : summary ? summarySheet.openFromPreview : undefined} /> : null}
    {warning ? <Txt testID="terminal-detail-pending-truncated" role="small" tone="inkSoft">{t(lang, 'terminal.pendingTruncated')}</Txt> : null}
    {raw !== undefined || received !== undefined ? <PermissionSource tool={pending.tool} source={raw ?? received ?? ''} projectPath={projectPath} cwd={cwd}
      lang={lang} sheet={sheet} kind={raw === undefined ? 'received' : 'original'} /> : null}
    {raw === undefined && received === undefined && !summary ? <PermissionText selectable role="small" tone="inkSoft" lang={lang}
      value={t(lang, 'approval.toolName', { tool: pending.tool })} /> : null}
    {summary ? <PermissionSource tool={pending.tool} source={summary} projectPath={projectPath} cwd={cwd} lang={lang} sheet={summarySheet} kind="summary" summaryOnly={summaryOnly} /> : null}
  </View>
}
