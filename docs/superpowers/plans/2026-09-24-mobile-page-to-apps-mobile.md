# 手机页前端搬到 apps/mobile 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把随身 CC 手机页(`/m`)的 HTML/CSS/JS 从 `src/daemon/` 里的 TS 字符串模板搬成 `apps/mobile/src/` 下的真文件,构建期组装成一份生成物给 daemon 用,加上 JS 类型检查与 depcheck 边界 —— 搬家期间服务出去的字节一个不差。

**Architecture:** `apps/mobile/src/*.{html,css,js}` 是源码,用 `{{>file}}` 在构建期互相包含、用 `{{大写键}}` 给运行时留空。`bun run build:mobile` 把它们组装成 `src/daemon/mobile-page.generated.json`(与 `mobile-presence-art.json` 同一招:编译后的 sidecar 没有源码树,生成物随 JSON 编进二进制)。daemon 侧 `src/daemon/mobile-page.ts` 只读生成物、按请求单趟填空。脚本仍是经典脚本(非 ES module)、仍全部内联进一份文档 —— 公网壳页 `relay/pset.html` 靠 `document.write` 整份写入,不能有外链资源。

**Tech Stack:** Bun(构建脚本,只用 `node:fs`,node 下也能跑)、TypeScript `checkJs` + JSDoc 类型转换、vitest(bun / node 双跑)、dependency-cruiser。

**Spec:** 定案来自 2026-09-24 与 owner 的讨论(本节即 spec):
- 不拆仓库、不拆发版:手机页没有自己的后端,`/m/api/*` 契约跟 daemon 同步演进;Tauri 手机壳(台阶 B)到时也是 `apps/mobile` 里加 `src-tauri`,仍同仓库。
- 要拆的是代码位置:手机前端现在是 `settings-panel-html.ts`(776 行)+ `mobile-workbench-client.ts` + `mobile-presence-view.ts` 里的 `String.raw` / 模板字符串,无类型、改起来看不见语法高亮;idle `label:''` 白屏那类 bug 就住在这里。
- 边界:`apps/mobile` 只通过 HTTP 跟 daemon 说话,不 import `src/`;daemon 只吃生成物,不 import `apps/mobile`。
- 暂不抽桌面 / 手机共享组件库(形态差太多,第三处重复再说)。`/set` 设置页(`pageHtml`)不在本次范围,只是它内联的传输层 `TUNNEL_CLIENT_JS` 源头搬到 `apps/mobile/src/transport.js`。

## Global Constraints

- 只在 `dev` 分支上干活(工作树 `~/Documents/tendhearth/wechat-cc-cc-kit` 就在 dev);不碰兄弟工作树;进 master 只走 PR + squash。
- Task 1–3 期间 `phoneHtml` / `pageHtml` / `SW_JS` / `M_BOOTSTRAP_HTML` 的输出**逐字节不变**(金标测试钉死);Task 4 只允许插入 JSDoc 类型转换带来的字节变化,且必须审过金标 diff。
- 运行时标记正则是 `/\{\{([A-Z0-9_]+)\}\}/g` —— **必须含数字**(`ART_LIT_B64` 带数字,原型里少写 `0-9` 直接漏替换)。包含标记正则是 `/\{\{>([a-z-]+\.(?:js|css|html))\}\}/g`。
- 所有 `String.prototype.replace` 用函数作第二参数(令牌里的 `$&` / `$'` 必须按字面进页面)。
- `apps/mobile/src/*.js` 是**经典脚本**,互相靠全局变量共享(`esc` / `api` / `toast` / `openMatter` …),文件间顺序即 `phone.html` 里的包含顺序,不许改成 ES module。
- `phone.html` 的第一个 `<script` 必须是裸 `<script>` 并位于 `var T =` 之前(`relay/pset.html:64` 用 `r.body.replace(/<script>/, …)` 往第一个脚本里注入 `window.__CC_SHELL__`)。
- 页面不许有外链脚本 / 样式表(壳模式下相对路径指向中继域,404)。
- 仍须满足 512KB 中继帧:`ceil(bytes(phoneHtml)*4/3)+4096 < 512*1024`(现有测试,随文件改名保留)。
- 标准回路四件全绿才能提交最终任务:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`。
- 部署(`wechat-cc self deploy`)会重启 daemon、断开桌面 app 连接 —— 只有 owner 点头才做。
- 提交信息结尾加:`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. **壳模式注入点**:有人给第一个 `<script>` 加属性(`type="module"`、`nonce=`)或在它之前插一段脚本 → 出门走中继时 `__CC_SHELL__` 注入不进去,手机外网打不开。→ Task 3 的同步测试钉住「第一个 `<script` 是裸的且在 `var T =` 之前」。
2. **恶意令牌**:令牌里带 `</script>`、`$&`、或长得像标记的 `{{ART_LIT_B64}}` → 必须原样(经 `\u003c` 转义)出现,不被当成替换模式、不被二次扫描。→ Task 1 金标用例 `phone-hostile.html` + Task 2 填充器单测。
3. **编辑器顺手改了源文件**(加行尾换行、格式化)或有人直接手改生成物 → 生成物与源码漂移,测试必须红并告诉人跑 `bun run build:mobile`。→ Task 3 同步测试(比的是整份文本,不是解析后的对象)。
4. **daemon 运行时读源码树**:有人图方便在 `src/daemon` 里 `readFileSync('apps/mobile/src/...')` 或 import `apps/mobile` → 本地好好的,编译后 sidecar 一上线就 404/崩。→ Task 5 depcheck 规则 + 负向验证。
5. **包含文件缺失 / 循环包含 / 拼错运行时键**(`{{TOKNE_JSON}}`)→ 必须在构建期响亮失败,而不是把字面 `{{…}}` 送上手机。→ Task 2 组装器单测。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `apps/mobile/src/phone.html` | `/m` 页面骨架(含两段内联 `<style>`),用 `{{>…}}` 串起下面各块;留 `{{TOKEN_JSON}}` `{{REMOTE_JSON}}` |
| `apps/mobile/src/presence.html` / `presence.css` / `presence.js` | 「此刻」首屏(原 `mobile-presence-view.ts`),留 `{{ART_UNLIT_B64}}` `{{ART_LIT_B64}}` |
| `apps/mobile/src/workbench.js` | 「一起做」任务交互(原 `mobile-workbench-client.ts`) |
| `apps/mobile/src/boot.js` | 令牌落盘、配对条、SW 注册、`toast`/`esc`/`q` |
| `apps/mobile/src/transport.js` | 直连优先、失败走端到端隧道的 `api()`(`/set` 也内联它) |
| `apps/mobile/src/nav.js` | 配对按钮、底栏切页、设置跳转 |
| `apps/mobile/src/home.js` | 回忆 feed、待办/画像/表情、首页轮询 |
| `apps/mobile/src/sw.js` | Service Worker,留 `{{BRAND_ICON_VERSION}}` |
| `apps/mobile/src/bootstrap.html` | 无令牌时的「正在找你的钥匙」页 |
| `apps/mobile/src/globals.d.ts` | 页面注入的全局:`T`、`REMOTE`、`window.__CC_SHELL__` |
| `apps/mobile/assemble.ts` | 纯函数:展开包含、校验运行时键、序列化 |
| `apps/mobile/sources.ts` | 读源码、生成物路径 |
| `apps/mobile/build.ts` | `bun run build:mobile` 入口 |
| `apps/mobile/tsconfig.json` | DOM lib + `checkJs` |
| `src/daemon/mobile-page.generated.json` | 生成物(提交进仓库) |
| `src/daemon/mobile-page-template.ts` | 运行时单趟填空 + `<script>` 内 JSON 转义 |
| `src/daemon/mobile-page.ts` | daemon 侧唯一入口:`mobilePhoneHtml` / `MOBILE_SW_JS` / … |
| `src/daemon/settings-panel-html.ts` | 瘦身:只剩 `/set` 页与过期页,手机页三件改为从 `mobile-page` 转出口 |

