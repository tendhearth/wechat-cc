/** 入站各路由共用真实 provider 登记；不猜任何网关模型名字。 */
import { namesIn, type ProviderRegistry } from '../app/provider-registry'
import { EXECUTOR_FACTS } from '../lib/executor-facts'
import { isKnownProviderId } from '../lib/provider-ids'
import { supportsOneoffAnswer } from '../domain/answer-target'

const answerAliases = (id: string): readonly string[] => isKnownProviderId(id) ? EXECUTOR_FACTS[id].aliases ?? [] : []

/** 点名答话的目录：仅 registry 的真实 id，不根据网关模型名生成执行者。 */
export function answerTargetProviders(registry: Pick<ProviderRegistry, 'get' | 'list'>, available: (id: string) => boolean) {
  return registry.list().map(id => ({ id, names: [...new Set([id, ...Object.values(namesIn(registry, id)), ...answerAliases(id)])], available: supportsOneoffAnswer(id) && available(id) }))
}

/** 已知但尚未注册的名字仅用于解释不可用，绝不拿它们执行。 */
export function unavailableAnswerNames(registry: Pick<ProviderRegistry, 'list'>): string[] {
  const registered = registry.list()
  return Object.values(EXECUTOR_FACTS).filter(f => !registered.includes(f.id)).flatMap(f => [f.id, ...Object.values(f.names), ...answerAliases(f.id)])
}

export function taskHandoffNames(registry: Pick<ProviderRegistry, 'get' | 'list'>, config: { openaiModel?: string; openaiAliases?: Record<string, string> } = {}): string[] {
  const ids = registry.list()
  const names = ids.flatMap(id => [id, ...Object.values(namesIn(registry, id)), ...(isKnownProviderId(id) ? [EXECUTOR_FACTS[id].slash] : []), ...(id === 'claude' ? ['克劳德'] : [])])
  if (ids.includes('openai')) names.push(config.openaiModel ?? '', ...Object.keys(config.openaiAliases ?? {}), ...Object.values(config.openaiAliases ?? {}))
  return [...new Set(names.filter(n => n.trim()))]
}
