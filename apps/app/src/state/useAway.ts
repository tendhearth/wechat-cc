import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'

const KEY = 'cc.lastLeft'

/**
 * 主人上次把 App 放到后台的时间(2026-10-17,此刻页「你不在的这 N 小时」)。存在本机(杀进程过夜也还在),
 * 只是一个时间戳,不出手机。读不到 / 存不了 ⇒ null,此刻页照旧看「过去 24 小时」。
 */
export function useAwaySince(): number | null {
  const [since, setSince] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => SecureStore.getItemAsync(KEY).then(v => { const n = Number(v); if (alive) setSince(v && Number.isFinite(n) ? n : null) }).catch(() => {})
    void load()
    const sub = AppState.addEventListener('change', s => {
      if (s === 'background') void SecureStore.setItemAsync(KEY, String(Date.now())).catch(() => {})
      else if (s === 'active') void load()
    })
    return () => { alive = false; sub.remove() }
  }, [])
  return since
}
