// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { useFileOpener, type FileRef } from './FileViewer'
import { cleanup, mount } from './native-motion.test-support'
const native = vi.hoisted(() => ({ getSize: vi.fn(), share: vi.fn(async () => ({})), os: 'ios', writes: [] as Uint8Array[], image: null as any }))
vi.mock('react-native', async () => {
  const boundary = (await import('./native-motion.test-support')).nativeBoundary()
  const Image = Object.assign((props: any) => { native.image = props; return createElement('img', { 'data-testid': props.testID, 'data-style': JSON.stringify(props.style), src: props.source.uri }) }, { getSize: native.getSize })
  const ScrollView = ({ children, horizontal, maximumZoomScale, ...props }: any) => createElement('div', { 'data-horizontal': horizontal, 'data-zoom': maximumZoomScale }, createElement(boundary.View, props, children))
  return { ...boundary, Image, ScrollView, Share: { share: native.share }, Linking: { openURL: vi.fn() }, Platform: { get OS() { return native.os }, select: (v: any) => v.ios ?? v.default } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('./native-motion.test-support')).View, SafeAreaProvider: ({ children }: any) => createElement('div', { 'data-safe-root': true }, children) }))
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }))
vi.mock('expo-file-system', () => ({ Paths: { cache: 'cache' }, File: class { uri = 'file:///cache/output'; exists = false; create() {} delete() {} write(bytes: Uint8Array) { native.writes.push(bytes) } } }))
afterEach(cleanup)
beforeEach(() => { native.os = 'ios'; native.share.mockClear(); native.writes.length = 0; native.getSize.mockReset(); native.getSize.mockImplementation((_uri, done) => done(1200, 600)) })
const source = '\r\n# Literal heading\r\n**literal stars**\r\n|a|b|\r\n  keep spacing  \r\n'
async function setup() {
  let opener!: ReturnType<typeof useFileOpener>
  function Reader({ scope = 'first' }: { scope?: string }) { opener = useFileOpener('en', scope); return createElement('div', null, opener.note, opener.viewer) }
  const ui = await mount(createElement(Reader))
  const open = async (ref: FileRef, load = async () => new TextEncoder().encode(source)) => { await act(async () => { await opener.open(ref, load) }) }
  return { ...ui, open, get opener() { return opener }, changeScope: async () => ui.render(createElement(Reader, { scope: 'second' })) }
}
describe('native file reading by real format', () => {
  for (const [name, mime] of [['notes.txt', 'text/plain'], ['data.json', 'application/json'], ['table.csv', 'text/csv']]) it(`preserves exact ${name} source instead of interpreting Markdown`, async () => {
    const ui = await setup(); await ui.open({ id: name!, name: name!, mime: mime! })
    expect(ui.byId('artifact-plain-text')?.textContent).toBe(source)
    expect(ui.byId('artifact-markdown')).toBeNull()
    expect(ui.byId('artifact-close')).not.toBeNull()
  })
  it('uses the shared native Markdown reader only for Markdown files', async () => {
    const ui = await setup(); await ui.open({ id: 'markdown', name: 'notes.md', mime: 'text/plain' })
    expect(ui.byId('artifact-markdown')?.textContent).toContain('Literal heading')
    expect(ui.byId('artifact-markdown')?.textContent).not.toContain('**literal stars**')
    expect(ui.byId('artifact-plain-text')).toBeNull()
  })
  it('uses decoded image dimensions and allows zoom with 44pt close and share actions', async () => {
    const ui = await setup(); await ui.open({ id: 'picture', name: 'wide.png', mime: 'image/png' })
    expect(ui.style('artifact-image').aspectRatio).toBe(2)
    expect(ui.container.querySelector('[data-zoom="4"]')).not.toBeNull()
    expect(ui.byId('artifact-close').closest('[data-safe-root]')).not.toBeNull()
    expect(ui.style('artifact-close').minHeight).toBeGreaterThanOrEqual(44)
    expect(ui.style('artifact-share').minHeight).toBeGreaterThanOrEqual(44)
    await act(() => ui.byId('artifact-share').click())
    expect(native.share).toHaveBeenCalledWith({ url: 'file:///cache/output' })
    expect(native.writes[0]).toEqual(new TextEncoder().encode(source))
    await act(() => ui.byId('artifact-close').click())
    expect(ui.byId('artifact-image')).toBeNull()
  })
  for (const [code, message] of [['too_large', 'over 20 MB'], ['stale', 'just changed'], ['unavailable', "Couldn’t"]]) it(`explains ${code} and permits retry`, async () => {
    const ui = await setup(); const ref = { id: 'bad', name: 'notes.txt', mime: 'text/plain' }
    await ui.open(ref, async () => { throw new BackendError(code as any) })
    expect(ui.opener.note).toContain(code === 'unavailable' ? "Couldn't open" : message)
    expect(ui.opener.busyId).toBeNull()
    await ui.open(ref)
    expect(ui.byId('artifact-plain-text')?.textContent).toBe(source)
    expect(ui.opener.note).toBeNull()
  })
  it('does not show a late download in a different owner’s preview', async () => {
    const ui = await setup(); let done!: (bytes: Uint8Array) => void
    let pending!: Promise<void>
    await act(() => { pending = ui.opener.open({ id: 'old', name: 'old.txt', mime: 'text/plain' }, () => new Promise(resolve => { done = resolve })) })
    await ui.changeScope()
    await act(async () => { done(new TextEncoder().encode(source)); await pending })
    expect(ui.byId('artifact-plain-text')).toBeNull()
    expect(ui.opener.busyId).toBeNull()
  })
})