删除:`src/daemon/mobile-workbench-client.ts`、`src/daemon/mobile-presence-view.ts`。

---

### Task 1: 金标安全网

搬家前把现在服务出去的每一份文档钉成夹具。Task 2–4 全程靠它判「一个字节都没变」。

**Files:**
- Modify: `src/daemon/settings-panel-html.ts:381`(`const TUNNEL_CLIENT_JS` → `export const TUNNEL_CLIENT_JS`,Task 3 抽取脚本要用)
- Create: `src/daemon/mobile-golden.test.ts`
- Create: `src/daemon/__fixtures__/mobile-golden/{phone-remote.html,phone-lan.html,phone-hostile.html,set.html,sw.js,bootstrap.html}`(由测试生成)

**Interfaces:**
- Consumes: `phoneHtml(token, remote)`、`pageHtml(token)`、`SW_JS`、`M_BOOTSTRAP_HTML`(均来自 `./settings-panel-html`,Task 3 之后这些名字继续从这里导出)
- Produces: 环境变量 `WECHAT_CC_UPDATE_GOLDEN=1` 重写夹具;Task 4 用它

- [ ] **Step 0: 记下基线**

```bash
cd ~/Documents/tendhearth/wechat-cc-cc-kit
git status --short          # 必须干净
git pull --ff-only origin dev
bun run test 2>&1 | tail -30 > /tmp/mobile-move-baseline-bun.txt
npm run test:node 2>&1 | tail -30 > /tmp/mobile-move-baseline-node.txt
```

记下基线里已有的失败(2026-09-23 交接时有 `src/lib/state-migration.test.ts:114` 断言库版本 63 实际 65 的一条;若仍在,它与本计划无关,最终验收时按「与基线相同」判)。

- [ ] **Step 1: 导出传输层常量**

`src/daemon/settings-panel-html.ts` 第 381 行:

