import { useEffect, useMemo, useState } from 'react'
import { Pressable } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { useWork } from '../state/useWork'
import { useChatUpdates } from '../state/useChatUpdates'
import { useTerminalSessions } from '../state/useTerminal'
import { useCompanion } from '../state/useCompanion'
import { ccPresence } from '../view/presence'
import { latestCCLine } from '../view/now'
import { homeView } from '../view/home'
import { companionStatus } from '../view/companion'
import { makeCCMotionTracker, type CCMotionEvent } from '../view/cc-motion'
import { CCFigure } from './CCFigure'
import { useMotionEnabled } from './motion'

/** Same presence signals and motion as the former home hero, now a small header companion. */
export function ConversationPresence({ onPress = () => {} }: { onPress?: () => void }) {
  const lang = useLang(), conn = useConnection(), { backend } = useBackendCtx(), work = useWork()
  const terminal = useTerminalSessions({ poll: false }), companion = useCompanion(), now = Date.now()
  const view = homeView({ ...work, terminal: terminal.sessions, known: work.demo || conn.state === 'online', now, lang })
  const chat = useQuery('chat:latest', () => backend.chat({}))
  useChatUpdates(chat.data?.matterId, chat.refresh)
  const line = latestCCLine(chat.data), presence = ccPresence(conn, { demo: work.demo })
  const statusKey = companionStatus({ known: work.demo || presence === 'here', activity: companion.activity, running: work.agents.running })
  const enabled = useMotionEnabled(), tracker = useMemo(makeCCMotionTracker, [backend])
  const [motion, setMotion] = useState<CCMotionEvent>()
  const snapshot = JSON.stringify({ active: presence === 'here' && enabled, received: chat.data ? (line ? [{ id: line.id, at: line.at }] : []) : undefined, done: work.mattersKnown ? view.groups.find(g => g.key === 'back')?.rows.map(r => ({ id: `${r.source}:${r.id}`, at: r.updatedAt })) ?? [] : undefined, waiting: view.waitingUnknown ? undefined : view.actionableWaiting })
  useEffect(() => {
    const current = JSON.parse(snapshot), event = tracker.read(current)
    if (event) setMotion(event)
    else if (!current.active || current.waiting?.length === 0) setMotion(previous => previous?.behavior === 'wait' || !current.active ? undefined : previous)
  }, [tracker, snapshot])
  return <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={onPress} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><CCFigure size={36} presence={presence} mood={statusKey ? t(lang, statusKey) : undefined} behavior={motion?.behavior} eventKey={motion?.eventKey} /></Pressable>
}
