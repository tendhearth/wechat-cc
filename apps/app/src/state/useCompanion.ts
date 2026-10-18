import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionHomeT, HomeTopicT } from '../backend/types'
import { companionSignature } from '../view/companion'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery, useTopic } from './hooks'

/**
 * 此刻页的「CC 在干什么 + 带回来的东西」(GET /m/api/home + home 主题)。
 * 不轮询:状态行直接读 home 主题(电脑上 activity 一变就推);首屏动态只在主题的未读数 / 最新游标变了时重拉一次。
 * 重连由 store 按握手 epoch 统一重验。够不着电脑 ⇒ 什么都不给(旧的「现在」不算现在)。
 */
export function useCompanion() {
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const online = backend.mode === 'demo' || conn.state === 'online'
  const topic = useTopic<HomeTopicT>('home')
  const q = useQuery<CompanionHomeT>('companion:home', l => backend.home(l), { enabled: online })
  const { refresh } = q
  const sig = companionSignature(topic)
  const lastSig = useRef<string | null>(null)
  useEffect(() => {
    if (!online || sig === null) return
    const prev = lastSig.current
    lastSig.current = sig
    if (prev !== null && prev !== sig) void refresh() // 第一份主题只是对齐;挂载时 useQuery 已经拉过
  }, [online, sig, refresh])

  // 本机刚点过的那一刻:电脑回话前就算看过;记失败也不再端上来(这次打开里)。
  const [localSeen, setLocalSeen] = useState<string | null>(null)
  const markSeen = useCallback((ts: string) => {
    setLocalSeen(prev => (prev !== null && Date.parse(prev) >= Date.parse(ts) ? prev : ts))
    backend.markSeen(ts).catch(() => {}) // 电脑记下后 home 主题的未读数会变 ⇒ 上面那条自己重拉
  }, [backend])

  // 主题先到就用主题(它是活的);主题还没来 ⇒ 用首屏里那份。
  const activity = topic ? topic.presenceState?.activity ?? null : q.data?.presence?.activity.kind ?? null
  return { home: online ? q.data : undefined, activity: online ? activity : null, localSeen, markSeen }
}
