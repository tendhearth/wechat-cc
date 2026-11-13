import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { BackendError } from '../backend/types'
import { butlerActionError, butlerView, type CheckupViewT, type CheckupEstimateT } from '../view/butler'
import { Button } from './Button'
import { Txt } from './Txt'
import { space } from './tokens'

/** Read-only until the separate, costed confirmation is pressed. */
export function ButlerStatus() {
  const { backend } = useBackendCtx(), conn = useConnection(), lang = useLang()
  const [data, setData] = useState<CheckupViewT | null>(null)
  const [estimate, setEstimate] = useState<CheckupEstimateT | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const alive = useRef(false), pending = useRef(false), ticket = useRef(0), target = useRef('')
  const running = data?.attempt?.status === 'running'
  const online = backend.mode === 'demo' || conn.state === 'online'
  const refresh = useCallback(async () => {
    if (pending.current) return
    const mine = ++ticket.current
    try {
      const next = await backend.checkup()
      if (!alive.current || mine !== ticket.current) return
      const nextTarget = JSON.stringify(next.target) ?? ''
      if (target.current !== nextTarget) setEstimate(null)
      target.current = nextTarget; setData(next); setFailed(false)
    } catch { if (alive.current && mine === ticket.current) setFailed(true) }
  }, [backend])
  useFocusEffect(useCallback(() => {
    alive.current = true
    if (online) void refresh()
    else setEstimate(null)
    const timer = online ? setInterval(() => { void refresh() }, running ? 2_000 : 30_000) : undefined
    return () => { alive.current = false; ++ticket.current; clearInterval(timer) }
  }, [online, refresh, running]))
  const perform = async <T,>(action: () => Promise<T>, apply: (next: T) => void) => {
    if (pending.current || !online) return
    const mine = ++ticket.current
    let refreshAfterError = false
    pending.current = true; setBusy(true); setActionError(null)
    try {
      const next = await action()
      if (alive.current && mine === ticket.current) { apply(next); setFailed(false) }
    } catch (e) {
      if (alive.current && mine === ticket.current) { setEstimate(null); setFailed(true); setActionError(butlerActionError(e instanceof BackendError ? e.code : 'unknown', lang)); refreshAfterError = true }
    } finally {
      pending.current = false
      if (alive.current) { setBusy(false); if (refreshAfterError) void refresh() }
    }
  }
  const s = data ? butlerView(data, lang) : null
  return <View testID="connections-butler" style={{ gap: space.s }}>
    <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginTop: space.xl, marginBottom: space.s }}>{s?.title??t(lang, 'butler.title')}</Txt>
    {!s ? <Txt role="small" tone="inkSoft">{t(lang, failed || !online ? 'butler.unavailable' : 'sessions.loading')}</Txt> : <>
      {!online || failed ? <Txt testID="checkup-stale" role="small" tone="inkSoft">{t(lang, 'butler.stale')}</Txt> : null}
      {s.rows.length?s.rows.map(row=><Txt key={row.key} testID={`checkup-${row.key}`} role="body">{row.label}: {row.detail}  {row.grade}</Txt>):<>
      <Txt testID="checkup-memory" role="body">{t(lang, 'butler.memory')}: {s.memory}</Txt>
      <Txt testID="checkup-tools" role="body">{t(lang, 'butler.tools')}: {s.tools}</Txt></>}
      {s.note ? <Txt testID="checkup-note" role="small" tone="inkSoft">{s.note}</Txt> : null}
      {s.tested ? <Txt role="small" tone="inkSoft">{s.tested}</Txt> : null}
      {s.attempt ? <Txt testID="checkup-attempt" role="small" tone="inkSoft" accessibilityLiveRegion="polite">{s.attempt}</Txt> : null}
      {data?.suspectedChanged ? <Txt role="small" tone="inkSoft">{t(lang, 'butler.changed')}</Txt> : null}
      {running ? <Button kind="secondary" testID="checkup-cancel" label={t(lang, 'butler.cancel')} disabled={!online} busy={busy} onPress={() => void perform(() => backend.checkupCancel(), next => { setData(next); setEstimate(null) })} /> : estimate ? <>
        <Txt testID="checkup-estimate" role="small" tone="inkSoft">{estimate.summary} {estimate.windowKnown ? '' : t(lang, 'butler.windowUnknown')}</Txt>
        <Button kind="primary" testID="checkup-start" label={t(lang, 'butler.start')} disabled={!online || failed} busy={busy} onPress={() => void perform(() => backend.checkupRun(estimate.targetKey), next => { setData(next); setEstimate(null) })} />
        <Button kind="secondary" testID="checkup-dismiss" label={t(lang, 'butler.dismiss')} disabled={busy} onPress={() => setEstimate(null)} />
      </> : <Button kind="secondary" testID="checkup-prepare" label={t(lang, data?.profile ? 'butler.recheck' : 'butler.check')} disabled={!online || failed} busy={busy} onPress={() => void perform(() => backend.checkupEstimate(), setEstimate)} />}
      <Pressable testID="checkup-periodic" accessibilityRole="switch" accessibilityLabel={t(lang, 'butler.periodic')} accessibilityState={{ checked: !!data?.periodicProbe, disabled: busy || running || !online || failed }} disabled={busy || running || !online || failed} onPress={() => void perform(() => backend.checkupSettings(!data?.periodicProbe), setData)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Txt role="small" tone="inkSoft">{t(lang, 'butler.periodic')}: {t(lang, data?.periodicProbe ? 'butler.on' : 'butler.off')}</Txt>
      </Pressable>
    </>}
    {actionError ? <Txt testID="checkup-action-error" role="small" tone="inkSoft" accessibilityLiveRegion="polite">{actionError}</Txt> : null}
    {failed ? <><Txt testID="checkup-error" role="small" tone="inkSoft">{t(lang, 'butler.unavailable')}</Txt><Button kind="secondary" testID="checkup-retry" label={t(lang, 'common.retry')} disabled={!online} onPress={() => void refresh()} /></> : null}
  </View>
}