```ts
export const TUNNEL_CLIENT_JS = `
```

同文件第 8 行注释里 "stays private here" 改为 "exported only so the apps/mobile move can extract it verbatim"。

- [ ] **Step 2: 写金标测试**

`src/daemon/mobile-golden.test.ts`:

```ts
/**
 * 搬家金标(2026-09-24):把 /m 前端从 src/daemon 的字符串模板搬到 apps/mobile 期间,
 * 服务出去的字节必须一个不差。搬完(计划 Task 5)删掉本文件与夹具。
 * 重新生成:WECHAT_CC_UPDATE_GOLDEN=1 bun --bun vitest run src/daemon/mobile-golden.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { phoneHtml, pageHtml, SW_JS, M_BOOTSTRAP_HTML } from './settings-panel-html'
import art from './mobile-presence-art.json'

const DIR = new URL('./__fixtures__/mobile-golden/', import.meta.url)
const UPDATE = process.env.WECHAT_CC_UPDATE_GOLDEN === '1'
// 两张冻结图共 250KB,有自己的逐字节校验;金标里换回占位,夹具保持可读、可 diff。
const unart = (html: string) => html.split(art.unlit.base64).join('<ART_UNLIT>').split(art.lit.base64).join('<ART_LIT>')

const CASES: Record<string, () => string> = {
  'phone-remote.html': () => unart(phoneHtml('dTOKEN0123456789', { relay: 'wss://relay.example/tunnel/phone', id: 'dev-1' })),
  'phone-lan.html': () => unart(phoneHtml('tTOKEN', null)),
  'phone-hostile.html': () => unart(phoneHtml('</script><script>evil()$&$\'{{ART_LIT_B64}}', null)),
  'set.html': () => pageHtml('tTOKEN'),
  'sw.js': () => SW_JS,
  'bootstrap.html': () => M_BOOTSTRAP_HTML,
}

describe('mobile page golden (byte-identical during the apps/mobile move)', () => {
  for (const [name, render] of Object.entries(CASES)) {
    it(name, () => {
      const got = render()
      if (UPDATE) { mkdirSync(DIR, { recursive: true }); writeFileSync(new URL(name, DIR), got) }
      expect(got).toBe(readFileSync(new URL(name, DIR), 'utf8'))
    })
  }
})
```

- [ ] **Step 3: 跑,确认红**

Run: `bun --bun vitest run src/daemon/mobile-golden.test.ts`
Expected: 6 个 FAIL,`ENOENT ... __fixtures__/mobile-golden/phone-remote.html`

- [ ] **Step 4: 生成夹具,再跑确认绿**

```bash
WECHAT_CC_UPDATE_GOLDEN=1 bun --bun vitest run src/daemon/mobile-golden.test.ts
bun --bun vitest run src/daemon/mobile-golden.test.ts
npx vitest run -c vitest.node.config.ts src/daemon/mobile-golden.test.ts
grep -c '<ART_LIT>' src/daemon/__fixtures__/mobile-golden/phone-lan.html   # 1
grep -c 'u003c/script>' src/daemon/__fixtures__/mobile-golden/phone-hostile.html   # ≥1
```

Expected: 两个运行器都 6 passed;两条 grep 如注释。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/settings-panel-html.ts src/daemon/mobile-golden.test.ts src/daemon/__fixtures__/mobile-golden
git commit -m "手机页搬家金标:钉住 /m、/set、SW、引导页的现有字节

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 组装器与运行时填充器

**Files:**
- Create: `apps/mobile/assemble.ts`
- Create: `apps/mobile/assemble.test.ts`
- Create: `src/daemon/mobile-page-template.ts`
- Create: `src/daemon/mobile-page-template.test.ts`
- Modify: `vitest.node.config.ts:12`(node 运行器也收 `apps/mobile` 的测试)

**Interfaces:**
- Produces:
  - `RUNTIME_VARS: readonly ['TOKEN_JSON','REMOTE_JSON','ART_UNLIT_B64','ART_LIT_B64','BRAND_ICON_VERSION']`
  - `interface MobilePage { phone: string; sw: string; bootstrap: string; transport: string; scripts: { workbench: string; presence: string } }`
  - `assembleMobilePage(read: (name: string) => string): MobilePage`
  - `serializeMobilePage(page: MobilePage): string`
  - `fillMobileTemplate(template: string, vars: Readonly<Record<string, string>>): string`
  - `inlineScriptJson(value: unknown): string`

- [ ] **Step 1: 写组装器的失败测试**

`apps/mobile/assemble.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { assembleMobilePage, serializeMobilePage } from './assemble'

const BASE: Record<string, string> = {
  'phone.html': '<script>{{>a.js}}</script>', 'a.js': 'var x = {{TOKEN_JSON}}',
  'sw.js': 'sw', 'bootstrap.html': 'b', 'transport.js': 't', 'workbench.js': 'w', 'presence.js': 'p',
}
function files(over: Record<string, string> = {}) {
  const all = { ...BASE, ...over }
  return (name: string) => {
    const text = all[name]
    if (text === undefined) throw new Error(`no file ${name}`)
    return text
  }
}

describe('assembleMobilePage', () => {
  it('inlines includes verbatim and leaves runtime markers for the daemon', () => {
    const page = assembleMobilePage(files())
    expect(page.phone).toBe('<script>var x = {{TOKEN_JSON}}</script>')
    expect(page).toMatchObject({ sw: 'sw', bootstrap: 'b', transport: 't', scripts: { workbench: 'w', presence: 'p' } })
  })
  it('expands nested includes', () => {
    expect(assembleMobilePage(files({ 'phone.html': '{{>a.html}}', 'a.html': '[{{>b.css}}]', 'b.css': 'c' })).phone).toBe('[c]')
  })
  it('keeps $-replacement patterns literal', () => {
    const js = "s.replace(/x/, '$&$1$$$`')"
    expect(assembleMobilePage(files({ 'a.js': js })).phone).toBe(`<script>${js}</script>`)
  })
  it('accepts digits in runtime marker names', () => {
    expect(assembleMobilePage(files({ 'a.js': 'src="{{ART_LIT_B64}}"' })).phone).toContain('{{ART_LIT_B64}}')
  })
  it('refuses include cycles', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{>phone.html}}' }))).toThrow(/include cycle phone\.html → a\.js → phone\.html/)
  })
  it('refuses unknown runtime markers', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{TOKNE_JSON}}' }))).toThrow('unknown runtime marker {{TOKNE_JSON}}')
  })
  it('fails loudly on a missing include', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{>nope.js}}' }))).toThrow('no file nope.js')
  })
  it('serializes as stable pretty JSON with a trailing newline', () => {
    const page = assembleMobilePage(files())
    const text = serializeMobilePage(page)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(page)
    expect(serializeMobilePage(assembleMobilePage(files()))).toBe(text)
  })
})
```

- [ ] **Step 2: 让 node 运行器也收这些测试**

`vitest.node.config.ts` 第 12 行:

```ts
    include: ['src/**/*.test.ts', 'apps/mobile/**/*.test.ts'],
```

- [ ] **Step 3: 跑,确认红**

Run: `bun --bun vitest run apps/mobile/assemble.test.ts`
Expected: FAIL,`Failed to resolve import "./assemble"`

- [ ] **Step 4: 写组装器**

`apps/mobile/assemble.ts`:

```ts
/**
 * 把 apps/mobile/src 组装成 daemon 服务的整份文档。纯函数:不碰文件系统、不用 Bun API,
 * bun / node 两个测试运行器都能直接调。
 *
 * 两种标记:
 *   {{>file.js}}   构建期包含,原样内联(页面必须自包含:公网壳页 document.write 整份写入,没有可用的相对路径)
 *   {{UPPER_KEY}}  运行时键,留给 src/daemon/mobile-page.ts 按请求填;只认 RUNTIME_VARS 里的名字
 */
export const RUNTIME_VARS = ['TOKEN_JSON', 'REMOTE_JSON', 'ART_UNLIT_B64', 'ART_LIT_B64', 'BRAND_ICON_VERSION'] as const

export interface MobilePage {
  phone: string
  sw: string
  bootstrap: string
  transport: string
  scripts: { workbench: string; presence: string }
}

const INCLUDE = /\{\{>([a-z-]+\.(?:js|css|html))\}\}/g
// 键名里有数字(ART_LIT_B64):少了 0-9 会让冻结图原封不动地以 {{…}} 送上手机。
const RUNTIME = /\{\{([A-Z0-9_]+)\}\}/g

function expand(name: string, read: (name: string) => string, stack: string[]): string {
  if (stack.includes(name)) throw new Error(`mobile page: include cycle ${[...stack, name].join(' → ')}`)
  return read(name).replace(INCLUDE, (_m, file: string) => expand(file, read, [...stack, name]))
}

