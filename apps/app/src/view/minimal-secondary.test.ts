// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mount } from '../ui/native-motion.test-support'
import { makeDemoBackend } from '../backend/demo'
import { BackendError } from '../backend/types'
import { makeCredentialStore } from '../net/credentials'
import { PushProvider } from '../push/PushProvider'
import { SessionProvider } from '../state/session'
import { withProviders } from '../state/providers.test-support'
import Memory from '../app/memory'
import Settings from '../app/settings'
import Jobs from '../app/jobs'
import Devices from '../app/devices'
import Welcome from '../app/welcome'

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
const pushHost = vi.hoisted(() => ({ permission: 'denied', openSettings: vi.fn() }))
Object.assign(globalThis, { __DEV__: false })
vi.mock('react-native', async () => {
  const { forwardRef } = await import('react')
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('input', { ref, value, 'data-testid': testID, onInput: (event: any) => onChangeText(event.currentTarget.value) }))
  return { ...(await import('../ui/native-motion.test-support')).nativeBoundary(), TextInput, ActivityIndicator: () => null, Alert: { alert: vi.fn() }, Linking: { openSettings: pushHost.openSettings } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({ ...await (await import('../ui/native-motion.test-support')).routerBoundary(), useRouter: () => ({ ...route, canGoBack: () => true }) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }))
vi.mock('expo-secure-store', () => ({ AFTER_FIRST_UNLOCK: 'after-first-unlock', getItemAsync: async () => null, deleteItemAsync: async () => {}, setItemAsync: async () => {} }))
vi.mock('expo-notifications', () => ({
  setNotificationHandler: () => {}, setNotificationCategoryAsync: async () => {}, addPushTokenListener: () => ({ remove() {} }), unregisterForNotificationsAsync: async () => {},
  getPermissionsAsync: async () => ({ status: pushHost.permission, granted: pushHost.permission === 'granted' }),
  getDevicePushTokenAsync: async () => ({ data: 'ab'.repeat(32) }),
}))

afterEach(async () => { await cleanup(); vi.clearAllMocks() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function memory() {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  await backend.correctMemory('d4e5f6', 'wrong')
  const restored = vi.spyOn(backend, 'restoreMemory')
  const ui = await mount(withProviders(createElement(Memory), { backend }))
  await flush()
  const click = async (id: string) => { await act(() => ui.byId(id).click()); await flush() }
  return { ...ui, backend, restored, click }
}

describe('minimal memory disclosures', () => {
  it('opens on factual records; portrait and withdrawn records require an explicit choice', async () => {
    const ui = await memory()
    expect(ui.byId('memory-facts').textContent).toContain('回复喜欢直接')
    expect(ui.byId('todos')).toBeNull()
    expect(ui.byId('portrait')).toBeNull()
    expect(ui.byId('memory-retraction-c:~1')).toBeNull()
    await ui.click('memory-portrait-toggle')
    expect(ui.byId('memory-portrait-note').textContent).toContain('推测')
    expect(ui.byId('portrait')).not.toBeNull()
    await ui.click('memory-retractions-toggle')
    expect(ui.byId('memory-retraction-c:~1').textContent).toContain('周末不安排工作会议')
    expect(ui.restored).not.toHaveBeenCalled()
    await ui.click('memory-restore-c:~1')
    expect(ui.restored).toHaveBeenCalledWith('c:~1')
    expect(ui.byId('memory-restore-note').textContent).toContain('不会回来')
    expect(ui.byId('memory-facts').textContent).toContain('周末不安排工作会议')
  })

  it('keeps todo completion and restore reachable from the todo tab', async () => {
    const ui = await memory()
    await ui.click('memory-tab-todos')
    const active = ui.container.querySelector<HTMLElement>('[data-testid^="todo-done-"]')!
    const id = active.getAttribute('data-testid')!.replace('todo-done-', '')
    await act(() => active.click()); await flush()
    expect(ui.byId('todos-note').textContent).toContain('划掉')
    await ui.click('todos-settled-toggle')
    expect(ui.byId(`todo-restore-${id}`)).not.toBeNull()
    await ui.click(`todo-restore-${id}`)
    expect(ui.byId(`todo-done-${id}`)).not.toBeNull()
    expect(ui.byId('todos-note').textContent).toContain('捞回')
  })
})

it('settings keeps language, full privacy disclosure, and licences behind short labelled entries', async () => {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  const store = makeCredentialStore({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} })
  const node = createElement(SessionProvider, { store, push: { clear: async () => {} }, children: withProviders(createElement(PushProvider, { children: createElement(Settings) }), { backend }) })
  const ui = await mount(node); await flush()
  const click = async (id: string) => { await act(() => ui.byId(id).click()); await flush() }
  expect(ui.byId('settings-memory').textContent).toContain('记忆')
  expect(ui.byId('settings-language')).toBeNull()
  expect(ui.byId('settings-privacy')).toBeNull()
  await click('settings-language-toggle')
  expect(ui.byId('settings-language-system')).not.toBeNull()
  await click('settings-privacy-toggle')
  expect(ui.byId('settings-privacy').textContent).toContain('模型')
  expect(ui.byId('settings-privacy').textContent).toContain('语音')
  await click('settings-about-toggle')
  await click('settings-font-licences')
  expect(route.push).toHaveBeenCalledWith('/licences')
})

it('job details keep pause and confirmed deletion reachable without performing a write on opening', async () => {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  const id = (await backend.jobs()).jobs[0]!.id
  const action = vi.spyOn(backend, 'jobsAction')
  const ui = await mount(withProviders(createElement(Jobs), { backend })); await flush()
  const click = async (testID: string) => { await act(() => ui.byId(testID).click()); await flush() }
  expect(ui.byId(`jobs-pause-${id}`)).toBeNull()
  await click(`jobs-details-${id}`)
  expect(action).not.toHaveBeenCalled()
  await click(`jobs-pause-${id}`)
  expect(action).toHaveBeenCalledWith(id, 'pause')
  expect(ui.byId(`jobs-resume-${id}`)).not.toBeNull()
  await click(`jobs-remove-${id}`)
  expect(action).toHaveBeenCalledTimes(1)
  await click(`jobs-remove-${id}`)
  expect(action).toHaveBeenLastCalledWith(id, 'remove')
  expect(ui.byId(`jobs-row-${id}`)).toBeNull()
})

it('device details allow local rename and explain computer-only removal for other devices', async () => {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  const other = { id: 'other-device', label: 'Other phone', created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), current: false }
  const ownDevices = backend.devices
  backend.devices = async () => [...await ownDevices(), other]
  const rename = vi.spyOn(backend, 'renameDevice')
  const ui = await mount(withProviders(createElement(Devices), { backend })); await flush()
  const click = async (testID: string) => { await act(() => ui.byId(testID).click()); await flush() }
  expect(ui.byId('devices-name-input')).toBeNull()
  await click(`devices-other-${other.id}`)
  expect(ui.byId('devices-other-hint').textContent).toContain('电脑')
  expect(rename).not.toHaveBeenCalled()
  await click('devices-edit')
  const input = ui.byId('devices-name-input') as HTMLInputElement
  await act(() => { input.value = '  My phone  '; input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('devices-save')
  expect(rename).toHaveBeenCalledWith('My phone')
  expect(ui.byId('devices-name-input')).toBeNull()
  expect(ui.byId('devices-local').textContent).toContain('My phone')
})

it('welcome keeps the preview unlit and offers pairing or an explicit preview choice', async () => {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  const store = makeCredentialStore({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} })
  const node = createElement(SessionProvider, { store, push: { clear: async () => {} }, children: withProviders(createElement(Welcome), { backend }) })
  const ui = await mount(node); await flush()
  expect(ui.style('cc-lit').opacity).toBe(0)
  expect(ui.byId('welcome-scroll')?.contains(ui.byId('welcome-pair'))).toBe(true)
  expect(ui.byId('welcome-scroll')?.contains(ui.byId('welcome-look-first'))).toBe(true)
  await act(() => ui.byId('welcome-pair').click())
  expect(route.push).toHaveBeenCalledWith('/pair')
  await act(() => ui.byId('welcome-look-first').click())
  expect(route.replace).toHaveBeenCalledWith('/')
})

it('keeps the confirmed new phone name when the read after a successful rename fails', async () => {
  const backend = makeDemoBackend({ lang: 'zh-Hans' })
  const read = backend.devices, rename = backend.renameDevice
  let failRead = false
  backend.devices = async () => { if (failRead) throw new BackendError('offline'); return read() }
  backend.renameDevice = async label => { await rename(label); failRead = true }
  const ui = await mount(withProviders(createElement(Devices), { backend })); await flush()
  await act(() => ui.byId('devices-edit').click())
  const input = ui.byId('devices-name-input') as HTMLInputElement
  await act(() => { input.value = 'Confirmed name'; input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(() => ui.byId('devices-save').click()); await flush()
  expect(ui.byId('devices-name-input')).toBeNull()
  expect(ui.byId('devices-local').textContent).toContain('Confirmed name')
})

it.each(['denied', 'granted'])('notification details preserve the %s permission action', async permission => {
  pushHost.permission = permission
  const backend = { ...makeDemoBackend({ lang: 'zh-Hans' }), mode: 'live' as const }
  const send = vi.spyOn(backend, 'testPush').mockResolvedValue({ ok: true, code: 'sent' })
  const pairing = { v: 1 as const, daemonId: 'daemon', relayHost: 'relay.example', relayUrl: 'wss://relay.example', deviceToken: `d${'a'.repeat(48)}`, deviceId: 'aa11bb22', pairedAt: 1 }
  const store = { load: async () => pairing, save: async () => {}, clear: async () => {}, loadPrefs: async () => ({ lang: null }), savePrefs: async () => {} }
  const node = createElement(SessionProvider, { store, push: { clear: async () => {} }, children: withProviders(createElement(PushProvider, { children: createElement(Settings) }), { backend }) })
  const ui = await mount(node); await flush(); await flush()
  expect(ui.byId('settings-notifications')).toBeNull()
  await act(() => ui.byId('settings-notifications-toggle').click()); await flush()
  if (permission === 'denied') {
    expect(ui.byId('settings-notif-denied')).not.toBeNull()
    await act(() => ui.byId('settings-notif-open').click())
    expect(pushHost.openSettings).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  } else {
    expect(ui.byId('settings-notif-registered')).not.toBeNull()
    await act(() => ui.byId('settings-notif-test').click()); await flush()
    expect(send).toHaveBeenCalledTimes(1)
  }
})
