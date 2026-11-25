import { useFocusEffect } from 'expo-router'
import { useCallback, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useBackendCtx } from './BackendProvider'
import { useConnection } from './hooks'
import { canCheckNotebookMail, notebookMail } from './notebook-mail'

export function useNotebookMailDay() {
  const { backend, boundPairing } = useBackendCtx()
  const mail = notebookMail(backend)
  const day = useSyncExternalStore(mail.subscribe, mail.day, mail.day)
  const connection = useConnection()
  const enabled = backend.mode === 'demo' || boundPairing !== null

  useFocusEffect(useCallback(() => {
    if (!enabled) return
    let focused = true
    let epoch: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const newScope = () => () => canCheckNotebookMail(enabled, backend.connection().state === 'online', AppState.currentState === 'active', focused)
    let allowed = newScope()
    const check = () => {
      clearTimeout(timer)
      if (!allowed()) return
      void mail.refresh(allowed)
      timer = setTimeout(check, 60_000)
    }
    const off = backend.onConnection(conn => {
      if (conn.state !== 'online' || conn.epoch === epoch) return
      epoch = conn.epoch
      check()
    })
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') {
        allowed = newScope()
        check()
      } else clearTimeout(timer)
    })
    return () => {
      focused = false
      off()
      foreground.remove()
      clearTimeout(timer)
    }
  }, [backend, enabled, mail]))

  return enabled && connection.state === 'online' ? day : undefined
}