export function assembleMobilePage(read: (name: string) => string): MobilePage {
  const page: MobilePage = {
    phone: expand('phone.html', read, []),
    sw: expand('sw.js', read, []),
    bootstrap: expand('bootstrap.html', read, []),
    transport: expand('transport.js', read, []),
    scripts: { workbench: expand('workbench.js', read, []), presence: expand('presence.js', read, []) },
  }
  for (const text of [page.phone, page.sw, page.bootstrap, page.transport, page.scripts.workbench, page.scripts.presence]) {
    for (const m of text.matchAll(RUNTIME)) {
      if (!(RUNTIME_VARS as readonly string[]).includes(m[1]!)) throw new Error(`mobile page: unknown runtime marker {{${m[1]}}}`)
    }
  }
  return page
}

export function serializeMobilePage(page: MobilePage): string {
  return JSON.stringify(page, null, 2) + '\n'
}
```

- [ ] **Step 5: 跑,确认绿**

Run: `bun --bun vitest run apps/mobile/assemble.test.ts && npx vitest run -c vitest.node.config.ts apps/mobile/assemble.test.ts`
Expected: 两次都 8 passed

- [ ] **Step 6: 写填充器的失败测试**

`src/daemon/mobile-page-template.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

describe('fillMobileTemplate', () => {
  it('fills every runtime key', () => {
    expect(fillMobileTemplate('a{{TOKEN_JSON}}b{{ART_LIT_B64}}', { TOKEN_JSON: '"x"', ART_LIT_B64: 'QQ==' })).toBe('a"x"bQQ==')
  })
  it('is single-pass: a value that looks like a marker is not rescanned', () => {
    expect(fillMobileTemplate('{{TOKEN_JSON}}|{{ART_LIT_B64}}', { TOKEN_JSON: '{{ART_LIT_B64}}', ART_LIT_B64: 'IMG' })).toBe('{{ART_LIT_B64}}|IMG')
  })
  it('inserts $-patterns literally', () => {
    expect(fillMobileTemplate('[{{TOKEN_JSON}}]', { TOKEN_JSON: "$&$'$`$$" })).toBe("[$&$'$`$$]")
  })
  it('throws on a key with no value instead of shipping {{…}} to the phone', () => {
    expect(() => fillMobileTemplate('{{REMOTE_JSON}}', {})).toThrow('mobile page template: no value for {{REMOTE_JSON}}')
  })
})

describe('inlineScriptJson', () => {
  it('cannot close the surrounding <script>', () => {
    expect(inlineScriptJson('</script>')).toBe('"\\u003c/script>"')
  })
  it('encodes null and objects like JSON.stringify', () => {
    expect(inlineScriptJson(null)).toBe('null')
    expect(inlineScriptJson({ relay: 'wss://r', id: 'd' })).toBe('{"relay":"wss://r","id":"d"}')
  })
})
```

- [ ] **Step 7: 跑,确认红**

Run: `bun --bun vitest run src/daemon/mobile-page-template.test.ts`
Expected: FAIL,`Failed to resolve import "./mobile-page-template"`

- [ ] **Step 8: 写填充器**

`src/daemon/mobile-page-template.ts`:

```ts
/**
 * 手机页模板的运行时填充。生成物里只剩 {{大写键}},daemon 按请求填。
 * 单趟替换 + 函数替换:填进去的值(令牌)即便长得像标记或带 `$&`,也按字面进页面。
 */
const RUNTIME = /\{\{([A-Z0-9_]+)\}\}/g

export function fillMobileTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(RUNTIME, (_m, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`mobile page template: no value for {{${key}}}`)
    return value
  })
}

/** 塞进 <script> 的 JSON:挡住 `</script>` 提前闭合。与旧 phoneHtml 的写法逐字节一致。 */
export function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
```

- [ ] **Step 9: 跑,确认绿,提交**

```bash
bun --bun vitest run src/daemon/mobile-page-template.test.ts apps/mobile/assemble.test.ts
npx vitest run -c vitest.node.config.ts src/daemon/mobile-page-template.test.ts apps/mobile/assemble.test.ts
bun run typecheck
git add apps/mobile/assemble.ts apps/mobile/assemble.test.ts src/daemon/mobile-page-template.ts src/daemon/mobile-page-template.test.ts vitest.node.config.ts
git commit -m "手机页组装器与运行时填充器(还没接线)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: 14 passed ×2;typecheck 0 error。

---

### Task 3: 搬家 —— 抽源码、生成、接线、删旧

