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
 *  - 扫三端的界面源码(apps/desktop/src、apps/app/src、apps/mobile/src)和 daemon 一侧的 src/daemon、src/app、src/domain、src/adapters、
 *    src/cli、src/lib 下的 .js / .ts / .tsx(10-21 扩到 src/:定时那边的 command.ts 手写了一张 EXEC_NAME,
 *    只扫三端时漏了;10-25 加上 src/features:手机搬进 features/phone 时设置页跟着走了,功能目录也得扫)。名字的唯一出处 src/lib/executor-facts.ts 与 src/domain/provider-display-names.ts 不扫。
 *    协议文档与 docs(那里「OpenAI-compatible」是协议名,「Claude Code」是要装的程序名)、index.html 与 CSS
 *    (装机引导里写的是产品 / 程序名,不是执行者显示名)不扫。
 *  - 规则认得出、但确实不是执行者显示名的(终端程序名、解析用的别名、句子),逐条写进 NOT_DISPLAY_NAMES 并说明为什么;
 *    那里的条目不再命中就红(别留过期豁免)。
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
const SURFACES = ['apps/desktop/src', 'apps/app/src', 'apps/mobile/src', 'src/daemon', 'src/features', 'src/app', 'src/domain', 'src/adapters', 'src/cli', 'src/lib']
/** 名字的唯一出处,不扫。 */
const SINGLE_SOURCES = new Set(['src/lib/executor-facts.ts', 'src/domain/provider-display-names.ts'])
const SKIP_DIR = new Set(['node_modules', 'vendor', 'assets'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(name)) out.push(...files(p)); continue }
    if (!/\.(js|ts|tsx)$/.test(name) || /\.(test|spec)\.|generated/.test(name)) continue
    if (SINGLE_SOURCES.has(relative(ROOT, p).split('\\').join('/'))) continue
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

/**
 * 规则命中、但不是执行者显示名的地方(文件 + 命中的那段原文)。加一条要写清为什么;它不再命中 ⇒ 红,删掉。
 */
const NOT_DISPLAY_NAMES: ReadonlyArray<{ file: string; match: string; why: string }> = [
  { file: 'src/daemon/capabilities.ts', match: "claude: 'Claude Code'", why: '接 hooks 的终端程序名(「接上 Claude Code」),不是执行者显示名' },
  { file: 'src/daemon/capabilities.ts', match: "'Claude Code'", why: '同上' },
  { file: 'src/domain/cli-upgrade/specs.ts', match: "'Claude Code'", why: '要升级的 CLI 程序的名字(CLI_SPECS.label),不是执行者显示名' },
  { file: 'src/features/workbench/task-reference.ts', match: "['claude', '克劳德'", why: '解析主人原话用的别名(PROVIDER_WORDS),不是给人看的名字' },
  { file: 'src/features/phone/settings-panel-html.ts', match: '=== "codex" ? "同 Claude 那格"', why: '一句说明(codex 的模型跟 Claude 那格),不是名字' },
]

describe('三端与 daemon 不另存执行者名字表(收敛清单 ⑥)', () => {
  it('源码里没有 provider id → 显示名的表;名字只读 executor-facts / daemon 下发的', () => {
    const hits: string[] = []
    const allowed = new Set<number>()
    for (const surface of SURFACES) {
      for (const file of files(join(ROOT, surface))) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          for (const { why, re } of RULES) {
            re.lastIndex = 0
            const m = re.exec(line)
            if (!m) continue
            const rel = relative(ROOT, file).split('\\').join('/')
            const ok = NOT_DISPLAY_NAMES.findIndex(a => a.file === rel && a.match === m[0])
            if (ok >= 0) { allowed.add(ok); continue }
            hits.push(`${rel}:${i + 1} [${why}] ${m[0]}`)
          }
        })
      }
    }
    expect(hits, '名字从 executor-facts / daemon 数据里读(namesOf / displayName / settingsLabel / agentNames / names),别另存一份').toEqual([])
    expect(NOT_DISPLAY_NAMES.filter((_, i) => !allowed.has(i)).map(a => `${a.file}: ${a.match}`), '豁免已经不命中了:从 NOT_DISPLAY_NAMES 删掉').toEqual([])
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
