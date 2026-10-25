import { describe, it, expect } from 'vitest'
import { NEIGHBORS, pickNeighbor, neighborById, neighborPersona } from './neighbors'

describe('邻居', () => {
  it('至少 3 位,id 唯一,每位都有性格和主人的生活', () => {
    expect(NEIGHBORS.length).toBeGreaterThanOrEqual(3)
    expect(new Set(NEIGHBORS.map(n => n.id)).size).toBe(NEIGHBORS.length)
    for (const n of NEIGHBORS) {
      expect(n.persona.length).toBeGreaterThan(20)
      expect(n.world.length).toBeGreaterThan(30)
    }
  })

  it('主人们的城市不重样 —— 都是年轻程序员就没得聊了', () => {
    const cities = NEIGHBORS.map(n => n.world.match(/(杭州|成都|深圳|大理|北京|上海|广州|西安|武汉)/)?.[1])
    expect(new Set(cities).size).toBe(NEIGHBORS.length)
  })

  it('轮着去,不连着两天去同一家', () => {
    const a = pickNeighbor(10, null)
    const b = pickNeighbor(10, a.id) // 同一天但上次就是它 → 换一家
    expect(b.id).not.toBe(a.id)
    // 同一天、上次不是它 → 稳定
    expect(pickNeighbor(10, 'someone-else').id).toBe(a.id)
  })

  it('负数天数不炸', () => { expect(pickNeighbor(-3, null)).toBeTruthy() })

  it('neighborById', () => {
    expect(neighborById('ayou')!.name).toBe('阿柚')
    expect(neighborById('nope')).toBeNull()
  })

  it('persona 参数带上次串门的记忆(有就带,没有就不带)', () => {
    const nb = neighborById('ayou')!
    expect(neighborPersona(nb, null).persona).not.toContain('上次')
    expect(neighborPersona(nb, '聊了豆子烘深了').persona).toContain('聊了豆子烘深了')
    expect(neighborPersona(nb, null).ownerOverview).toContain('豆包')
  })
})