**Files:**
- Create(一次性脚本,不提交): `scripts/extract-mobile-once.ts`
- Create: `apps/mobile/src/{phone.html,presence.html,presence.css,presence.js,workbench.js,boot.js,transport.js,nav.js,home.js,sw.js,bootstrap.html}`(由脚本生成)
- Create: `apps/mobile/sources.ts`、`apps/mobile/build.ts`、`apps/mobile/build.test.ts`
- Create: `src/daemon/mobile-page.generated.json`(由 `build:mobile` 生成)、`src/daemon/mobile-page.ts`
- Modify: `src/daemon/settings-panel-html.ts`(删 346–776 行的手机页四件,改为转出口)、`package.json`(加 `build:mobile`)
- Delete: `src/daemon/mobile-workbench-client.ts`、`src/daemon/mobile-presence-view.ts`
- Rename + Modify: `src/daemon/mobile-workbench-client.test.ts` → `src/daemon/mobile-page-workbench.test.ts`;`src/daemon/mobile-presence-view.test.ts` → `src/daemon/mobile-page-presence.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `assembleMobilePage` / `serializeMobilePage` / `fillMobileTemplate` / `inlineScriptJson`;Task 1 导出的 `TUNNEL_CLIENT_JS`
- Produces(`src/daemon/mobile-page.ts`):
  - `mobilePhoneHtml(token: string, remote: { relay: string; id: string } | null): string`
  - `MOBILE_SW_JS: string`、`MOBILE_BOOTSTRAP_HTML: string`、`TUNNEL_CLIENT_JS: string`、`MOBILE_WORKBENCH_JS: string`、`MOBILE_PRESENCE_JS: string`
- Produces(`apps/mobile/sources.ts`):`readMobileSource(name: string): string`、`MOBILE_PAGE_OUT: URL`
- `settings-panel-html.ts` 对外名字不变:`phoneHtml`、`SW_JS`、`M_BOOTSTRAP_HTML`、`pageHtml`、`EXPIRED_HTML`、`safeSvgFile`(`settings-panel.ts`、e2e、SW 测试不用改)

- [ ] **Step 1: 写一次性抽取脚本**

`scripts/extract-mobile-once.ts`(2026-09-24 已在 dev `5007c9f8` 上原型跑通:每条缝都恰好出现一次,组装回填后三种令牌逐字节相等):

```ts
/** 一次性:从现有字符串模板里把手机页原样抽成 apps/mobile/src 下的文件。跑完即删,不提交。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { phoneHtml, SW_JS, M_BOOTSTRAP_HTML, TUNNEL_CLIENT_JS } from '../src/daemon/settings-panel-html'
import { MOBILE_WORKBENCH_JS } from '../src/daemon/mobile-workbench-client'
import { MOBILE_PRESENCE_HTML, MOBILE_PRESENCE_CSS, MOBILE_PRESENCE_JS } from '../src/daemon/mobile-presence-view'
import art from '../src/daemon/mobile-presence-art.json'
import { MOBILE_BRAND_ICON_VERSION } from '../src/daemon/mobile-brand-icon'

const OUT = 'apps/mobile/src'
function once(hay: string, needle: string, marker: string): string {
  const i = hay.indexOf(needle)
  if (i < 0 || hay.indexOf(needle, i + 1) >= 0) throw new Error(`not exactly one occurrence of ${JSON.stringify(needle.slice(0, 40))}`)
  return hay.slice(0, i) + marker + hay.slice(i + needle.length)
}
function between(hay: string, start: string, end: string): string {
  const i = hay.indexOf(start), j = hay.indexOf(end, i + start.length)
  if (i < 0 || j < 0) throw new Error(`seam missing: ${start} … ${end}`)
  return hay.slice(i + start.length, j)
}
if (/\{\{[A-Za-z_>]/.test(phoneHtml('__X__', null) + SW_JS + M_BOOTSTRAP_HTML)) throw new Error('sources already contain {{ — pick another marker syntax')

const files: Record<string, string> = {
  'transport.js': TUNNEL_CLIENT_JS,
  'workbench.js': MOBILE_WORKBENCH_JS,
  'presence.js': MOBILE_PRESENCE_JS,
  'presence.css': MOBILE_PRESENCE_CSS,
  'presence.html': once(once(MOBILE_PRESENCE_HTML, art.unlit.base64, '{{ART_UNLIT_B64}}'), art.lit.base64, '{{ART_LIT_B64}}'),
  'sw.js': once(SW_JS, MOBILE_BRAND_ICON_VERSION, '{{BRAND_ICON_VERSION}}'),
  'bootstrap.html': M_BOOTSTRAP_HTML,
}
let phone = phoneHtml('__X__', null)
phone = once(phone, 'var T = "__X__"', 'var T = {{TOKEN_JSON}}')
phone = once(phone, 'var REMOTE = null', 'var REMOTE = {{REMOTE_JSON}}')
phone = once(phone, TUNNEL_CLIENT_JS, '{{>transport.js}}')
phone = once(phone, MOBILE_WORKBENCH_JS, '{{>workbench.js}}')
phone = once(phone, MOBILE_PRESENCE_JS, '{{>presence.js}}')
phone = once(phone, MOBILE_PRESENCE_CSS, '{{>presence.css}}')
phone = once(phone, MOBILE_PRESENCE_HTML, '{{>presence.html}}')
// 包含点之间的三段胶水脚本也各自成文件,顺序由 phone.html 决定(经典脚本,共享全局)。
files['boot.js'] = between(phone, 'var REMOTE = {{REMOTE_JSON}}', '{{>transport.js}}')
phone = once(phone, files['boot.js'], '{{>boot.js}}')
files['nav.js'] = between(phone, '{{>transport.js}}', '{{>workbench.js}}')
phone = once(phone, files['nav.js'], '{{>nav.js}}')
files['home.js'] = between(phone, '{{>presence.js}}', '</script></body></html>')
phone = once(phone, files['home.js'], '{{>home.js}}')
files['phone.html'] = phone

mkdirSync(OUT, { recursive: true })
for (const [name, text] of Object.entries(files)) writeFileSync(`${OUT}/${name}`, text)
console.log(Object.keys(files).sort().join(' '))
```

- [ ] **Step 2: 跑抽取,删脚本**

```bash
bun scripts/extract-mobile-once.ts
rm scripts/extract-mobile-once.ts
ls apps/mobile/src
grep -n '{{' apps/mobile/src/phone.html
```

Expected: 打印 11 个文件名;`phone.html` 里看到 `var T = {{TOKEN_JSON}}`、`var REMOTE = {{REMOTE_JSON}}{{>boot.js}}` 以及 `{{>transport.js}}{{>nav.js}}{{>workbench.js}}{{>presence.js}}{{>home.js}}`、`{{>presence.html}}`、`{{>presence.css}}`。**不要用编辑器打开再保存这些文件**(会被加行尾换行);要看用 `cat`/`less`。

- [ ] **Step 3: 写同步测试(红)**

`apps/mobile/build.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT } from './sources'

describe('apps/mobile → src/daemon/mobile-page.generated.json', () => {
  const page = assembleMobilePage(readMobileSource)

  it('generated page is in sync with apps/mobile/src (fix: bun run build:mobile)', () => {
    // 比整份文本:手改生成物、或源文件被编辑器动过,都会在这里红。
    expect(readFileSync(MOBILE_PAGE_OUT, 'utf8')).toBe(serializeMobilePage(page))
  })

  it('first <script> is bare and defines T — relay/pset.html injects __CC_SHELL__ into it', () => {
    const i = page.phone.indexOf('<script')
    expect(page.phone.slice(i, i + 8)).toBe('<script>')
    expect(page.phone.indexOf('var T = {{TOKEN_JSON}}')).toBeGreaterThan(i)
  })

  it('pulls in no external script or stylesheet — the shell page has no usable origin', () => {
    expect(page.phone).not.toMatch(/<script[^>]*\ssrc=/)
    expect(page.phone).not.toMatch(/<link[^>]*rel="stylesheet"/)
  })
})
```

`apps/mobile/sources.ts`:

```ts
import { readFileSync } from 'node:fs'

export const MOBILE_SRC = new URL('./src/', import.meta.url)
/** daemon 吃的生成物;与 mobile-presence-art.json 同理 —— 编译后的 sidecar 没有源码树。 */
export const MOBILE_PAGE_OUT = new URL('../../src/daemon/mobile-page.generated.json', import.meta.url)

