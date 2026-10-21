/**
 * 执行者叫什么,三端**不存名字表**(收敛清单 ⑥,主人 10-21 定)。
 *
 * 名字只有一份:src/lib/executor-facts 的 `names`,经 registry.namesOf / namesIn(两种 Gemini 都开时的
 * 「Gemini(账号)」也在那)由 daemon 下发 —— entry/options 与工作台的 providers[].displayName / settingsLabel、
 * 一件事的 agentNames、终端 / 原生会话行与接着做预览的 displayName、GET /v1/llm/health 的 names。
 * 桌面、App、手机网页只读这些;老 daemon 不带 ⇒ 退回 provider id。以前三端各抄一份,叫法已经分成
 * 「Claude Code / Antigravity / OpenAI-compatible / Gemini (agy)」好几种。
 *
 * 守的范围(故意收得窄,免得误报):
 *  - 只扫三端的界面源码:apps/desktop/src、apps/app/src、apps/mobile/src 下的 .js / .ts / .tsx。
 *    不扫 daemon(src/ —— 名字的唯一出处就在那)、CLI 帮助、协议文档与 docs(那里「OpenAI-compatible」是协议名,
 *    「Claude Code」是要装的程序名)、index.html 与 CSS(装机引导里写的是产品 / 程序名,不是执行者显示名)。
 *  - 跳过测试(*.test.* / *.spec.*:测试里要扮 daemon 给名字)、生成物(*generated*)、vendor 目录。
 *  - 只认「名字表的形状」,不认散文:
 *    A. 以执行者 id 为键、值像显示名的条目(`claude: 'Claude'`、`['codex','Codex']`);
 *       值像命令(全小写,如 LOGIN_COMMAND 的 'codex login')或 SVG 片段(头像图形按 id 认)不算。
 *    B. 按 id 分支给名字的三元式(`=== 'claude' ? 'Claude Code' : …`)。
 *    C. 整个字符串字面量就是一个旧叫法 / 设置写法('Claude Code'、'Antigravity'、'OpenAI-compatible'、
 *       'Gemini (agy)'、'Gemini · 账号连接' …)—— 这些只该从 daemon 来。句子里提到产品名(「改的是 Claude Code
 *       的 settings.json」「安装 Antigravity CLI」)不算。
 *  - 演示后端(apps/app/src/backend/demo*.ts)扮的是 daemon,名字用 demoName(id) 现算,也照样受守。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/lib/provider-ids'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SURFACES = ['apps/desktop/src', 'apps/app/src', 'apps/mobile/src']
const SKIP_DIR = new Set(['node_modules', 'vendor', 'assets'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(name)) out.push(...files(p)); continue }
    if (!/\.(js|ts|tsx)$/.test(name) || /\.(test|spec)\.|generated/.test(name)) continue
    out.push(p)
  }
  return out
}

const ID = `(?:${PROVIDER_IDS.join('|')})`
/** 像给人看的名字:大写字母或汉字开头(命令、id、SVG 都不是)。 */
const NAMEISH = `[A-Z\\u4e00-\\u9fff][^'"\`\\n]*`
const RULES: Array<{ why: string; re: RegExp }> = [
  { why: 'A 以执行者 id 为键的名字表', re: new RegExp(`(?:\\b|['"])${ID}['"]?\\s*:\\s*(['"\`])${NAMEISH}\\1`, 'g') },
  { why: 'A 以执行者 id 为键的名字表(Map 条目)', re: new RegExp(`\\[\\s*['"]${ID}['"]\\s*,\\s*(['"\`])${NAMEISH}\\1`, 'g') },
  { why: 'B 按 id 分支给名字', re: new RegExp(`===?\\s*['"]${ID}['"]\\s*\\?\\s*(['"\`])${NAMEISH}\\1`, 'g') },
  { why: 'C 旧叫法 / 设置写法的字面量', re: /(['"`])(?:Claude Code|Antigravity|OpenAI-compatible|OpenAI compatible|Gemini \(agy\)|Agy|Gemini · 账号连接|Gemini · 密钥连接|自定义 AI 服务|Gemini(账号))\1/g },
]

describe('三端不存执行者名字表(收敛清单 ⑥)', () => {
  it('界面源码里没有 provider id → 显示名的表;名字只读 daemon 下发的', () => {
    const hits: string[] = []
    for (const surface of SURFACES) {
      for (const file of files(join(ROOT, surface))) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          for (const { why, re } of RULES) {
            re.lastIndex = 0
            const m = re.exec(line)
            if (m) hits.push(`${relative(ROOT, file)}:${i + 1} [${why}] ${m[0]}`)
          }
        })
      }
    }
    expect(hits, '名字从 daemon 数据里读(displayName / settingsLabel / agentNames / names),别在界面里另存一份').toEqual([])
  })

  it('守卫自己认得出名字表(防止规则写坏了永远放行)', () => {
    const bad = [
      `const NAMES = { claude: 'Claude Code', agy: 'Antigravity' }`,
      `const L = {"openai":"自定义 AI 服务"}`,
      `new Map([['gemini','Gemini']])`,
      `p === 'codex' ? 'Codex' : 'Claude'`,
      `label = 'OpenAI-compatible'`,
    ]
    for (const line of bad) expect(RULES.some(({ re }) => { re.lastIndex = 0; return re.test(line) }), line).toBe(true)
    const ok = [
      `const LOGIN_COMMAND = { claude: 'claude', codex: 'codex login' }`,
      `claude: '<path d="M4.7"/>'`,
      `note: '改的是 Claude Code 的 ~/.claude/settings.json'`,
      `names?.[id] || id`,
    ]
    for (const line of ok) expect(RULES.some(({ re }) => { re.lastIndex = 0; return re.test(line) }), line).toBe(false)
  })
})
