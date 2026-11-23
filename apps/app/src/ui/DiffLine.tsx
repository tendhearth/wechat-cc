import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** Keep review and approval diffs on the same add/remove ink. */
export function DiffLine({ line, kind, selectable, highlight }: {
  line: string; kind?: 'add' | 'remove'; selectable?: boolean; highlight?: boolean
}) {
  const { c } = useTheme()
  return <Txt role="code" content="user" selectable={selectable}
    tone={kind === 'add' ? 'accent' : kind === 'remove' ? 'bad' : 'ink'}
    style={kind && highlight ? { backgroundColor: c.paper } : undefined}>{line || ' '}</Txt>
}