export function readMobileSource(name: string): string {
  return readFileSync(new URL(name, MOBILE_SRC), 'utf8')
}
```

Run: `bun --bun vitest run apps/mobile/build.test.ts`
Expected: 第一条 FAIL,`ENOENT ... mobile-page.generated.json`;后两条 PASS。

- [ ] **Step 4: 构建入口 + 生成**

`apps/mobile/build.ts`:

```ts
/** bun run build:mobile —— 把 apps/mobile/src 组装成 daemon 吃的生成物。改完手机页源码必跑;apps/mobile/build.test.ts 盯着。 */
import { writeFileSync } from 'node:fs'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT } from './sources'

writeFileSync(MOBILE_PAGE_OUT, serializeMobilePage(assembleMobilePage(readMobileSource)))
console.log(`wrote ${MOBILE_PAGE_OUT.pathname}`)
```

`package.json` 的 `scripts` 里、`typecheck` 前加一行:

```json
    "build:mobile": "bun apps/mobile/build.ts",
```

```bash
bun run build:mobile
bun --bun vitest run apps/mobile/build.test.ts
```

Expected: `wrote …/src/daemon/mobile-page.generated.json`;3 passed。

- [ ] **Step 5: daemon 侧入口**

`src/daemon/mobile-page.ts`:

```ts
/**
 * 手机页(/m)的 daemon 侧:只吃 apps/mobile 的生成物,按请求填运行时键。
 * 源码在 apps/mobile/src,改完跑 `bun run build:mobile`。这里不许 import apps/mobile(depcheck 管)——
 * 编译后的 sidecar 没有源码树,生成物与冻结图一样随 JSON 编进二进制。
 */
import page from './mobile-page.generated.json'
import art from './mobile-presence-art.json'
import { MOBILE_BRAND_ICON_VERSION } from './mobile-brand-icon'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

/** 随身 CC 手机页 —— 此刻 / 一起做 / 回忆,自包含无 CDN,PWA 可加主屏。 */
export function mobilePhoneHtml(token: string, remote: { relay: string; id: string } | null): string {
  return fillMobileTemplate(page.phone, {
    TOKEN_JSON: inlineScriptJson(token),
    REMOTE_JSON: inlineScriptJson(remote),
    ART_UNLIT_B64: art.unlit.base64,
    ART_LIT_B64: art.lit.base64,
  })
}

// 下面几份不带运行时键;照样过一遍 fill,将来有人加了键却忘了给值,模块加载时就炸,不会把 {{…}} 送上手机。
export const MOBILE_SW_JS = fillMobileTemplate(page.sw, { BRAND_ICON_VERSION: MOBILE_BRAND_ICON_VERSION })
export const MOBILE_BOOTSTRAP_HTML = fillMobileTemplate(page.bootstrap, {})
/** /set 与 /m 共用的传输层:同 Wi-Fi 直连,失败走端到端加密隧道。 */
export const TUNNEL_CLIENT_JS = fillMobileTemplate(page.transport, {})
export const MOBILE_WORKBENCH_JS = fillMobileTemplate(page.scripts.workbench, {})
export const MOBILE_PRESENCE_JS = fillMobileTemplate(page.scripts.presence, {})
```

- [ ] **Step 6: 瘦身 settings-panel-html.ts**

1. 删掉第 12–14 行三条 import(`MOBILE_BRAND_ICON_VERSION`、`MOBILE_WORKBENCH_JS`、`MOBILE_PRESENCE_*`)。
2. 删掉从 `export const SW_JS = \`` 到文件末尾(原 346–776 行:`SW_JS`、`M_BOOTSTRAP_HTML`、`TUNNEL_CLIENT_JS`、`phoneHtml`)。
3. 在剩下的 import 后加:

```ts
import { TUNNEL_CLIENT_JS } from './mobile-page'

// 手机页三件现在由 apps/mobile 生成;这里保留旧名字转出口,settings-panel.ts 与测试不用改。
export { mobilePhoneHtml as phoneHtml, MOBILE_SW_JS as SW_JS, MOBILE_BOOTSTRAP_HTML as M_BOOTSTRAP_HTML } from './mobile-page'
```

4. 文件头注释改成:

```ts
/**
 * settings-panel-html.ts — /set 设置页与过期页的文档(纯字符串构造)。
 *
 * 手机页 /m(phoneHtml / SW_JS / M_BOOTSTRAP_HTML)和两页共用的传输层源码已搬到
 * apps/mobile/src(2026-09-24),经 ./mobile-page 读生成物;这里只转出口旧名字。
 */
```

- [ ] **Step 7: 删旧模块,改测试引用**

```bash
git rm src/daemon/mobile-workbench-client.ts src/daemon/mobile-presence-view.ts
git mv src/daemon/mobile-workbench-client.test.ts src/daemon/mobile-page-workbench.test.ts
git mv src/daemon/mobile-presence-view.test.ts src/daemon/mobile-page-presence.test.ts
```

- `src/daemon/mobile-page-workbench.test.ts`:`import { MOBILE_WORKBENCH_JS } from './mobile-workbench-client'` → `import { MOBILE_WORKBENCH_JS } from './mobile-page'`
- `src/daemon/mobile-page-presence.test.ts`:`import {MOBILE_PRESENCE_JS} from './mobile-presence-view'` → `import {MOBILE_PRESENCE_JS} from './mobile-page'`

```bash
git grep -n "mobile-workbench-client\|mobile-presence-view" -- src apps scripts
```

Expected: 无输出(docs 里的旧名字 Task 5 改)。

- [ ] **Step 8: 金标与全部手机相关测试**

```bash
bun --bun vitest run src/daemon/mobile-golden.test.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel
npx vitest run -c vitest.node.config.ts src/daemon/mobile-golden.test.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel
bun --bun vitest run -c vitest.e2e.config.ts src/daemon/__e2e__/mobile-workbench.e2e.test.ts
bun run typecheck
```

Expected: 金标 6 passed(**一个字节没变**);其余全绿;typecheck 0 error。金标红 = 抽取或接线出错,**不许**用 `WECHAT_CC_UPDATE_GOLDEN=1` 糊过去,回去查。

