import { useMemo } from 'react'
import { makeDemoBackend } from '../backend/demo'
import type { Backend } from '../backend/types'
import { useLang } from '../i18n/useLang'
import { OfflineReviewProvider } from '../state/BackendProvider'
import Chat from './ConversationScreen'

/** Synthetic messages through the real conversation page; no pairing, network or model calls. */
export function ReplySpeakerReview() {
  const lang = useLang()
  const backend = useMemo<Backend>(() => {
    const demo = makeDemoBackend({ lang, chatFixture: 'reply-speaker' })
    return { ...demo, async home(l) {
      const home = await demo.home(l)
      return { ...home, events: [], unread: 0 }
    } }
  }, [lang])
  return <OfflineReviewProvider backend={backend} lang={lang}><Chat /></OfflineReviewProvider>
}
