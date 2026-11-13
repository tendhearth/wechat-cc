/** 入站各路由共用真实 provider 登记；不猜任何网关模型名字。 */
import { namesIn, type ProviderRegistry } from '../app/provider-registry'
import { EXECUTOR_FACTS } from '../lib/executor-facts'
import { isKnownProviderId } from '../lib/provider-ids'

export function taskHandoffNames(registry: Pick<ProviderRegistry, 'get' | 'list'>, config: { openaiModel?: string; openaiAliases?: Record<string, string> } = {}): string[] {
  const ids = registry.list()
  const names = ids.flatMap(id => [id, ...Object.values(namesIn(registry, id)), ...(isKnownProviderId(id) ? [EXECUTOR_FACTS[id].slash] : []), ...(id === 'claude' ? ['克劳德'] : [])])
  if (ids.includes('openai')) names.push(config.openaiModel ?? '', ...Object.keys(config.openaiAliases ?? {}), ...Object.values(config.openaiAliases ?? {}))
  return [...new Set(names.filter(n => n.trim()))]
}