- [ ] **Step 9: 提交**

```bash
git add apps/mobile src/daemon package.json
git commit -m "手机页前端搬到 apps/mobile:真文件 + 构建期组装,daemon 只吃生成物(字节不变)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 手机页 JS 上类型检查

**Files:**
- Create: `apps/mobile/tsconfig.json`、`apps/mobile/src/globals.d.ts`
- Modify: `tsconfig.json`(exclude `apps/mobile/src/**`)、`package.json`(`typecheck` 连跑两个工程)
- Modify: `apps/mobile/src/{home,nav,presence,workbench}.js`(只插 JSDoc 类型转换)
- Modify: `src/daemon/mobile-page.generated.json`(重新生成)、`src/daemon/__fixtures__/mobile-golden/phone-*.html`(重新生成,审 diff)

**Interfaces:**
- Consumes: Task 3 的 `apps/mobile/src/*.js`
- Produces: `bun run typecheck` 同时覆盖手机页 JS;`sw.js` 不在检查范围(Service Worker 全局与 DOM lib 冲突,20 行,另立)

- [ ] **Step 1: 建类型工程**

`apps/mobile/tsconfig.json`:

```jsonc
{
  // 手机页经典脚本的类型检查(不产出任何东西,页面仍按字节内联)。
  // strict 暂关:开了是 356 条(大多是隐式 any / 可能为 null),另立一步收紧。
  // sw.js 不进来:Service Worker 的全局(self.skipWaiting / FetchEvent)和 DOM lib 互斥。
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/*.js", "src/globals.d.ts"],
  "exclude": ["src/sw.js"]
}
```

`apps/mobile/src/globals.d.ts`:

```ts
/** phone.html 首个 <script> 里由 daemon 填的两个全局,和公网壳页(relay/pset.html)注入的 __CC_SHELL__。 */
declare var T: string
declare var REMOTE: { relay: string; id: string } | null
interface Window { __CC_SHELL__?: { relay: string; id: string } }
```

根 `tsconfig.json` 的 `exclude` 数组末尾加 `"apps/mobile/src/**"`(否则 `globals.d.ts` 的 `T` / `REMOTE` 会漏进整个仓库的全局)。

`package.json`:

```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p apps/mobile",
```

- [ ] **Step 2: 跑,确认红**

Run: `bun x tsc --noEmit -p apps/mobile | grep -c 'error TS'`
Expected: `33` 上下(2026-09-24 原型:home.js 3、nav.js 1、presence.js 1、workbench.js 28;全是 TS2339 —— `getElementById` 回来的是 `HTMLElement` 没有 `.value`,`ev.target` 是 `EventTarget` 没有 `.closest`,`querySelector` 回来的 `Element` 没有 `.dataset`/`.disabled`/`.src`/`.click`)。数目差很多先停下查,可能是抽取不对。

- [ ] **Step 3: 逐条插 JSDoc 类型转换**

只插转换,**不改逻辑**。JSDoc 转换必须带括号。四种写法覆盖全部报错:

```js
// .value:输入框 / 文本域
/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value
// .closest:事件目标
/** @type {Element} */ (ev.target).closest("button[data-id]")
// .dataset / .disabled / .click:querySelector(All) 取回的按钮
/** @type {HTMLButtonElement} */ (document.querySelector('nav button[data-p="'+name+'"]'))
// .src:图片
/** @type {HTMLImageElement} */ (sg.querySelector('[data-sti="' + i + '"]'))
```

若同一个变量被多处用到(例如 `var b = ev.target.closest(...)` 后面用 `b.dataset`),在声明处转一次即可:`var b = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (ev.target).closest("button[data-id]"))`。`workbench.js` 第 166/168 行直接对 `ev.target` 取 `.dataset`/`.value`,转成 `/** @type {HTMLInputElement} */ (ev.target)`。

Run: `bun x tsc --noEmit -p apps/mobile`
Expected: 0 error

- [ ] **Step 4: 重新生成,审金标 diff**

```bash
bun run build:mobile
WECHAT_CC_UPDATE_GOLDEN=1 bun --bun vitest run src/daemon/mobile-golden.test.ts
git diff --stat src/daemon/__fixtures__/mobile-golden
git diff --word-diff=color src/daemon/__fixtures__/mobile-golden/phone-lan.html
```

Expected: 只有 `phone-*.html` 三份有变化,`set.html`、`sw.js`、`bootstrap.html` 不动。逐处看 `phone-lan.html` 的 word-diff:**只许出现插入**,且插入的只有 `/** @type {…} */ (` 和与之配对的 `)`;任何删除(红色)或别的插入 = 顺手改了逻辑,撤回。另两份 `phone-*.html` 的 diff 与它相同(同一份模板),`git diff --stat` 行数一致即可。

- [ ] **Step 5: 全绿后提交**

```bash
bun --bun vitest run src/daemon/mobile-golden.test.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel
npx vitest run -c vitest.node.config.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel
bun run typecheck
git add tsconfig.json package.json apps/mobile src/daemon/mobile-page.generated.json src/daemon/__fixtures__/mobile-golden
git commit -m "手机页 JS 上 checkJs:DOM 类型转换 33 处,逻辑不动(sw.js 与 strict 另立)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 边界规则、文档、退役金标、整套回路

**Files:**
- Modify: `.dependency-cruiser.cjs`(加两条规则)、`package.json`(`depcheck` 扫 `apps/mobile`)
- Create: `apps/mobile/README.md`
- Modify: `docs/maintainer/mobile-presence.md`、`docs/INDEX.md:34`、`docs/全景导图.md`(再生成 `docs/全景导图.html`)
- Delete: `src/daemon/mobile-golden.test.ts`、`src/daemon/__fixtures__/mobile-golden/`

**Interfaces:**
- Consumes: 前四个任务的全部产物
- Produces: `bun run depcheck` 守住「daemon 不 import apps/mobile、apps/mobile 不 import src」

- [ ] **Step 1: 加 depcheck 规则**

`.dependency-cruiser.cjs` 的 `forbidden` 数组里、`cli-must-not-depend-on-daemon` 之后加:

