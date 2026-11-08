// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CredentialStore } from '../net/credentials'
import { SessionProvider, useSession } from './session'
import { WelcomeGate } from '../ui/WelcomeGate'
import { cleanup, mount } from '../ui/native-motion.test-support'
vi.mock('expo-router', () => ({ Redirect: ({ href }: { href: string }) => createElement('span', { 'data-testid': 'welcome-redirect' }, href) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
it('does not mount a private reader before identity or explicit demo choice, including cold links', async () => {
  let resolve!: (value: null) => void, session!: ReturnType<typeof useSession>
  const read = vi.fn(), store: CredentialStore = { load: () => new Promise(r => { resolve = r }), loadPrefs: async () => ({ lang: null }), save: async () => {}, clear: async () => {}, savePrefs: async () => {} }
  function Expose() { session = useSession(); return null }
  function PrivateReader() { useEffect(read, []); return createElement('span', { 'data-testid': 'private-reader' }, 'private') }
  const ui = await mount(createElement(SessionProvider, { store, push: { clear: async () => {} }, children: createElement('div', null, createElement(Expose), createElement(WelcomeGate, { children: createElement(PrivateReader) })) }))
  expect(ui.byId('private-reader')).toBeNull(); expect(read).not.toHaveBeenCalled()
  await act(async () => { resolve(null); await new Promise(r => setTimeout(r, 0)) }); await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  expect(ui.byId('welcome-redirect')?.textContent).toBe('/welcome'); expect(read).not.toHaveBeenCalled()
  await act(() => session.markWelcomeSeen())
  expect(ui.byId('private-reader')).not.toBeNull(); expect(read).toHaveBeenCalledOnce()
})
