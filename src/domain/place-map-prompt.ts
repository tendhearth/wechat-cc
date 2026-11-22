import type { PlaceMapBranchT, PlaceMapItemT } from '@wechat-cc/protocol'

export type PlacedItem = Pick<PlaceMapItemT, 'id' | 'kind' | 'line'> & { branch: PlaceMapBranchT }

const labels: Record<PlaceMapBranchT, string> = {
  open: '还没解决', active: '正在做', decided: '定了', done: '做过了', noted: '只是记一下',
}

export const placementPriority = (branch: PlaceMapBranchT) => branch === 'open' ? 0 : branch === 'active' ? 1 : 2

export function placedPastEntryIds(items: readonly PlacedItem[]): Set<string> {
  return new Set(items.filter(item => item.id.startsWith('e:') && (item.branch === 'done' || item.branch === 'noted'))
    .map(item => item.id.slice(2)))
}

/** Input is newest first within each priority. Text stays on its own data line. */
export function renderPlacedItems(items: readonly PlacedItem[]): string {
  const lines = ['主人自己在图上摆过的(和上面有出入时以这段为准):']
  let length = lines[0]!.length
  for (const item of [...items].sort((a, b) => placementPriority(a.branch) - placementPriority(b.branch)).slice(0, 8)) {
    const text = [...item.line.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')].slice(0, 60).join('')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const line = `- ${labels[item.branch]}:${text}`
    length += [...line].length + 1
    if (length > 400) break
    lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
