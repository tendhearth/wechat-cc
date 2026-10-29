// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import Matter from '../app/matter/[id]'
import { withProviders } from '../state/providers.test-support'
import { cleanup, mount } from '../ui/native-motion.test-support'

const route = vi.hoisted(() => ({ id: 'a1b2c3d4' }))
vi.mock('react-native', async () => {
  const { forwardRef } = await import('react')
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('textarea', {
    ref, value, 'data-testid': testID, onInput: (event: any) => onChangeText(event.currentTarget.value),
  }))
  const ScrollView = ({ children, ...props }: any) => createElement('div', { 'data-scroll': true }, createElement(native.View, props, children))
  return { ...native, ScrollView, TextInput, ActivityIndicator: () => null, Linking: { openURL: vi.fn() } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({ id: route.id }),
  useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }), Redirect: () => null,
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

const path = 'src/pages/home.css'
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function screen(id = 'a1b2c3d4') {
  route.id = id
  const backend = makeDemoBackend({ lang: 'en' })
  const ui = await mount(withProviders(createElement(Matter), { backend, lang: 'en' }))
  await flush()
  const click = async (id: string) => { await act(() => ui.byId(id).click()); await flush() }
  const type = async (id: string, text: string) => { await act(() => {
    const input = ui.byId(id) as HTMLTextAreaElement
    input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const closeAndReopen = async () => {
    await click('progress-changes')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    await click('progress-changes')
  }
  return { ...ui, backend, click, type, closeAndReopen }
}

describe('stateful matter changes disclosure', () => {
  it('lazily opens review controls, then preserves an unsent file review across a completed collapse', async () => {
    const ui = await screen()
    expect(ui.byId(`review-return-${path}`)).toBeNull()
    await ui.click('progress-changes'); await ui.click(`review-return-${path}`)
    await ui.type(`review-comment-${path}`, 'Keep the mobile margin')
    await ui.closeAndReopen()
    expect((ui.byId(`review-comment-${path}`) as HTMLTextAreaElement | null)?.value).toBe('Keep the mobile margin')
  })

  it('preserves an unsaved hunk comment across a completed collapse', async () => {
    const ui = await screen()
    await ui.click('progress-changes'); await ui.click(`line-comment-open-${path}-0`)
    await ui.type(`line-comment-input-${path}-0`, 'Keep this hunk note')
    await ui.closeAndReopen()
    expect((ui.byId(`line-comment-input-${path}-0`) as HTMLTextAreaElement | null)?.value).toBe('Keep this hunk note')
  })

  it('does not reset the pending review lock when collapsed and reopened', async () => {
    const ui = await screen()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const submit = vi.fn(() => pending); ui.backend.reviewReturn = submit
    await ui.click('progress-changes'); await ui.click(`review-return-${path}`)
    await ui.type(`review-comment-${path}`, 'Use the smaller spacing')
    await ui.click(`review-send-${path}`)
    await ui.closeAndReopen()
    expect(ui.byId(`review-return-${path}`)).toBeNull()
    expect((ui.byId(`review-send-${path}`) as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    await act(async () => { release(); await pending }); await flush()
    expect(ui.byId(`review-comment-${path}`)).toBeNull()
  })
})

it('keeps every handoff precaution and both actions in a bounded scrollable confirmation without submitting on open or cancel', async () => {
  const ui = await screen('f3a4b5c6')
  const handoff = vi.spyOn(ui.backend, 'handoff')
  await ui.click('progress-handoff-action')
  const sheet = ui.byId('handoff-sheet')
  const height = JSON.parse(sheet.getAttribute('data-style')!).maxHeight
  expect(Number.parseInt(height)).toBeLessThanOrEqual(90)
  const scroll = sheet.querySelector('[data-scroll]')
  for (let i = 0; i < 4; i++) expect(scroll?.contains(ui.byId(`handoff-line-${i}`))).toBe(true)
  expect(scroll?.contains(ui.byId('handoff-confirm'))).toBe(true)
  expect(scroll?.contains(ui.byId('handoff-cancel'))).toBe(true)
  expect(handoff).not.toHaveBeenCalled()
  await ui.click('handoff-cancel')
  expect(ui.byId('handoff-sheet')).toBeNull()
  expect(handoff).not.toHaveBeenCalled()
})
