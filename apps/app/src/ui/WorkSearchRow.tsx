import { STATUS_TABLE } from '@wechat-cc/protocol'
import { Pressable, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { workSearchRowCopy } from '../view/chat-search'
import type { HomeRow } from '../view/home'
import { AgentAvatars } from './AgentAvatars'
import { Dot } from './Dot'
import { Icon } from './Icon'
import { Txt } from './Txt'
import { space } from './tokens'
import { useTheme } from './useTheme'
import { useWaitingTitle } from './WaitingTitle'

type RowProps = { row: HomeRow; synced: boolean; now: number; onOpen: () => void }

export function WorkSearchRow(props: RowProps) {
  const { row } = props
  return row.pendingRequestId
    ? <PendingWorkSearchRow {...props} requestId={row.pendingRequestId} />
    : <SearchRow {...props} title={row.title} />
}

function PendingWorkSearchRow({ requestId, ...props }: RowProps & { requestId: string }) {
  const title = useWaitingTitle(props.row.id, requestId, props.row.title, true)
  return <SearchRow {...props} title={title} />
}

function SearchRow({ row, synced, now, onOpen, title }: RowProps & { title: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const spec = STATUS_TABLE[row.status]
  const { caption, label } = workSearchRowCopy(row, title, synced, now, lang)

  return (
    <Pressable testID={`row-${row.source}-${row.id}`} accessible accessibilityRole="button" accessibilityLabel={label} onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, paddingVertical: space.xs, opacity: pressed ? 0.7 : 1,
      })}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m }}>
        {spec.icon ? <Icon name={spec.icon} size={18} color={c[spec.tone]} /> : <View style={{ width: 18, alignItems: 'center' }}><Dot kind="inkSoft" size={5} /></View>}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
            <Txt testID={`work-search-title-${row.id}`} role="item" content="user" numberOfLines={1} style={{ flex: 1 }}>{title}</Txt>
            <AgentAvatars ids={row.agents} names={row.agentNames} size={16} />
          </View>
          <Txt testID={`row-caption-${row.id}`} role="caption" tone="inkSoft" numberOfLines={1}>{caption}</Txt>
        </View>
        <Icon name="chevronRight" size={16} color={c.inkSoft} />
      </View>
    </Pressable>
  )
}
