/**
 * 把 ACP spike 的真机报文抄本切成仓库里的 fixture(脱敏 + 只留用得上的场景)。
 *
 *   bun scripts/acp-fixture-from-transcript.ts <transcript.jsonl> <out.jsonl>
 *
 * 抄本每行 `{ t, scenario, dir: 'in'|'out'|'stderr'|'exit'|'in-unparsed', note?, payload }`。
 * 只保留 `dir ∈ {in,out}` 且场景在 KEEP_SCENARIOS 里的行,顺序照旧,`t` 保留。
 *
 * 脱敏(仓库里不许出现任何真机秘密 / 主人的用户名):
 *  - env 里 `WECHAT_SESSION_TOKEN` 的 value ⇒ `<redacted>`;
 *  - env 里 `WECHAT_INTERNAL_TOKEN_FILE` 的 value ⇒ 固定的 owner 路径;
 *  - 任何字符串里的用户名(从 `/Users/<name>/` 认出来,连同下划线换成短横线的变体
 *    —— CC 的 scratchpad 路径把 `/Users/x/y` 编码成 `-Users-x-y`)⇒ `owner`。
 *
 * 幂等:同一份输入两次生成 diff 为空;把生成好的 fixture 再喂回来也不会变。
 * 只用 node:fs —— 这是仓库脚本,不依赖 Bun 全局,`vitest`(node 作业)下也读得动同一份数据。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const KEEP_SCENARIOS: ReadonlySet<string> = new Set(['c1', 'c2shellreject', 'c4both', 'c5', 'c5load'])
const KEEP_DIRS: ReadonlySet<string> = new Set(['in', 'out'])
const OWNER = 'owner'
const OWNER_TOKEN_FILE = `/Users/${OWNER}/.claude/channels/wechat/internal-token`
/** 名字 ⇒ 固定替换值。value 是秘密或主人特有路径的 env 都在这儿。 */
const ENV_REPLACEMENTS: Record<string, string> = {
  WECHAT_SESSION_TOKEN: '<redacted>',
  WECHAT_INTERNAL_TOKEN_FILE: OWNER_TOKEN_FILE,
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const isObject = (value: Json): value is { [key: string]: Json } => !!value && typeof value === 'object' && !Array.isArray(value)

/** 抄本里出现过的用户名变体,长的排前面(先替换 `nategu_mac_company` 再轮到 `nategu`)。 */
export function usernameVariants(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
    const name = match[1]
    if (!name || name === OWNER) continue
    names.add(name)
    if (name.includes('_')) names.add(name.replace(/_/g, '-')) // scratchpad 路径的编码变体
  }
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

export function redactText(text: string, variants: readonly string[]): string {
  let out = text
  for (const variant of variants) out = out.split(variant).join(OWNER)
  return out
}

function redactJson(value: Json, variants: readonly string[]): Json {
  if (typeof value === 'string') return redactText(value, variants)
  if (Array.isArray(value)) return value.map(item => redactJson(item, variants))
  if (!isObject(value)) return value
  const out: { [key: string]: Json } = {}
  for (const [key, item] of Object.entries(value)) {
    // `{ name, value }` 是 ACP 的 env 条目形状 —— 按名字钉死 value,不指望正则认得出秘密。
    const replacement = key === 'value' && typeof value.name === 'string' ? ENV_REPLACEMENTS[value.name] : undefined
    out[key] = replacement !== undefined ? replacement : redactJson(item, variants)
  }
  return out
}

export function buildFixture(transcript: string): { text: string; kept: number; scenarios: string[] } {
  const lines = transcript.split('\n').filter(line => line.trim())
  const records: { scenario: string; line: Json }[] = []
  for (const line of lines) {
    const record = JSON.parse(line) as Json
    if (!isObject(record)) continue
    const { scenario, dir } = record
    if (typeof scenario !== 'string' || typeof dir !== 'string') continue
    if (!KEEP_SCENARIOS.has(scenario) || !KEEP_DIRS.has(dir)) continue
    records.push({ scenario, line: record })
  }
  const variants = usernameVariants(records.map(r => JSON.stringify(r.line)).join('\n'))
  const text = records.map(r => JSON.stringify(redactJson(r.line, variants))).join('\n') + '\n'
  return { text, kept: records.length, scenarios: [...new Set(records.map(r => r.scenario))] }
}

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('用法: bun scripts/acp-fixture-from-transcript.ts <transcript.jsonl> <out.jsonl>')
  process.exit(2)
}
const built = buildFixture(readFileSync(input, 'utf8'))
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, built.text)
console.error(`${output}: ${built.kept} 行,场景 ${built.scenarios.join(', ')}`)
