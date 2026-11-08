import type { ProviderRegistry } from './provider-registry'

export const TURN_JUDGE_TIMEOUT_MS = 2500

/** 回合内秒级判定独立于后台便宜模型。无 API 后端时只用索引，不启动慢 CLI。 */
export function turnJudge(registry: Pick<ProviderRegistry, 'get'>, preferred = 'auto', log?: (tag: string, line: string) => void) {
  const ids = preferred === 'index' ? [] : preferred === 'auto' ? ['openai'] : [preferred]
  for (const id of ids) {
    const provider = registry.get(id)?.provider
    if (!provider?.cheapEval) continue
    return Object.assign(async (prompt: string) => {
      const start = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([provider.cheapEval!(prompt), new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('turn_judge_timeout')),TURN_JUDGE_TIMEOUT_MS)})])
      } finally {
        clearTimeout(timer)
        log?.('TURN_JUDGE', `via=${id} elapsedMs=${Date.now() - start}`)
      }
    }, { via: id })
  }
  log?.('TURN_JUDGE', 'via=index elapsedMs=0')
  return null
}
