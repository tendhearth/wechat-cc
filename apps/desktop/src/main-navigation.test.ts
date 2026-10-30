import { expect, it } from 'vitest'
import { mainDestination } from './main-navigation.js'
it('only accepts the explicit main-window destinations from untrusted events', () => {
  expect(mainDestination('overview')).toBe('overview')
  expect(mainDestination('a2a-agents')).toBe('a2a-agents')
  for (const value of [null, {}, '', 'settings', '../overview', 'https://example.com', '<script>']) expect(mainDestination(value)).toBeNull()
})
