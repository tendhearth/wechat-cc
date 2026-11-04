import { Redirect, useLocalSearchParams } from 'expo-router'
import { useTerminalSessions } from '../../state/useTerminal'
import { TerminalDetail } from '../../ui/TerminalDetail'

// 终端会话的旧地址(推送深链、活动流、老版本里的链接)(M4c,设计稿 2026-11-04-m4-terminal-matter-design.md):
// 这条会话有那件事(列表行带 matter_id)⇒ 跳到 /matter/<id>,同一个详情页;老 daemon 不带 ⇒ 就地画终端详情。
export default function TerminalSession() {
  const { id: raw } = useLocalSearchParams<{ id: string }>()
  const id = decodeURIComponent(String(raw ?? ''))
  const terminal = useTerminalSessions()
  const matterId = terminal.sessions.find(x => x.session_id === id)?.matter_id
  if (matterId) return <Redirect href={`/matter/${encodeURIComponent(matterId)}`} />
  return <TerminalDetail sessionId={id} />
}
