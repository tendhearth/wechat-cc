/**
 * `/api list` 的模型发现:打 OpenAI 兼容网关的 GET {base}/models,拿回它
 * 现在挂着的模型名。主人那份 llm-public-key.txt 一周一改(上架/下架/改名/
 * 大小写陷阱),靠记是记不住的 —— 问网关本人。
 *
 * 只在主人发 `/api list` 时拨(用户主动触发,不是后台外呼 —— 与 llm-health
 * 的「绝不自动外呼」同一条纪律);60s 内重复问走缓存。拨不通不抛,返回
 * error 字符串,列表照样把别名和当前钉的显示出来。
 */

export interface OpenaiModelsResult {
  models: string[]
  /** 人话错误(网关不通 / 401 / 返回形状不对);有它时 models 为 []。 */
  error?: string
  fromCache?: boolean
}

export interface OpenaiModelsDeps {
  baseUrl: () => string | undefined
  apiKey: () => string | undefined
  fetchFn?: typeof fetch
  now?: () => number
  timeoutMs?: number
  cacheMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_MS = 60_000

/** 网关的 /models 形状:OpenAI 标准是 {data:[{id}]};LiteLLM 也是;个别
 *  网关直接给 {models:[...]} 或 string[]。三种都认,其他算「形状不对」。 */
export function parseModelsBody(body: unknown): string[] | null {
  const pick = (arr: unknown): string[] | null => {
    if (!Array.isArray(arr)) return null
    const out: string[] = []
    for (const it of arr) {
      if (typeof it === 'string') out.push(it)
      else if (it && typeof it === 'object' && typeof (it as { id?: unknown }).id === 'string') out.push((it as { id: string }).id)
    }
    return out
  }
  if (Array.isArray(body)) return pick(body)
  if (body && typeof body === 'object') {
    const o = body as { data?: unknown; models?: unknown }
    return pick(o.data) ?? pick(o.models)
  }
  return null
}

export function makeOpenaiModels(deps: OpenaiModelsDeps): { list(): Promise<OpenaiModelsResult> } {
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  let cache: { at: number; base: string; models: string[] } | null = null

  return {
    async list() {
      const base = deps.baseUrl()
      const key = deps.apiKey()
      if (!base) return { models: [], error: '还没配 openaiBaseUrl' }
      if (!key) return { models: [], error: 'WECHAT_OPENAI_API_KEY 没配(daemon.env),配完要重启' }
      if (cache && cache.base === base && now() - cache.at < (deps.cacheMs ?? DEFAULT_CACHE_MS)) {
        return { models: cache.models, fromCache: true }
      }
      const url = base.replace(/\/+$/, '') + '/models'
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      try {
        const res = await fetchFn(url, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal })
        if (!res.ok) {
          return { models: [], error: res.status === 401 || res.status === 403 ? `网关拒绝了这把 key(HTTP ${res.status})` : `网关 HTTP ${res.status}` }
        }
        const parsed = parseModelsBody(await res.json().catch(() => null))
        if (!parsed) return { models: [], error: '网关返回的不是模型列表' }
        const models = Array.from(new Set(parsed)).sort((a, b) => a.localeCompare(b))
        cache = { at: now(), base, models }
        return { models }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { models: [], error: ctrl.signal.aborted ? '网关没在 5 秒内回话' : `连不上网关:${msg}` }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
