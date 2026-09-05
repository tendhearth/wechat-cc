import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPlanLog, appendPlanLog } from './plan-memory'
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
  it('跨天:读昨天的文件得 [];追加时先清掉昨天的', () => {
    appendPlanLog(dir, '2026-05-12', e())
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['visit'])
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
