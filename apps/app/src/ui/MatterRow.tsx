import { STATUS_TABLE } from '@wechat-cc/protocol'
import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { agentsLabel } from '../view/agents'
import type { HomeRow } from '../view/home'
import { originKey } from '../view/origin'
import type { StatusKey } from '../view/status'
import { Icon } from './Icon'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'
import { WaitingTitle } from './WaitingTitle'

/** 状态图标 + 词(详情页顶上用);图标与色调只来自状态表。 */
export function StatusWord({ status, testID }: { status: StatusKey; testID?: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const spec = STATUS_TABLE[status]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      {spec.icon ? <Icon name={spec.icon} size={14} color={spec.tone === 'accent' ? c.accent : c.inkSoft} /> : null}
      <Txt testID={testID} role="small" tone={spec.tone === 'accent' ? 'accent' : 'inkSoft'}>{t(lang, spec.word)}</Txt>
    </View>
  )
}

/**
 * 主页 / 全部里的一种行(设计稿 2026-10-31 U):一件事、终端会话、等你批准、带回来的都是它。
 * 标题 + 一行小字(caption)+ 可选的此刻一步(detail)+ 可选的提醒(note);整行只打开详情,不在这里批准。
 * 留白分隔,不画色块;强调色只给「等你」的图标。
 */
export function MatterRow({ row, onOpen, fetchTitle = false }: { row: HomeRow; onOpen: () => void; fetchTitle?: boolean }) {
  const { c } = useTheme()
  const lang = useLang()
  const spec = STATUS_TABLE[row.status]
  const label = [
    row.title,
    t(lang, spec.word),
    row.caption,
    row.detail,
    row.note,
    row.agents.length ? agentsLabel(row.agents, row.agentNames) : null,
    row.origin ? t(lang, originKey(row.origin)) : null,
  ].filter(Boolean).join(', ')
  return (
    <Pressable
      testID={`row-${row.source}-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 64, paddingVertical: space.m, opacity: pressed ? 0.7 : 1 })}
    >
      {spec.icon ? <Icon name={spec.icon} color={spec.tone === 'accent' ? c.accent : c.inkSoft} /> : <View style={{ width: 18 }} />}
      <View style={{ flex: 1, gap: space.xs }}>
        {row.pendingRequestId
          ? <WaitingTitle taskId={row.id} requestId={row.pendingRequestId} fallback={row.title} fetch={fetchTitle} />
          : <Txt role="item" content="user" numberOfLines={2}>{row.title}</Txt>}
        {row.caption ? <Txt testID={`row-caption-${row.id}`} role="caption" tone="inkSoft" content="user" numberOfLines={1}>{row.caption}</Txt> : null}
        {row.detail ? <Txt testID={`row-detail-${row.id}`} role="small" tone="inkSoft" content="user" numberOfLines={1}>{row.detail}</Txt> : null}
        {row.note ? <Txt testID={`row-note-${row.id}`} role="meta" tone="inkSoft">{row.note}</Txt> : null}
      </View>
      <Icon name="chevronRight" size={16} color={c.inkSoft} />
    </Pressable>
  )
}
