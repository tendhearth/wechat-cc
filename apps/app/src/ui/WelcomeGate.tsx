import { Redirect } from 'expo-router'
import type { ReactNode } from 'react'
import { useSession } from '../state/session'

/** Cold private-surface links wait for identity, then require pairing or explicit demo entry. */
export function WelcomeGate({ children }: { children: ReactNode }) {
  const session = useSession()
  if (!session.ready) return null
  if (!session.seenWelcome) return <Redirect href="/welcome" />
  return <>{children}</>
}