it('shows an image decode failure and leaves the opener available for another file', async () => {
  native.getSize.mockImplementation((_uri, _done, fail) => fail(new Error('bad image')))
  const ui = await setup(); await ui.open({ id: 'broken', name: 'broken.png', mime: 'image/png' })
  expect(ui.opener.note).toContain("Couldn't open")
  expect(ui.byId('artifact-image')).toBeNull()
  await ui.open({ id: 'next', name: 'next.txt', mime: 'text/plain' })
  expect(ui.byId('artifact-plain-text')?.textContent).toBe(source)
})

it('keeps a readable preview and a retryable error when system sharing fails', async () => {
  const ui = await setup(); await ui.open({ id: 'plain', name: 'plain.txt', mime: 'text/plain' })
  native.share.mockRejectedValueOnce(new Error('share unavailable'))
  await act(() => ui.byId('artifact-share').click())
  expect(ui.byId('artifact-viewer-note')?.textContent).toContain("Couldn't open")
  expect(ui.byId('artifact-plain-text')?.textContent).toBe(source)
  await act(() => ui.byId('artifact-share').click())
  expect(native.share).toHaveBeenCalledTimes(2)
  expect(ui.byId('artifact-viewer-note')).toBeNull()
})

it('states the Android unsupported-file boundary instead of claiming a successful system open', async () => {
  native.os = 'android'
  const ui = await setup(); await ui.open({ id: 'pdf', name: 'document.pdf', mime: 'application/pdf' })
  expect(ui.opener.note).toContain('computer')
  expect(native.share).not.toHaveBeenCalled()
  expect(native.writes).toHaveLength(0)
})

it('offers bounded accessible Android image zoom with a horizontal pan canvas, resets for the next file, and keeps iOS pinch behavior', async () => {
  native.os = 'android'
  const ui = await setup(); const ref = { id: 'wide', name: 'wide.png', mime: 'image/png' }
  await ui.open(ref)
  const initialWidth = Number(ui.style('artifact-image').width)
  expect(initialWidth).toBeGreaterThan(0)
  expect(ui.byId('artifact-image-pan')?.closest('[data-horizontal="true"]')).not.toBeNull()
  expect(ui.style('artifact-zoom-in').minHeight).toBeGreaterThanOrEqual(44)
  expect(ui.style('artifact-zoom-out').minHeight).toBeGreaterThanOrEqual(44)
  expect(ui.byId('artifact-zoom-in').getAttribute('aria-label')).toBe('Zoom in')
  expect((ui.byId('artifact-zoom-out') as HTMLButtonElement).disabled).toBe(true)
  await act(() => ui.byId('artifact-zoom-in').click())
  expect(ui.style('artifact-image').width).toBe(initialWidth * 2)
  expect(ui.style('artifact-image').aspectRatio).toBe(2)
  expect(ui.byId('artifact-zoom-level').textContent).toBe('200%')
  await act(() => ui.byId('artifact-zoom-in').click())
  await act(() => ui.byId('artifact-zoom-in').click())
  expect(ui.style('artifact-image').width).toBe(initialWidth * 4)
  expect((ui.byId('artifact-zoom-in') as HTMLButtonElement).disabled).toBe(true)
  await act(() => ui.byId('artifact-zoom-out').click())
  expect(ui.style('artifact-image').width).toBe(initialWidth * 3)
  await act(() => ui.byId('artifact-close').click())
  await ui.open({ ...ref, id: 'next' })
  expect(ui.style('artifact-image').width).toBe(initialWidth)
  native.os = 'ios'
  await act(() => ui.byId('artifact-close').click())
  await ui.open(ref)
  expect(ui.byId('artifact-zoom-in')).toBeNull()
  expect(ui.container.querySelector('[data-zoom="4"]')).not.toBeNull()
})
