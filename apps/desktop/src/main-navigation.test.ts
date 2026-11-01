import { expect, it } from 'vitest'
import { mainDestination } from './main-navigation.js'
import * as navigation from './main-navigation.js'
it('only accepts the explicit main-window destinations from untrusted events', () => {
  expect(mainDestination('overview')).toBe('overview')
  expect(mainDestination('a2a-agents')).toBe('a2a-agents')
  expect(mainDestination('converse')).toBe('converse')
  for (const value of [null, {}, '', 'settings', '../overview', 'https://example.com', '<script>']) expect(mainDestination(value)).toBeNull()
})

it('keeps fast pending conversation navigation until the dashboard is visible', async () => {
  const seen: string[] = []
  const nav = navigation.createMainNavigation((page: string) => seen.push(page))
  await nav.restore(Promise.resolve('converse'))
  expect(seen).toEqual([])
  nav.setReady(true); nav.setReady(true)
  expect(seen).toEqual(['converse'])
})

it('applies a slow pending conversation immediately after dashboard readiness', async () => {
  const seen: string[] = []
  const nav = navigation.createMainNavigation((page: string) => seen.push(page))
  let resolve!: (page: string) => void
  const pending = nav.restore(new Promise<string>(done => { resolve = done }))
  nav.setReady(true); resolve('converse'); await pending
  expect(seen).toEqual(['converse'])
})

it('a newer live destination wins over an older asynchronous pending result', async () => {
  const seen: string[] = []
  const nav = navigation.createMainNavigation((page: string) => seen.push(page))
  let resolve!: (page: string) => void
  const pending = nav.restore(new Promise<string>(done => { resolve = done }))
  nav.request('a2a-agents'); resolve('converse'); await pending
  nav.setReady(true)
  expect(seen).toEqual(['a2a-agents'])
  expect(nav.request('https://example.com')).toBe(false)
  expect(nav.request('converse')).toBe(true)
  expect(seen).toEqual(['a2a-agents', 'converse'])
})
