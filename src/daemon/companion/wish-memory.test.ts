import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWishes, writeWishes, markWishSeen, WISH_SEEN_TTL_MS } from './wish-memory'
import type { WishRecord } from '../../core/wish'

const dir = () => mkdtempSync(join(tmpdir(), 'wishmem-'))
const w: WishRecord = { id: 'abcd1234', text: 't', redacted: 't', status: 'draft', createdAt: '2026-09-04T10:00:00.000Z', sentAt: null, expiresAt: null, sentTo: 0, replies: 0 }

describe('wishes.json', () => {
  it('没文件 → [];写了读回来;坏 JSON / 形状不对 → []', () => {
    const d = dir()
    expect(readWishes(d)).toEqual([])
    writeWishes(d, [w])
    expect(readWishes(d)).toEqual([w])
    writeFileSync(join(d, 'companion', 'wishes.json'), '{oops')
    expect(readWishes(d)).toEqual([])
    writeFileSync(join(d, 'companion', 'wishes.json'), JSON.stringify({ wishes: 'nope' }))
    expect(readWishes(d)).toEqual([])
  })
  it('容忍 BOM(PowerShell 写的文件)', () => {
    const d = dir(); mkdirSync(join(d, 'companion'), { recursive: true })
    writeFileSync(join(d, 'companion', 'wishes.json'), '﻿' + JSON.stringify({ wishes: [w] }))
    expect(readWishes(d)).toEqual([w])
  })
})

describe('wishes-seen.json', () => {
  it('第一次 true,第二次 false;14 天前的键被清掉', () => {
    const d = dir()
    expect(markWishSeen(d, 'w1:ch', '2026-09-04T10:00:00.000Z')).toBe(true)
    expect(markWishSeen(d, 'w1:ch', '2026-09-04T10:00:01.000Z')).toBe(false)
    const later = new Date(Date.parse('2026-09-04T10:00:00.000Z') + WISH_SEEN_TTL_MS + 1000).toISOString()
    expect(markWishSeen(d, 'w2:ch', later)).toBe(true)
    // w1 已被清:再记一次又是 true
    expect(markWishSeen(d, 'w1:ch', later)).toBe(true)
  })
  it('坏文件当空', () => {
    const d = dir(); mkdirSync(join(d, 'companion'), { recursive: true })
    writeFileSync(join(d, 'companion', 'wishes-seen.json'), 'garbage')
    expect(markWishSeen(d, 'k', '2026-09-04T10:00:00.000Z')).toBe(true)
  })
})
