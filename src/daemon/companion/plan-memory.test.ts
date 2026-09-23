import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPlanLog, appendPlanLog, readPlanLogDays, PLAN_LOG_KEEP_DAYS } from './plan-memory'
import type { PlanLogEntry } from '../../core/companion-plan'

const e = (over: Partial<PlanLogEntry> = {}): PlanLogEntry => ({ at: '2026-05-13T02:00:00.000Z', chatId: 'c1', candidates: ['hunt'], decision: 'none', why: 'w', source: 'model', ...over })

describe('plan-memory', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plan-mem-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('缺文件 → [];追加后能读回;文件里带 day', () => {
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e())
    appendPlanLog(dir, '2026-05-13', e({ decision: 'hunt' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['none', 'hunt'])
  })
  it('跨天:读昨天仍读得到(留存),读今天得 [];追加今天不抹昨天', () => {
    appendPlanLog(dir, '2026-05-12', e())
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['visit'])
    expect(readPlanLog(dir, '2026-05-12').map(x => x.decision)).toEqual(['none'])
  })
  it('readPlanLogDays:按 at 升序拍平,days 限制取最近几天', () => {
    appendPlanLog(dir, '2026-05-11', e({ at: '2026-05-11T01:00:00.000Z', decision: 'hunt' }))
    appendPlanLog(dir, '2026-05-13', e({ at: '2026-05-13T03:00:00.000Z', decision: 'visit' }))
    appendPlanLog(dir, '2026-05-13', e({ at: '2026-05-13T01:00:00.000Z', decision: 'none' }))
    expect(readPlanLogDays(dir, 14).map(x => x.decision)).toEqual(['hunt', 'none', 'visit'])
    expect(readPlanLogDays(dir, 1).map(x => x.decision)).toEqual(['none', 'visit'])
    expect(readPlanLogDays(dir, 0)).toEqual([])
  })
  it('只留最近 PLAN_LOG_KEEP_DAYS 天', () => {
    for (let d = 1; d <= PLAN_LOG_KEEP_DAYS + 3; d++) {
      const day = `2026-06-${String(d).padStart(2, '0')}`
      appendPlanLog(dir, day, e({ at: `${day}T00:00:00.000Z` }))
    }
    expect(readPlanLog(dir, '2026-06-01')).toEqual([])
    expect(readPlanLog(dir, '2026-06-03')).toEqual([])
    expect(readPlanLog(dir, '2026-06-04')).toHaveLength(1)
    expect(readPlanLogDays(dir, 99)).toHaveLength(PLAN_LOG_KEEP_DAYS)
  })
  it('旧形状 {day, entries} 读得出,追加后迁成 {days}', () => {
    mkdirSync(join(dir, 'companion'), { recursive: true })
    writeFileSync(join(dir, 'companion', 'plan-log.json'), JSON.stringify({ day: '2026-05-13', entries: [e({ decision: 'hunt' })] }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['hunt'])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    const raw = JSON.parse(readFileSync(join(dir, 'companion', 'plan-log.json'), 'utf8')) as { days?: Record<string, unknown[]> }
    expect(Object.keys(raw.days ?? {})).toEqual(['2026-05-13'])
    expect(raw.days!['2026-05-13']).toHaveLength(2)
  })
  it('坏 JSON / BOM 前缀 / 形状不对 → [] 且不抛', () => {
    mkdirSync(join(dir, 'companion'), { recursive: true })
    writeFileSync(join(dir, 'companion', 'plan-log.json'), '{not json')
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    writeFileSync(join(dir, 'companion', 'plan-log.json'), '﻿' + JSON.stringify({ day: '2026-05-13', entries: [e()] }))
    expect(readPlanLog(dir, '2026-05-13')).toHaveLength(1)
    writeFileSync(join(dir, 'companion', 'plan-log.json'), JSON.stringify({ day: '2026-05-13', entries: 'nope' }))
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
  })
})
