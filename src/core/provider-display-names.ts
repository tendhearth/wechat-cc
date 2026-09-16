/**
 * 执行者 / 大脑的展示名,全仓库唯一一份(评审 2026-09-16:此前 core、daemon、微信管家各有
 * 一张表,加一家要改三处)。core 与 daemon 都从这里拿;daemon/provider-display-names.ts
 * 只是转出口。
 *
 * 不在 registry 里,因为 internal-api 在 registry 建起来之前就要解析名字(registry 依赖
 * internalApi 的端口,鸡生蛋)。加一家 = 这里加一行 + 向 ProviderRegistry 注册。
 * 不认识的 id 首字母大写兜底,测试里临时注册的一次性 provider 也能读。
 */
const KNOWN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  openai: 'API',
  cursor: 'Cursor',
  agy: 'agy',
})

export function providerDisplayName(id: string): string {
  if (KNOWN_NAMES[id]) return KNOWN_NAMES[id]!
  if (id.length === 0) return id
  return id.charAt(0).toUpperCase() + id.slice(1)
}
