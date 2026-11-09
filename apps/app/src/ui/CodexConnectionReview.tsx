import { useMemo } from 'react'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, ConnectionsT } from '../backend/types'
import { useLang } from '../i18n/useLang'
import { OfflineReviewProvider } from '../state/BackendProvider'
import Connections from '../app/connections'

/** Offline, unpaired E2E fixture. Uses the actual page and its 30-second polling. */
export function CodexConnectionReview() {
  const lang = useLang()
  const backend = useMemo<Backend>(() => {
    const demo = makeDemoBackend({ lang }), started = Date.now()
    return { ...demo, mode: 'live', async connections(): Promise<ConnectionsT> {
      const elapsed = Date.now() - started
      const code = elapsed < 20_000 ? 'terminal.codex_untrusted' : elapsed < 50_000 ? 'terminal.ok' : 'terminal.codex_changed'
      return { generatedAt: Date.now(), sources: [], computers: [{ id: 'home', label: 'UI lab', online: true, since: null, version: null }], recent: [], outputs: [], capabilities: [
        { id: 'terminal', name: 'Codex', state: code === 'terminal.ok' ? 'ok' : 'needs_you', code, params: { n: 0 }, reason: code },
      ] }
    } }
  }, [])
  return <OfflineReviewProvider backend={backend} lang={lang}><Connections /></OfflineReviewProvider>
}