```js
    {
      name: 'mobile-page-talks-http-only',
      severity: 'error',
      comment: '手机页(apps/mobile)只通过 /m/api/* 跟 daemon 说话,源码与构建脚本不链接 src/(2026-09-24)。',
      from: { path: '^apps/mobile/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/' },
    },
    {
      name: 'daemon-reads-mobile-only-via-generated',
      severity: 'error',
      comment: 'daemon 只吃 src/daemon/mobile-page.generated.json;import apps/mobile 在本地能跑,编译后的 sidecar 没有源码树就挂了。',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/mobile/' },
    },
```

`package.json`:

```json
    "depcheck": "depcruise --config .dependency-cruiser.cjs src cli.ts setup.ts docs.ts log-viewer.ts apps/mobile"
```

- [ ] **Step 2: 负向验证两条规则真的会红**

```bash
echo "import '../../src/lib/log'" >> apps/mobile/build.ts
bun run depcheck 2>&1 | grep -c mobile-page-talks-http-only      # ≥1
git checkout apps/mobile/build.ts
echo "import '../../apps/mobile/assemble'" >> src/daemon/mobile-page.ts
bun run depcheck 2>&1 | grep -c daemon-reads-mobile-only-via-generated   # ≥1
git checkout src/daemon/mobile-page.ts
bun run depcheck   # 0 error(既有 7 条循环依赖 warning 不算)
```

- [ ] **Step 3: 退役金标**

搬家完成,以后改页面是正常改动,不该每次去重写夹具;防漂移由 `apps/mobile/build.test.ts` 接班。

```bash
git rm -r src/daemon/mobile-golden.test.ts src/daemon/__fixtures__/mobile-golden
```

`src/daemon/settings-panel-html.ts` 已不再定义 `TUNNEL_CLIENT_JS`(Task 3 起从 `./mobile-page` import),无需回滚 Task 1 的导出。

- [ ] **Step 4: apps/mobile/README.md**

```markdown
# apps/mobile —— 随身 CC 手机页(/m)

daemon 在 `/m` 服务的 PWA。源码在 `src/`,构建期组装成 `src/daemon/mobile-page.generated.json`(提交进仓库),daemon 只读这份生成物。

## 改页面

1. 改 `src/` 下的文件。
2. `bun run build:mobile`
3. `bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel`

忘了第 2 步,`apps/mobile/build.test.ts` 会红。

## 规矩(都有测试或 depcheck 盯着)

- **整份内联。** 公网壳页 `relay/pset.html` 通过隧道取到页面后 `document.write` 整份写入,没有可用的相对路径 —— 不许外链脚本 / 样式表。
- **第一个 `<script>` 保持裸标签并定义 `T`。** 壳页往第一个 `<script>` 里注入 `window.__CC_SHELL__`。
- **经典脚本,不是 ES module。** `boot.js` → `transport.js` → `nav.js` → `workbench.js` → `presence.js` → `home.js` 按 `phone.html` 的包含顺序共享全局(`esc`、`api`、`toast`、`openMatter`…)。
- **两种标记。** `{{>file}}` 构建期包含;`{{UPPER_KEY}}` 运行时键,只认 `assemble.ts` 的 `RUNTIME_VARS`,由 `src/daemon/mobile-page.ts` 单趟填。
- **只走 HTTP。** 本目录不 import `src/`,daemon 不 import 本目录(depcheck)。
- **512KB。** 整页 base64 后加信封要塞进中继一帧(`src/daemon/mobile-page-presence.test.ts`)。

## 类型

`tsconfig.json`:DOM lib + `checkJs`,`strict` 暂关;`sw.js` 不在检查范围。DOM 取回的元素用 JSDoc 转换:`/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value`。

## 不在这里的

`/set` 设置页(`src/daemon/settings-panel-html.ts` 的 `pageHtml`)还在 daemon 里,只是内联了这里的 `transport.js`。
```

- [ ] **Step 5: 更新文档**

- `docs/maintainer/mobile-presence.md` 第 24 行 `` `mobile-presence-view`、`mobile-workbench-client` `` 改为 `` `mobile-page-presence`、`mobile-page-workbench` ``;文件开头第一段后加一段:

```markdown
> 2026-09-24 起页面源码在 [`apps/mobile/src`](../../apps/mobile/README.md),改完跑 `bun run build:mobile`;daemon 只读生成物 `src/daemon/mobile-page.generated.json`。
```

- `docs/INDEX.md` 第 34 行「手机版」那行的第二列加上 `[手机页源码与规矩](../apps/mobile/README.md)`。
- `docs/全景导图.md` 第 21 行(台阶 C 那条)之后加一条:

```markdown
- 做 **手机前端独立成 `apps/mobile`(同仓库)** [定] · 不做 **拆仓库 / 拆发版** ⟨2026-09-24:手机页没有自己的后端,`/m/api/*` 契约跟 daemon 同步演进,拆仓库等于给一个人维护的项目加跨仓库版本对账。要拆的是代码位置:页面曾是 daemon 里无类型的字符串模板。生成物进仓库、daemon 不 import 源码树(编译后的 sidecar 没有它);台阶 B 的 Tauri 手机壳到时加在 `apps/mobile/src-tauri`⟩
```

```bash
bun scripts/build-map.ts     # 全景导图.html 是生成物,永不手改
```

- [ ] **Step 6: 整套回路**

```bash
bun run test
npm run test:node
bun run typecheck
bun run depcheck
```

Expected: typecheck 0、depcheck 0 error;两套测试的失败集合与 Task 1 Step 0 的基线**完全相同**(对比 `/tmp/mobile-move-baseline-*.txt`),多出任何一条都要查。

- [ ] **Step 7: 提交**

```bash
git add -A .dependency-cruiser.cjs package.json apps/mobile docs src/daemon
git status --short    # 确认没有意外文件
git commit -m "手机页边界:depcheck 两条规则 + 文档 + 退役搬家金标

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: 部署与真机(owner 点头才做)**

部署会重启 daemon、断开桌面 app。先问 owner,同意后:

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy
```

然后用真手机:在家 Wi-Fi 打开 `/m`(直连)→ 切流量从微信里的链接打开(壳模式走隧道)→ 三个 tab 各点一下、打开一件任务。两条路都能出页面、「此刻」有熊、「一起做」能列任务,才算完。结果记进 `docs/maintainer/mobile-presence.md` 的交接验证段。
