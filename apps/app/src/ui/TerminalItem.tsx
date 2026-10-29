import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { TERMINAL_DOT, type TerminalRow, type TerminalStatus } from '../view/terminal'
import { Dot } from './Dot'
import { Icon } from './Icon'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** 状态词 + 点:等你决定 / 在做 / 歇着 / 结束了(用词表)。颜色只上点。 */
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
 * 终端会话与事情用同样的平面行:具体操作优先,项目与状态放小字;执行者和批准入口含义保留在读屏标签。
 * 整行只打开详情,不在这里批准。终端自己在问时仍明说「回电脑上答」;旧快照不把上次那一步说成正在做。
 */
export function TerminalItem({ row, onOpen }: { row: TerminalRow; onOpen: () => void }) {
  const { c } = useTheme()
  const lang = useLang()
  const status = t(lang, `terminal.status.${row.status}`)
  const review = row.status === 'waiting' && row.actionable
  const local = row.status === 'waiting' && !row.actionable ? t(lang, 'terminal.askedLocally') : null
  const stale = row.stale ? t(lang, 'terminal.stale.hint') : null
  const title = row.pendingText || row.project
  const detail = !row.pendingText && !row.stale ? row.nowText || row.summary : null
  const caption = [row.pendingText ? row.project : null, stale || status, row.ago].filter(Boolean).join(' · ')
  const label = [title, row.pendingText ? row.project : null, row.source, status, stale, row.ago, detail, review ? t(lang, 'terminal.review') : null, local].filter(Boolean).join(', ')
  return (
    <View testID={`terminal-item-${row.id}`}>
      <Pressable
        testID={`terminal-open-${row.id}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onOpen}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: space.m, gap: space.m, opacity: pressed ? 0.7 : 1 })}
      >
        <Icon name={review ? 'shield' : 'terminal'} color={c.inkSoft} />
        <View style={{ flex: 1, gap: space.xs }}>
          <Txt role="item" content="user" numberOfLines={2}>{title}</Txt>
          <Txt testID={`terminal-status-${row.id}`} role="meta" tone="inkSoft">{caption}</Txt>
          {detail ? <Txt testID={row.nowText ? `terminal-now-${row.id}` : undefined} role="small" tone="inkSoft" content="user" numberOfLines={1}>{detail}</Txt> : null}
          {local ? <Txt testID={`terminal-local-${row.id}`} role="meta" tone="inkSoft">{local}</Txt> : null}
        </View>
        <View testID={review ? `terminal-review-${row.id}` : undefined} accessible={false} style={{ width: 18, height: 18 }}>
          <Icon name="chevronRight" size={18} color={c.inkSoft} />
        </View>
      </Pressable>
    </View>
  )
}
