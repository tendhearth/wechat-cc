import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIntroIndex, writeIntroIndex } from './intro-memory'
import { emptyIntroIndex } from '../../core/intro'

const dir = () => mkdtempSync(join(tmpdir(), 'intromem-'))
describe('introductions.json', () => {
  it('没文件 → 空索引;写了读回;坏文件 → 空;缺表补齐;容忍 BOM', () => {
    const d = dir()
    expect(readIntroIndex(d)).toEqual(emptyIntroIndex())
    const idx = { ...emptyIntroIndex(), replies: { r1: { wishId: 'w', fromChannel: 'c', at: '2026-09-04T10:00:00.000Z' } } }
    writeIntroIndex(d, idx)
    expect(readIntroIndex(d)).toEqual(idx)
    writeFileSync(join(d, 'companion', 'introductions.json'), '{nope')
    expect(readIntroIndex(d)).toEqual(emptyIntroIndex())
    writeFileSync(join(d, 'companion', 'introductions.json'), '﻿' + JSON.stringify({ forwards: { w: { from: 'a', to: [], preview: '', at: 'x' } } }))
    expect(readIntroIndex(d)).toEqual({ ...emptyIntroIndex(), forwards: { w: { from: 'a', to: [], preview: '', at: 'x' } } })
    const d2 = dir(); mkdirSync(join(d2, 'companion'), { recursive: true })
    writeFileSync(join(d2, 'companion', 'introductions.json'), JSON.stringify({ forwards: 'bad' }))
    expect(readIntroIndex(d2)).toEqual(emptyIntroIndex())
  })
})
