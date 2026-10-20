import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { TERMINAL_DOT, type TerminalRow, type TerminalStatus } from '../view/terminal'
import { AgentAvatars } from './AgentAvatars'
import { Dot } from './Dot'
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
 * 「一起做」里终端会话的一行:项目、状态、最后一句、多久前,行尾一个圆头像说是哪家(名字只进读屏标签)。整行只有一个动作:点进详情。
 * 等你批准且手机拍得了 ⇒ 右边写「看清楚 ›」,允许这一步 / 先不做只在详情里(看清楚了再拍);终端自己在问 ⇒ 说一句「回电脑上答」。
 */
export function TerminalItem({ row, onOpen }: { row: TerminalRow; onOpen: () => void }) {
  const { c } = useTheme()
  const lang = useLang()
  const status = t(lang, `terminal.status.${row.status}`)
  const review = row.status === 'waiting' && row.actionable
  return (
    <View testID={`terminal-item-${row.id}`} style={{ borderBottomWidth: 1, borderBottomColor: c.hair, paddingVertical: space.l, gap: space.s }}>
      <Pressable
        testID={`terminal-open-${row.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${row.project}, ${row.source}, ${status}${review ? `. ${t(lang, 'terminal.review')}` : ''}`}
        onPress={onOpen}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flex: 1, gap: space.s }}>
          <Txt role="item" content="user" numberOfLines={1}>{row.project}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' }}>
            <TerminalStatusPill status={row.status} testID={`terminal-status-${row.id}`} />
            <Txt role="small" tone="inkSoft" numberOfLines={1}>{`· ${row.stale ? t(lang, 'terminal.stale.hint') : row.ago}`}</Txt>
          </View>
          {row.pendingText ? <Txt role="small" content="user" numberOfLines={2}>{row.pendingText}</Txt> : null}
          {row.nowText && !row.pendingText
            ? <Txt testID={`terminal-now-${row.id}`} role="small" content="user" numberOfLines={2}>{`${t(lang, 'progress.stepNow')} · ${row.nowText}`}</Txt>
            : row.summary && !row.pendingText ? <Txt role="small" tone="inkSoft" content="user" numberOfLines={2}>{row.summary}</Txt> : null}
        </View>
        <AgentAvatars ids={[row.agent]} testID={`terminal-agent-${row.id}`} />
        {review
          ? <Txt testID={`terminal-review-${row.id}`} role="bubble" tone="inkSoft">{`${t(lang, 'terminal.review')} ›`}</Txt>
          : <Txt role="title" tone="inkSoft">›</Txt>}
      </Pressable>
      {row.status === 'waiting' && !row.actionable ? (
        <Txt testID={`terminal-local-${row.id}`} role="meta" tone="inkSoft">{t(lang, 'terminal.askedLocally')}</Txt>
      ) : null}
    </View>
  )
}
