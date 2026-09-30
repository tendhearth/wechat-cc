import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { AgentsTopicT, ApprovalItemT, MatterT } from '../backend/types'
import { useBackendCtx } from './BackendProvider'
import { useQuery, useTopic } from './hooks'

const NO_APPROVALS: ApprovalItemT[] = []
const NO_AGENTS: AgentsTopicT = { running: 0, waiting: 0, tasks: [] }
const NO_MATTERS: MatterT[] = []

/** 「此刻」与「一起做」共用的三路数据;页面获得焦点时重拉一次 matter 列表(新交办的事会出现)。 */
export function useWork() {
  const { backend } = useBackendCtx()
  const approvals = useTopic<ApprovalItemT[]>('approvals') ?? NO_APPROVALS
  const agents = useTopic<AgentsTopicT>('agents') ?? NO_AGENTS
  const matters = useQuery<MatterT[]>('matters', l => backend.matters(l))
  const { refresh } = matters
  useFocusEffect(useCallback(() => { void refresh() }, [refresh]))
  return { approvals, agents, matters: matters.data ?? NO_MATTERS, mattersError: matters.error, demo: backend.mode === 'demo' }
}
