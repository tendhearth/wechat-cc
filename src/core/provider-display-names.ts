/**
 * 执行者叫什么,全仓库唯一一份解析(收敛清单 ⑥,主人 10-21 定)。名字本身写在 lib/executor-facts 的 `names`;
 * 这里只加一条要看「还开着谁」的规矩:**两种 Gemini 都开着时,账号那一家(agy)叫「Gemini(账号)」**,
 * 微信前缀才分得开。
 *
 * 不在 registry 里,因为 internal-api 在 registry 建起来之前就要解析名字(registry 依赖 internalApi 的端口,
 * 鸡生蛋)。registry 的 `namesOf` 用自己的 list() 调这里。认不出的 id(自定义 ACP、测试里临时注册的)
 * 首字母大写兜底。
 */
import { EXECUTOR_FACTS, type ExecutorNames } from '../lib/executor-facts'
import { isKnownProviderId } from '../lib/provider-ids'

export type { ExecutorNames }

const GEMINI_BY_ACCOUNT = 'Gemini(账号)'

export function executorNames(id: string, registered: readonly string[] = []): ExecutorNames {
  if (!isKnownProviderId(id)) {
    const n = id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1)
    return { name: n, short: n, settings: n }
  }
  const names = EXECUTOR_FACTS[id].names
  if (id === 'agy' && registered.includes('gemini')) return { ...names, name: GEMINI_BY_ACCOUNT, short: GEMINI_BY_ACCOUNT }
  return names
}

/** 短名:微信回复前缀、通知里用的那个。 */
export function providerDisplayName(id: string, registered: readonly string[] = []): string {
  return executorNames(id, registered).short
}
