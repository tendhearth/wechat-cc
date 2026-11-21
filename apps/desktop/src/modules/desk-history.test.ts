import { expect, it } from 'vitest'
import { createDeskHistory } from './desk-history.js'

const at = (place: string | null) => ({ pane: 'overview', place, detail: null })

it('保留页、地方和详情，去重，并在分岔时截断前进记录', async () => {
  const history = createDeskHistory(at(null))
  const a = at('a')
  const notebook = { ...a, pane: 'notebook' }
  const detail = { ...a, detail: { kind: 'terminal' as const, id: 's1' } }
  expect(history.canMove(-1)).toBe(false)
  history.push(a)
  history.push(notebook)
  history.push({ ...notebook })
  let visited: unknown
  const restore = (entry: unknown) => { visited = entry; return true }
  await history.move(-1, restore)
  expect(visited).toEqual(a)
  await history.move(1, restore)
  expect(visited).toEqual(notebook)
  expect(history.canMove(1)).toBe(false)
  await history.move(-1, restore)
  history.push(detail)
  expect(history.canMove(1)).toBe(false)
  await history.move(-1, restore)
  await history.move(1, restore)
  expect(visited).toEqual(detail)
})

it('同方向跳过无效记录，两头找不到时留在原地', async () => {
  const history = createDeskHistory(at(null))
  history.push(at('a'))
  history.push(at('b'))
  history.push(at('c'))
  const seen: (string | null)[] = []
  expect(await history.move(-1, entry => {
    seen.push(entry.place)
    return entry.place === 'a'
  })).toBe(true)
  expect(seen).toEqual(['b', 'a'])
  expect(await history.move(-1, () => false)).toBe(false)
  expect(history.canMove(-1)).toBe(false)
  expect(await history.move(1, entry => entry.place === 'c')).toBe(true)
})

it('最多保留最近 50 条，包含当前所在位置', async () => {
  const history = createDeskHistory(at(null))
  for (let i = 1; i <= 60; i++) history.push(at(String(i)))
  const places: (string | null)[] = []
  while (history.canMove(-1)) await history.move(-1, entry => { places.push(entry.place); return true })
  expect(places).toHaveLength(49)
  expect(places.at(-1)).toBe('11')
})
