// @ts-check
// Use current bridge facts, never renderer motion or unbounded backend wording.
/**
 * @param {unknown} intent
 * @param {unknown} [permissionCount]
 * @returns {{ text: string, ariaLabel: string }}
 */
export function formatCompanionStatus(intent, permissionCount = 0) {
  const fact = intent && typeof intent === 'object' ? /** @type {{ form?: unknown, behavior?: unknown }} */ (intent) : null
  if (fact?.form !== 'lit') return { text: '暂时联系不上', ariaLabel: 'CC，暂时联系不上' }

  let activity = ''
  if (typeof permissionCount === 'number' && Number.isSafeInteger(permissionCount) && permissionCount > 0) activity = '等你决定'
  else switch (fact.behavior) {
    case 'thinking': activity = '想一想'; break
    case 'working': activity = '正在做'; break
    case 'companion': activity = '陪伴中'; break
    case 'permission': activity = '等你决定'; break
  }
  return {
    text: activity ? `已连接 · ${activity}` : '已连接',
    ariaLabel: activity ? `CC，已连接，${activity}` : 'CC，已连接',
  }
}
