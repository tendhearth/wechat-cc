import { useEffect, useMemo, useRef, useState } from 'react'
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
import { componentAppearance } from './tokens'
import { CCFigure } from './CCFigure'
import { useMotionEnabled } from './motion'
import type { CCStream } from '@wechat-cc/protocol'
import { useCCActivity } from './useCCActivity'

/** Same presence signals and motion as the former home hero, now a small header companion. */
export function ConversationPresence({ onPress = () => {}, stream, typing = false, topics }: { onPress?: () => void; stream?: CCStream; typing?: boolean; topics?: readonly string[] }) {
  const lang = useLang(), conn = useConnection(), { backend } = useBackendCtx(), work = useWork()
  const terminal = useTerminalSessions({ poll: false }), companion = useCompanion(), now = Date.now()
  const view = homeView({ ...work, terminal: terminal.sessions, known: work.demo || conn.state === 'online', now, lang })
  const chat = useQuery('chat:latest', () => backend.chat({}))
  useChatUpdates(chat.data?.matterId, chat.refresh)
  const line = latestCCLine(chat.data), presence = ccPresence(conn, { demo: work.demo })
  const statusKey = companionStatus({ known: work.demo || presence === 'here', activity: companion.activity, running: work.agents.running })
  const enabled = useMotionEnabled(), tracker = useMemo(makeCCMotionTracker, [backend])
  const [motion, setMotion] = useState<CCMotionEvent>()
  const outcomeReads = useRef({ matters: work.matters, terminal: terminal.sessions, mattersFresh: false, terminalFresh: false })
  const phase = useCCActivity(stream, presence === 'here', enabled, typing, view.actionableWaiting.length > 0)
  const snapshot = JSON.stringify({ active: presence === 'here' && enabled, received: chat.data ? (line ? [{ id: line.id, at: line.at }] : []) : undefined, outcomes: work.mattersKnown && terminal.loaded ? view.groups.flatMap(g => g.rows).map(r => ({ id: `${r.source}:${r.id}`, at: r.updatedAt, status: r.status })) : undefined, waiting: view.waitingUnknown ? undefined : view.actionableWaiting, topics })
  useEffect(() => {
    const current = JSON.parse(snapshot), reads = outcomeReads.current
    if (!current.active) {
      reads.matters = work.matters; reads.terminal = terminal.sessions; reads.mattersFresh = false; reads.terminalFresh = false
    } else {
      if (reads.matters !== work.matters) reads.mattersFresh = true
      if (reads.terminal !== terminal.sessions) reads.terminalFresh = true
    }
    // Returning to cached rows isn't a new observation. Baseline the first fresh read of both sources.
    if (!reads.mattersFresh || !reads.terminalFresh) delete current.outcomes
    const event = tracker.read(current)
    if (event) setMotion(event)
    else if (!current.active || current.waiting?.length === 0) setMotion(previous => previous?.behavior === 'wait' || !current.active ? undefined : previous)
  }, [tracker, snapshot, work.matters, terminal.sessions])
  return <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={onPress} style={{ minWidth: componentAppearance.identity.headerTarget, minHeight: componentAppearance.identity.headerTarget, justifyContent: 'center' }}><CCFigure size={componentAppearance.identity.headerImage.phone} presence={presence} mood={statusKey ? t(lang, statusKey) : undefined} behavior={motion?.behavior} eventKey={motion?.eventKey} phase={phase} /></Pressable>
}
