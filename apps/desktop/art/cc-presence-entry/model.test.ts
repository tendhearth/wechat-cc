import { expect, it } from 'vitest'
import { makePreview } from './model.js'

it('keeps management phases independent of project navigation', () => {
  const p = makePreview()
  p.setPhase('login','decision')
  p.select('talk')
  expect(p.phase('talk')).toBe('complete')
  p.select('login')
  expect(p.phase('login')).toBe('decision')
})
it('records a decision in the original task only', () => {
  const p = makePreview()
  p.setPhase('login','decision')
  p.decide('login','回到原页面')
  expect(p.phase('login')).toBe('running')
  expect(p.choices.login).toBe('回到原页面')
  expect(p.phase('talk')).toBe('complete')
  expect(() => p.decide('talk','回到首页')).toThrow()
})
it('rejects unsupported phases and retains conversation isolation', () => {
  const p = makePreview()
  expect(() => p.setPhase('login','invalid')).toThrow()
  expect(() => p.setPhase('home','running')).toThrow()
  p.setDraft('home','今天有点累')
  p.setDraft('login','修复要求')
  p.select('talk')
  expect(p.scopes.home!.draft).toBe('今天有点累')
  expect(p.scopes.login!.draft).toBe('修复要求')
})
