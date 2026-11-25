import type { ReactNode } from 'react'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** Keep review and approval diffs on the same add/remove ink. */
export function DiffLine({ line, kind, selectable, highlight, children }: {
  line: string; kind?: 'add' | 'remove'; selectable?: boolean; highlight?: boolean; children?: ReactNode
}) {
  const { c } = useTheme()
  return <Txt role="code" content="user" selectable={selectable}
    tone={kind === 'add' ? 'accent' : kind === 'remove' ? 'bad' : 'ink'}
    style={kind && highlight ? { backgroundColor: c.paper } : undefined}>{children ?? (line || ' ')}</Txt>
}
