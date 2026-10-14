import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { TERMINAL_DOT, type TerminalRow, type TerminalStatus } from '../view/terminal'
import { Button } from './Button'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** 状态词 + 点:等你批准 / 在跑 / 歇着 / 结束了。颜色只上点。 */
export function TerminalStatusPill({ status, testID }: { status: TerminalStatus; testID?: string }) {
  const lang = useLang()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind={TERMINAL_DOT[status]} size={8} />
      <Txt testID={testID} role="small" tone="inkSoft">{t(lang, `terminal.status.${status}`)}</Txt>
    </View>
  )
}

/**
 * 「一起做」里终端会话的一行:项目、哪家、状态、最后一句、多久前。等你批准且手机拍得了 ⇒ 行内允许 / 拒绝;
 * 终端自己在问 ⇒ 说一句「回电脑上答」。点整行进详情(看最后一句、接着说)。
 */
export function TerminalItem({ row, onOpen, onDecide, deciding, disabled }: {
  row: TerminalRow
  onOpen: () => void
  onDecide: (d: 'allow' | 'deny') => void
  deciding: boolean
  disabled: boolean
}) {
  const { c } = useTheme()
  const lang = useLang()
  const status = t(lang, `terminal.status.${row.status}`)
  return (
    <View testID={`terminal-item-${row.id}`} style={{ borderBottomWidth: 1, borderBottomColor: c.hair, paddingVertical: space.l, gap: space.s }}>
      <Pressable
        testID={`terminal-open-${row.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${row.project}, ${row.source}, ${status}`}
        onPress={onOpen}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flex: 1, gap: space.s }}>
          <Txt role="item" content="user" numberOfLines={1}>{row.project}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' }}>
            <TerminalStatusPill status={row.status} testID={`terminal-status-${row.id}`} />
            <Txt role="small" tone="inkSoft" numberOfLines={1}>{`· ${row.source} · ${row.stale ? t(lang, 'terminal.stale.hint') : row.ago}`}</Txt>
          </View>
          {row.pendingText ? <Txt role="small" content="user" numberOfLines={2}>{row.pendingText}</Txt> : null}
          {row.summary && !row.pendingText ? <Txt role="small" tone="inkSoft" content="user" numberOfLines={2}>{row.summary}</Txt> : null}
        </View>
        <Txt role="title" tone="inkSoft">›</Txt>
      </Pressable>
      {row.status === 'waiting' && row.actionable ? (
        <View style={{ flexDirection: 'row', gap: space.m }}>
          <View style={{ flex: 1 }}><Button kind="primary" testID={`terminal-allow-${row.id}`} label={t(lang, 'terminal.allow')} busy={deciding} disabled={disabled} onPress={() => onDecide('allow')} /></View>
          <View style={{ flex: 1 }}><Button kind="secondary" testID={`terminal-deny-${row.id}`} label={t(lang, 'terminal.deny')} disabled={disabled || deciding} onPress={() => onDecide('deny')} /></View>
        </View>
      ) : row.status === 'waiting' ? (
        <Txt testID={`terminal-local-${row.id}`} role="meta" tone="inkSoft">{t(lang, 'terminal.askedLocally')}</Txt>
      ) : null}
    </View>
  )
}
