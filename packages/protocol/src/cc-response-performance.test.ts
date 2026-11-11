import { expect, it } from 'vitest'
import { createCCResponsePerformance } from './cc-activity.js'

it('never performs without fresh speaking evidence, and limits a burst to four authored frames', () => {
  const cc = createCCResponsePerformance()
  expect(cc.frame('idle', 0)).toBeNull()
  expect(cc.frame('thinking', 3000)).toBeNull()
  expect(cc.frame('listening', 4000)).toBeNull()
  expect(cc.frame('speaking', 5000)).toBe(0)
  expect(cc.frame('speaking', 5334)).toBe(2)
  expect(cc.frame('speaking', 5668)).toBeNull()
  expect(cc.frame('speaking', 9000)).toBeNull()
})
it('drops speech inside the cooldown rather than queuing or replaying it later', () => {
  const cc = createCCResponsePerformance()
  cc.frame('speaking', 0); cc.frame('thinking', 900)
  expect(cc.frame('speaking', 1000)).toBeNull()
  expect(cc.frame('speaking', 5000)).toBeNull()
  cc.frame('thinking', 5001)
  expect(cc.frame('speaking', 5002)).toBe(0)
})
it('cancels and consumes interrupted, hidden and reduced bursts without replay', () => {
  const cc = createCCResponsePerformance()
  expect(cc.frame('speaking', 0)).toBe(0)
  expect(cc.frame('speaking', 200, false)).toBeNull()
  expect(cc.frame('speaking', 3000)).toBeNull()
  cc.frame('thinking', 3100, false)
  expect(cc.frame('speaking', 3200, false)).toBeNull()
  expect(cc.frame('speaking', 5000)).toBeNull()
})
