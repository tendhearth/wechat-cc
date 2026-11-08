import { expect, it, vi } from 'vitest'
vi.mock('expo-constants', () => ({ default: { nativeBuildVersion: '42' } }))
import './install-build'
import { appBuild } from './build'

it('reads the installed native build number before App clients are created', () => {
  expect(appBuild.value).toBe('42')
})
