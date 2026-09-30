# Tendhearth app 骨架 + 演示模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/app` 建起 Tendhearth 的 Expo 工程,按 Codex 的四个画面(此刻 / 进展 / 批准 / 交办)做出界面,全部跑在内置的**演示后端**上 —— 不联网就能把整个 app 走一遍(也是给苹果审核用的演示模式)。真连接与配对是下一份计划。

**Architecture:** 界面只认一个 `Backend` 接口(`src/backend/types.ts`);这一份计划只实现 `DemoBackend`,下一份计划加 `LiveBackend`(协议包 + 隧道)。界面逻辑尽量放进**纯函数视图模型**(`src/view/*.ts`,vitest 测),组件只负责摆放。数据形状一律来自 `@wechat-cc/protocol` 的 zod schema(`z.infer`),本计划先把四个订阅主题的形状补进协议包。

**Tech Stack:** Expo SDK 57、Expo Router、React Native 0.87、TypeScript strict、`@wechat-cc/protocol`、vitest(纯逻辑)、Maestro(模拟器上的演示流程)。

**Spec:** `docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`(§2 界面、§3 状态约定、§4 架构、§8 演示模式);视觉稿 `docs/design/tendhearth-app-v1/`(`screenshots/`、`tendhearth-phone.html`、`design-notes.html`)。

## Global Constraints

- 分支 `app-skeleton`(从 `origin/dev`),PR 进 `dev`;不碰兄弟工作树;不用 `git stash`。
- 视觉以 Codex 稿为准:浅色底 `#faf8f3`、卡片 `#fffdf9`、正文 `#493e32`、辅助 `#796f63`、边线 `#e4ddd2`、主按钮 `#58654c`、导航选中底 `#f7ead2` / 字 `#674c2d`;深色底 `#221f1b`、卡片 `#2c2823`、文字 `#f1e9dc`、主按钮 `#b9c5a5`(深色时按钮字用深色)。明暗只是外观,不表示在线离线。
- CC 形象只用已验收素材 `apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png`(浅色用 lit、深色用 unlit),不重画。
- 导航:底部两个标签「此刻 / 一起做」;右上角头像进设置;右上角同时显示「家里的电脑」状态点;输入入口随处可见。
- 状态词只用:正在整理 / 等你决定 / 这一轮已回复 / 事情完成 / 没做成 / 已停下(英文:Working on it / Waiting for you / Replied this round / Done / Didn't finish / Stopped)。不显示百分比。
- **批准页硬要求**(来自后端计划的终审):说明来自模型(`source === 'model'`)时,原始命令的第一行与工作目录**不折叠、直接可见**;完整原始命令在「查看具体操作」里;提交中锁定按钮;以返回结果为准,不做乐观成功;超时 ⇒ 当「不确定」,重新拉详情。
- 进展页:状态标签在「CC 的进展」概括**之上**。
- 语言:`en` 与 `zh-Hans`,跟随系统,可在设置里改;所有面向用户的字符串进文案表,两份键一致(有测试)。
- 隐私页文案要说明:查看待批准说明时,命令文本会发给电脑上配置的便宜模型服务商。
- 系统「减少动态效果」时关掉 CC 动作;所有状态都有文字。
- 本工程**不进**根 `tsconfig.json` / 根 `vitest.config.ts` / `depcheck`(RN 类型与 bun 类型冲突);它有自己的 `tsconfig.json` 与 `vitest.config.ts`,根 `package.json` 的 `typecheck` 追加 `tsc --noEmit -p apps/app`。
- 纯逻辑测试用 vitest(node 环境,不渲染 RN 组件);组件与流程靠 typecheck + `expo export` 编译检查 + Maestro 演示流程。
- zod v4:`import z from 'zod'`。
- 类型检查看退出码,别 grep。

## Review Focus

1. **批准页在模型说明「说得轻巧」时**:原始命令首行与目录必须在首屏可见,不能只藏在折叠里(Task 4 视图模型测试钉住)。
2. **同一件事有两条待批准**:从「此刻」点进来要让用户选,不能默默只显示第一条(Task 4 测试)。
3. **快速连点「允许」**:只提交一次(Task 6 存储 / Task 9 视图模型测试)。
4. **演示模式里批准之后**:进展、此刻、一起做三处同时更新成「正在整理」,再过一会儿「这一轮已回复」(Task 5 测试)。
5. **系统语言既不是中文也不是英文**(比如法语):落到英文,不崩(Task 3 测试)。

---

## File Structure

```
packages/protocol/src/topics.ts            订阅主题的 zod 形状(home / approvals / agents / matter/<id>)
apps/app/
  package.json  app.json  tsconfig.json  vitest.config.ts  metro.config.js(若需要)  babel.config.js(若模板带)
  app/                                     Expo Router 路由
    _layout.tsx                            根:主题、语言、BackendProvider、首次打开跳转
    welcome.tsx                            首次打开:配对 / 先看看
    (tabs)/_layout.tsx                     底部两标签
    (tabs)/index.tsx                       01 此刻
    (tabs)/together.tsx                    一起做(事项列表)
    matter/[id].tsx                        03 进展
    approval/[id].tsx                      04 批准(同一件事多条时先选)
    compose.tsx                            02 交办
    settings.tsx                           设置(语言、演示、隐私、关于)
    pair.tsx                               配对说明(真配对在下一份计划)
  src/backend/types.ts                     Backend 接口
  src/backend/demo.ts                      演示后端(Codex 示例情境)
  src/backend/demo-data.ts                 演示数据
  src/state/store.ts                       查询缓存 + 连接状态 + 提交锁(纯 TS)
  src/state/hooks.ts                       React hooks(useSyncExternalStore)
  src/view/status.ts                       状态词
  src/view/now.ts  progress.ts  approval.ts  together.ts   视图模型
  src/i18n/{en,zh-Hans}.ts  src/i18n/index.ts
  src/ui/tokens.ts  src/ui/{Card,Button,StatusPill,CCFigure,TopBar,SayBar,Sheet}.tsx
  assets/cc/{lit,unlit}.png  assets/icon.png(占位,正式图标另出)
  .maestro/*.yaml                          演示流程
```

---

### Task 1: 协议包 —— 订阅主题的形状

**Files:**
- Create: `packages/protocol/src/topics.ts`、`packages/protocol/src/topics.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `src/daemon/phone-topic-sources.test.ts`(真实来源的快照要能被新 schema 解析)

**Interfaces:**
- Produces(从 `@wechat-cc/protocol` 导出):
  - `HomeTopic = z.object({ unread: z.number(), presenceState: z.object({ level: z.string(), activity: z.string() }).nullable(), nextCursor: z.string().nullable() })`
  - `ApprovalItem = z.object({ taskId: z.string(), kind: z.enum(['permission','question']), id: z.string(), summary: z.string() })`;`ApprovalsTopic = z.array(ApprovalItem)`
  - `AgentsTopic = z.object({ running: z.number(), waiting: z.number(), tasks: z.array(z.object({ id: z.string(), title: z.string(), phase: z.string() })) })`
  - `MatterTopic = z.union([z.object({ found: z.literal(false) }), z.object({ found: z.literal(true), kind: z.string(), version: z.number(), phase: z.string() })])`
  - 对应 `…T` 类型。
- 这些形状照 `src/daemon/phone-topic-sources.ts` 顶部注释与实现写;实现前先读那个文件,字段(尤其 `nextCursor` 的类型、`presenceState` 的字段名)**以实际代码为准**,不一致就改 schema 并在报告里记 Ruling。

- [ ] **Step 1: 写失败的测试**

`packages/protocol/src/topics.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic } from './topics'

describe('订阅主题形状', () => {
  it('home', () => {
    expect(HomeTopic.safeParse({ unread: 2, presenceState: { level: 'home', activity: 'working' }, nextCursor: null }).success).toBe(true)
    expect(HomeTopic.safeParse({ unread: '2', presenceState: null, nextCursor: null }).success).toBe(false)
  })
  it('approvals', () => {
    expect(ApprovalsTopic.safeParse([{ taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: ls' }]).success).toBe(true)
    expect(ApprovalsTopic.safeParse([{ taskId: 'x', kind: 'other', id: 'p1', summary: '' }]).success).toBe(false)
  })
  it('agents', () => {
    expect(AgentsTopic.safeParse({ running: 1, waiting: 0, tasks: [{ id: 'a', title: 't', phase: 'working' }] }).success).toBe(true)
  })
  it('matter', () => {
    expect(MatterTopic.safeParse({ found: false }).success).toBe(true)
    expect(MatterTopic.safeParse({ found: true, kind: 'task', version: 3, phase: 'working' }).success).toBe(true)
    expect(MatterTopic.safeParse({ found: true }).success).toBe(false)
  })
})
```

在 `src/daemon/phone-topic-sources.test.ts` 现有的「真实来源」用例里(或新加一条:用该文件已有的假工作台 / 假 matters / 假 home 构造 `makePhoneTopicSources`),对四个来源各取一份快照,分别用 `HomeTopic` / `ApprovalsTopic` / `AgentsTopic` / `MatterTopic` `parse`,断言不抛。

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/protocol/src/topics.test.ts src/daemon/phone-topic-sources.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`packages/protocol/src/topics.ts`:

```ts
/**
 * 手机订阅主题的数据形状(与 src/daemon/phone-topic-sources.ts 的四个来源一一对应)。
 * 事件只带小摘要与版本号,大内容照旧用 req 拉。daemon 的测试拿真实快照对着这里 parse,防漂移。
 */
import z from 'zod'

export const HomeTopic = z.object({
  unread: z.number(),
  presenceState: z.object({ level: z.string(), activity: z.string() }).nullable(),
  nextCursor: z.string().nullable(),
})
export const ApprovalItem = z.object({ taskId: z.string(), kind: z.enum(['permission', 'question']), id: z.string(), summary: z.string() })
export const ApprovalsTopic = z.array(ApprovalItem)
export const AgentsTopic = z.object({
  running: z.number(), waiting: z.number(),
  tasks: z.array(z.object({ id: z.string(), title: z.string(), phase: z.string() })),
})
export const MatterTopic = z.union([
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), kind: z.string(), version: z.number(), phase: z.string() }),
])
export type HomeTopicT = z.infer<typeof HomeTopic>
export type ApprovalItemT = z.infer<typeof ApprovalItem>
export type AgentsTopicT = z.infer<typeof AgentsTopic>
export type MatterTopicT = z.infer<typeof MatterTopic>
```

(字段以 `phone-topic-sources.ts` 实际为准。)`index.ts` 导出这些。

- [ ] **Step 4: 跑**

Run: `bun --bun vitest run packages/protocol src/daemon/phone-topic-sources.test.ts scripts/protocol-purity.guard.test.ts apps/mobile/build.test.ts && bun run typecheck; echo exit=$?`
Expected: PASS;`exit=0`(生成物不同步 ⇒ `bun run build:mobile`)。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol src/daemon/phone-topic-sources.test.ts apps/mobile relay/pset.html src/daemon/mobile-page.generated.json
git commit -m "协议包:手机订阅主题的数据形状(home / approvals / agents / matter)"
```

---

### Task 2: `apps/app` 工程骨架 + CI

**Files:**
- Create: `apps/app/**`(由 `create-expo-app` 生成后精简)、`apps/app/vitest.config.ts`、`apps/app/src/smoke.test.ts`
- Modify: 根 `package.json`(typecheck)、根 `tsconfig.json`(exclude)、根 `vitest.config.ts`(exclude)、`.github/workflows/ci.yml`、`scripts/ci-workflow.guard.test.ts`

**Interfaces:**
- Produces: `apps/app` 工作区包 `@wechat-cc/app`;脚本 `typecheck`(`tsc --noEmit`)、`test`(`vitest run`)、`export:check`(`expo export --platform ios --platform android --output-dir .expo-export-check` 后删目录;用于证明 JS 能打包)、`start`;依赖 `@wechat-cc/protocol: workspace:*`、`expo-router`、`expo-localization`、`expo-secure-store`(下一份计划用,先装)、`react-native-safe-area-context`、`react-native-screens`;`app.json`:`name: Tendhearth`、`slug: tendhearth`、`scheme: tendhearth`、`ios.bundleIdentifier` 与 `android.package` 都是 `com.tendhearth.app`、`userInterfaceStyle: automatic`、Expo Router 插件。

- [ ] **Step 1: 生成工程**

```bash
cd apps && bunx create-expo-app@latest app --template default@sdk-57 --no-install && cd ..
```

然后精简:删掉模板的示例页面与示例组件(保留 `app/_layout.tsx` 并改成最小根布局),删除模板自带的 lint / reset 脚本;`package.json` 的 `name` 改 `@wechat-cc/app`、`private: true`,加上面的脚本与依赖;`app.json` 按上面改。`bun install`(在仓库根,workspace 会带上它)。

> 执行者注意:Expo 57 在 bun workspaces 单仓里通常能自动配置 Metro;若 `expo export` 报找不到 `@wechat-cc/protocol` 或重复 React,按 Expo「monorepos」文档加 `metro.config.js`(`watchFolders` 指到仓库根,`resolver.nodeModulesPaths` 加根 `node_modules`),并在报告里记 Ruling。先用 Context7(`/expo/expo`)查 SDK 57 的单仓指引。

- [ ] **Step 2: 最小测试与配置**

`apps/app/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } })
```

`apps/app/src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { HomeTopic } from '@wechat-cc/protocol'
describe('app 工程', () => {
  it('能用协议包', () => { expect(HomeTopic.safeParse({ unread: 0, presenceState: null, nextCursor: null }).success).toBe(true) })
})
```

`apps/app/tsconfig.json` 继承 `expo/tsconfig.base`,`strict: true`,`paths` 不需要(workspace 包直接解析)。

根目录:`tsconfig.json` 的 `exclude` 加 `"apps/app/**"`;`vitest.config.ts` 的 `exclude` 加 `'apps/app/**'`;`package.json` 的 `typecheck` 末尾加 `&& tsc --noEmit -p apps/app`。

- [ ] **Step 3: 跑**

Run:
```bash
cd apps/app && bun run test && bun run typecheck; echo exit=$?; bun run export:check; echo export=$?; cd ../..
bun run typecheck; echo root=$?
bun run test > $CLAUDE_JOB_DIR/tmp/app-skel-root.log 2>&1; echo roottest=$?
```
Expected: 全部 0;根测试没有收进 `apps/app` 的测试。

- [ ] **Step 4: CI**

`scripts/ci-workflow.guard.test.ts` 先加断言(changes 作业多 `app` 输出,过滤 `apps/app/**` 与 `packages/protocol/**`;`app` 作业 `needs: changes`、`if` 用该输出、setup-bun 钉 1.3.14),跑它确认红;再改 `ci.yml`:

```yaml
  # Tendhearth 手机 app(apps/app,Expo)。只做类型检查、纯逻辑测试与 JS 打包检查;原生构建走 EAS,不进每次 CI。
  app:
    name: app · expo
    needs: changes
    if: needs.changes.outputs.app == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - name: Typecheck
        working-directory: apps/app
        run: bun run typecheck
      - name: Unit
        working-directory: apps/app
        run: bun run test
      - name: Bundle check
        working-directory: apps/app
        run: bun run export:check
```

`changes` 作业:`outputs.app: ${{ steps.filter.outputs.app }}`,过滤加 `app: ['apps/app/**', 'packages/protocol/**']`。

Run: `bun --bun vitest run scripts/ci-workflow.guard.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/app package.json bun.lock tsconfig.json vitest.config.ts .github/workflows/ci.yml scripts/ci-workflow.guard.test.ts
git commit -m "apps/app:Tendhearth Expo 工程骨架 + CI 作业"
```

---

### Task 3: 设计 token、文案表、CC 素材、基础组件

**Files:**
- Create: `apps/app/src/ui/tokens.ts`、`apps/app/src/i18n/{en.ts,zh-Hans.ts,index.ts}`、`apps/app/src/i18n/i18n.test.ts`、`apps/app/src/ui/tokens.test.ts`
- Create: `apps/app/src/ui/{Card,Button,StatusPill,CCFigure,TopBar,SayBar,Sheet}.tsx`
- Create: `apps/app/assets/cc/lit.png`、`apps/app/assets/cc/unlit.png`(从 `apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png` 复制)

**Interfaces:**
- Produces:
  - `tokens.ts`:`export const palette = { light: {...}, dark: {...} } as const`,两套相同的键:`bg, card, ink, muted, line, primary, primaryInk, navOnBg, navOnInk, accentSoft, warn, ok`;`export type Scheme = 'light' | 'dark'`;`export const radius = { card: 20, button: 14, pill: 10 }`;`export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 }`;字体:标题用系统衬线(iOS `Georgia` 退回系统,安卓 `serif`)—— 与 Codex 稿一致。
  - i18n:`export type Lang = 'en' | 'zh-Hans'`;`export function pickLang(tags: readonly string[]): Lang`(`zh` 开头 ⇒ zh-Hans,其它 ⇒ en);`export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string`(`{name}` 插值);`MessageKey = keyof typeof en`。
  - 组件:`Card`、`Button({ kind: 'primary'|'secondary', label, onPress, disabled, busy })`、`StatusPill({ status: StatusKey })`、`CCFigure({ size, mood? })`(浅色用 lit、深色用 unlit;减少动态效果时不做呼吸动画)、`TopBar({ title?, onBack?, connection })`(右上「家里的电脑」状态点 + 头像进设置)、`SayBar({ placeholder, onPress })`、`Sheet`(可展开区块)。

- [ ] **Step 1: 写失败的测试**

`i18n.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import en from './en'
import zh from './zh-Hans'
import { pickLang, t } from './index'

describe('文案表', () => {
  it('两份语言的键完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
  it('没有空字符串', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(zh)]) expect(v.trim(), k).not.toBe('')
  })
  it('pickLang:中文系 ⇒ zh-Hans,其它(含法语、空)⇒ en', () => {
    expect(pickLang(['zh-Hans-CN'])).toBe('zh-Hans')
    expect(pickLang(['zh-TW'])).toBe('zh-Hans')
    expect(pickLang(['fr-FR', 'zh-CN'])).toBe('en')
    expect(pickLang([])).toBe('en')
  })
  it('插值', () => {
    expect(t('en', 'now.needsYouCount', { n: 2 })).toContain('2')
    expect(t('zh-Hans', 'now.needsYouCount', { n: 2 })).toContain('2')
  })
})
```

`tokens.test.ts`:浅深两套键一致;所有值是 `#rrggbb`;`light.bg === '#faf8f3'`、`light.primary === '#58654c'`、`dark.bg === '#221f1b'`(钉住 Global Constraints 的色值)。

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun run test`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

文案表键(至少这些,中英文文案**从 `docs/design/tendhearth-app-v1/tendhearth-phone.html` 里的 `tr('中','英')` 对照抄**,那里没有的按同一语气补):`common.back, common.cancel, common.retry, common.computerHome, common.computerOffline, common.lastSynced, now.greetingMorning, now.greetingAfternoon, now.greetingEvening, now.needsYouCount, now.needsYouTitle, now.lookThenDecide, now.ccLine.default, now.togetherTitle, now.sayToCC, together.title, together.empty, status.working, status.waiting, status.replied, status.done, status.failed, status.stopped, progress.ccProgress, progress.viewApproval, progress.viewChanges, progress.viewProcess, progress.continueSay, approval.eyebrow, approval.what, approval.scope, approval.effect, approval.rawCommand, approval.workingDir, approval.viewExact, approval.deny, approval.allow, approval.onlyThisRequest, approval.handled, approval.backToMatter, approval.chooseOne, approval.uncertain, approval.aiSummary, compose.eyebrow, compose.title, compose.hint, compose.placeholder, compose.addImage, compose.draft, compose.usingContext, compose.adjust, compose.send, compose.willAskYou, compose.orSay, welcome.title, welcome.body, welcome.pair, welcome.lookFirst, pair.title, pair.steps, pair.comingSoon, settings.title, settings.language, settings.languageSystem, settings.demo, settings.exitDemo, settings.privacy, settings.privacyBody, settings.about, demo.banner`。

`settings.privacyBody` 必须说明:查看待批准说明时,命令文本会发给电脑上配置的便宜模型服务商;其余内容只在手机与你的电脑之间加密传输。

组件按 Codex 截图做(`screenshots/desktop-palette-*.png` 是准):卡片大圆角 + 细边线,主按钮深橄榄绿圆角,导航选中底色米黄。组件只接收 props、用 `useColorScheme()` 取 `palette[scheme]`。`CCFigure` 用 `Image` 显示 `assets/cc/lit.png` / `unlit.png`;有 `AccessibilityInfo.isReduceMotionEnabled()` ⇒ 不动,否则轻微呼吸(`Animated` 缩放 1 → 1.02 循环,4 秒)。

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck; echo exit=$?; bun run export:check; echo export=$?`
Expected: PASS;两个 0。

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "app:设计 token、中英文案表、CC 素材、基础组件"
```

---

### Task 4: `Backend` 接口 + 状态词 + 视图模型

**Files:**
- Create: `apps/app/src/backend/types.ts`、`apps/app/src/view/{status.ts,now.ts,progress.ts,approval.ts,together.ts}` 与各自 `*.test.ts`

**Interfaces:**
- Consumes:协议包 `Matter`、`MatterDetail`、`ApprovalExplanation`、`ProgressSummary`、`PhoneChangesTurn`、`EntryOptions`、`ApprovalItem`、`AgentsTopic`、`HomeTopic`(均用 `z.infer`)。
- Produces:
  - `types.ts`:
    ```ts
    export type Connection = { state: 'online' | 'offline' | 'revoked'; lastSyncedAt: number | null }
    export type Unsubscribe = () => void
    export interface Backend {
      readonly mode: 'demo' | 'live'
      connection(): Connection
      onConnection(cb: (c: Connection) => void): Unsubscribe
      subscribe<T>(topic: 'home' | 'approvals' | 'agents' | `matter/${string}`, cb: (data: T) => void): Unsubscribe
      matters(): Promise<MatterT[]>
      matter(id: string): Promise<MatterDetailT>
      insight(id: string, lang: Lang): Promise<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>
      changes(id: string): Promise<PhoneChangesTurnT | null>
      decide(p: { id: string; runId: string; requestId: string; decision: 'allow' | 'deny' }): Promise<void>
      answer(p: { id: string; runId: string; requestId: string; answers: Record<string, unknown> | null }): Promise<void>
      say(id: string, text: string): Promise<void>
      entryOptions(): Promise<EntryOptionsT>
      create(p: { text: string; projectPath?: string; providerId?: string }): Promise<{ matterId: string }>
    }
    export class BackendError extends Error { constructor(public code: string) { super(code) } }   // 'stale' | 'offline' | 'revoked' | 'timeout' | 'unknown'
    ```
  - `status.ts`:`export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'`;`export function statusOf(task: { status: string; phase?: string }, pending: number): StatusKey` —— `pending > 0` ⇒ waiting;`phase` `failed`/`interrupted` 或 `status` `failed`/`interrupted` ⇒ failed;`cancelled` ⇒ stopped;`status === 'completed'` 且 phase 不是 `replied` 以外的在跑态 ⇒ done;`phase === 'replied'` ⇒ replied;其余 ⇒ working。
  - `now.ts`:`export function nowView(input: { approvals: ApprovalItemT[]; agents: AgentsTopicT; matters: MatterT[]; hour: number }): { greetingKey: 'now.greetingMorning' | 'now.greetingAfternoon' | 'now.greetingEvening'; needsYou: Array<{ taskId: string; count: number; firstSummary: string }>; together: Array<{ id: string; title: string; status: StatusKey; updatedAt: number }> }` —— 待批准按 `taskId` 分组(同一件事多条 ⇒ `count > 1`),「一起做」按更新时间倒序最多 5 条;问候:5–11 早、12–17 午、其余晚。
  - `approval.ts`:
    ```ts
    export type ApprovalView =
      | { kind: 'choose'; items: Array<{ requestId: string; summary: string }> }
      | { kind: 'none' }                       // 已经没有待处理(另一端处理了 / 旧通知)
      | { kind: 'card'; requestId: string; runId: string; title: string; what: string; scope: string; effect: string;
          aiSummary: boolean; rawFirstLine: string; rawFull: string; workingDir: string; showRawInline: boolean }
    export function approvalView(detail: MatterDetailT, explanations: Record<string, ApprovalExplanationT>, requestId?: string): ApprovalView
    ```
    规则:`detail.permissions` 为空 ⇒ `none`;给了 `requestId` 且存在 ⇒ 那一条;给了但不存在 ⇒ `none`;没给且有多条 ⇒ `choose`;只有一条 ⇒ 那一条。`title/what/scope/effect` 取说明,没有说明时用原文(`title = tool`、`what = description`、`scope = task.path`、`effect = ''`)。`aiSummary = explanation?.source === 'model'`;`showRawInline = aiSummary`(**模型说明时原始命令首行 + 目录直接可见**);`rawFirstLine` = 描述的第一行(最多 120 字);`workingDir = detail.task?.path ?? ''`;`runId = detail.runId ?? ''`(没有 runId ⇒ `none`,因为无法提交)。
  - `progress.ts`:`export function progressView(detail: MatterDetailT, insight: { progress: ProgressSummaryT | null } | null, changes: PhoneChangesTurnT | null): { status: StatusKey; title: string; summary: string | null; steps: Array<{ title: string; detail: string; done: boolean }>; pendingCount: number; changedFiles: number }` —— 步骤最后一条若 `status === 'waiting'` 则 `done: false`(显示「等你决定」图标);`summary` 为 null 时界面显示骨架;`pendingCount = permissions.length + questions.length`。
  - `together.ts`:`export function togetherView(matters: MatterT[], approvals: ApprovalItemT[], agents: AgentsTopicT): Array<{ id: string; title: string; status: StatusKey; subtitle: string }>` —— 等你决定的排最前,其余按 `updatedAt` 倒序。

- [ ] **Step 1: 写失败的测试**(每个视图模型一份;下面是批准页的,其余照同样粒度写:`status.test.ts` 覆盖每一种状态;`now.test.ts` 覆盖分组、排序、截断、问候边界 5 / 12 / 18 点;`progress.test.ts` 覆盖 summary 为空、待决定步骤;`together.test.ts` 覆盖排序)

```ts
import { describe, it, expect } from 'vitest'
import { approvalView } from './approval'

const base = {
  matter: { id: 'ab12cd34', kind: 'task', title: 'x', projectPath: '/p', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 },
  bindings: [], sessions: [], events: [], artifacts: [], inputs: [], questions: [],
  task: { id: 'ab12cd34', title: '作品集', status: 'running', phase: 'working', providerId: 'claude', path: '/Users/me/portfolio', error: null, updatedAt: 1 },
  runId: 'run-1',
  permissions: [{ id: 'p1', taskId: 'ab12cd34', tool: 'Bash', description: 'rm -rf ~/Documents/old\n# cleanup', createdAt: 1 }],
} as any
const model = { title: '可以清理旧文件吗?', what: '清理临时缓存', scope: '作品集', effect: '删除一些文件', source: 'model' as const }

describe('approvalView', () => {
  it('模型说明 ⇒ 原始命令首行与目录直接可见(aiSummary + showRawInline)', () => {
    const v = approvalView(base, { p1: model })
    expect(v).toMatchObject({ kind: 'card', requestId: 'p1', runId: 'run-1', aiSummary: true, showRawInline: true, rawFirstLine: 'rm -rf ~/Documents/old', workingDir: '/Users/me/portfolio' })
  })
  it('没有说明 ⇒ 用原文,不是 AI 概括', () => {
    const v = approvalView(base, {})
    expect(v).toMatchObject({ kind: 'card', title: 'Bash', what: 'rm -rf ~/Documents/old\n# cleanup', aiSummary: false })
  })
  it('同一件事两条、没指定 ⇒ 让用户选', () => {
    const d = { ...base, permissions: [...base.permissions, { id: 'p2', taskId: 'ab12cd34', tool: 'Bash', description: 'ls', createdAt: 2 }] }
    expect(approvalView(d, {})).toEqual({ kind: 'choose', items: [{ requestId: 'p1', summary: 'Bash: rm -rf ~/Documents/old' }, { requestId: 'p2', summary: 'Bash: ls' }] })
  })
  it('指定了但已不存在 / 没有待处理 / 没有 runId ⇒ none', () => {
    expect(approvalView(base, {}, 'gone')).toEqual({ kind: 'none' })
    expect(approvalView({ ...base, permissions: [] }, {})).toEqual({ kind: 'none' })
    expect(approvalView({ ...base, runId: undefined }, {})).toEqual({ kind: 'none' })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun run test`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**(按上面 Interfaces 的规则逐条写;`approval.ts` 的 `choose` 摘要 = `${tool}: ${描述第一行}`,最多 80 字)

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck; echo exit=$?`
Expected: PASS;`exit=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/backend/types.ts apps/app/src/view
git commit -m "app:Backend 接口、状态词与四个视图模型(批准页原始命令可见 / 多条先选)"
```

---

### Task 5: 演示后端

**Files:**
- Create: `apps/app/src/backend/demo-data.ts`、`apps/app/src/backend/demo.ts`、`apps/app/src/backend/demo.test.ts`

**Interfaces:**
- Consumes: Task 4 `Backend`、`BackendError`。
- Produces: `export function makeDemoBackend(opts?: { now?: () => number; setTimeout?: typeof setTimeout; lang?: Lang }): Backend & { reset(): void }`,`mode: 'demo'`,连接永远 `online`。
- 情境(照 Codex 稿):两件事 ——
  1. `a1b2c3d4`「让作品集在手机上更好看」:任务,`claude`,路径 `~/Projects/portfolio`,事件若干(看过首页、调整布局),**一条待批准** `perm-demo-1`:`tool: 'Bash'`、`description: 'npm install sharp'`;说明(`source: 'model'`):标题「可以安装图片处理组件吗?」/ what「安装 sharp 图片处理组件。」/ scope「作品集项目的依赖文件。」/ effect「联网下载软件包,可能运行安装脚本,并更新项目的依赖记录。」(英文版按 Codex 稿英文);进展概括与三步。
  2. `e5f6a7b8`「把零散想法收一收」:聊天事项,状态 `replied`,更新时间「昨天」。
- 行为:`decide(allow)` ⇒ 该权限移除、任务进入 `working`、订阅者(approvals / agents / matter/<id> / home)立刻收到新快照;2 秒后(可注入定时器)任务变 `replied`,进展多一步「图片处理完成」,再推一次。`decide(deny)` ⇒ 权限移除,任务 `replied`,事件加一条「先不做」。`decide` 用已不存在的 requestId ⇒ 抛 `BackendError('stale')`。`create` ⇒ 新建一件「正在整理」的任务,2 秒后 `replied`。`say` ⇒ 事件加一条用户消息、2 秒后加一条 CC 回复。`changes` ⇒ 一轮两个文件的小 diff。

- [ ] **Step 1: 写失败的测试**(用 `vi.useFakeTimers()`,finally 恢复)

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeDemoBackend } from './demo'

describe('演示后端', () => {
  it('初始:一条待批准,两件事', async () => {
    const b = makeDemoBackend()
    expect((await b.matters()).length).toBe(2)
    const d = await b.matter('a1b2c3d4')
    expect(d.permissions.map(p => p.id)).toEqual(['perm-demo-1'])
    expect((await b.insight('a1b2c3d4', 'zh-Hans')).explanations['perm-demo-1']?.source).toBe('model')
  })
  it('允许 ⇒ 立刻推「正在整理」,2 秒后「这一轮已回复」;四个主题都更新', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const approvals: unknown[] = [], agents: any[] = [], matter: any[] = [], home: unknown[] = []
      b.subscribe('approvals', d => approvals.push(d)); b.subscribe('agents', d => agents.push(d))
      b.subscribe('matter/a1b2c3d4', d => matter.push(d)); b.subscribe('home', d => home.push(d))
      await b.decide({ id: 'a1b2c3d4', runId: (await b.matter('a1b2c3d4')).runId!, requestId: 'perm-demo-1', decision: 'allow' })
      expect(approvals.at(-1)).toEqual([])
      expect(agents.at(-1).tasks.find((t: any) => t.id === 'a1b2c3d4').phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect(matter.at(-1).phase).toBe('replied')
      expect(home.length).toBeGreaterThanOrEqual(2)
    } finally { vi.useRealTimers() }
  })
  it('用已处理的 requestId 再提交 ⇒ stale', async () => {
    const b = makeDemoBackend()
    const runId = (await b.matter('a1b2c3d4')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    await expect(b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'allow' })).rejects.toThrow('stale')
  })
  it('交办 ⇒ 新事项正在整理,稍后回复', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend()
      const { matterId } = await b.create({ text: '把周报整理一下' })
      expect((await b.matters()).length).toBe(3)
      expect((await b.matter(matterId)).task?.phase).toBe('working')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await b.matter(matterId)).task?.phase).toBe('replied')
    } finally { vi.useRealTimers() }
  })
  it('所有返回都符合协议包的 schema', async () => {
    const { MatterDetail, Matter, ApprovalsTopic, AgentsTopic } = await import('@wechat-cc/protocol')
    const b = makeDemoBackend()
    for (const m of await b.matters()) expect(() => Matter.parse(m)).not.toThrow()
    expect(() => MatterDetail.parse(await b.matter('a1b2c3d4'))).not.toThrow()
    let a: unknown, g: unknown
    b.subscribe('approvals', d => { a = d }); b.subscribe('agents', d => { g = d })
    expect(() => ApprovalsTopic.parse(a)).not.toThrow()
    expect(() => AgentsTopic.parse(g)).not.toThrow()
  })
})
```

(`subscribe` 订阅时立刻同步推一次当下快照 —— 与真后台「订阅即发当下」一致。)

- [ ] **Step 2: 跑,确认失败** —— `cd apps/app && bun run test`,FAIL(模块不存在)。

- [ ] **Step 3: 实现** —— `demo-data.ts` 放初始数据(中英两份文案按 `lang` 选);`demo.ts` 内部一个可变状态 + 订阅表,每次变化对四个主题各算一份快照推给订阅者;定时器用注入的 `setTimeout`。

- [ ] **Step 4: 跑** —— `cd apps/app && bun run test && bun run typecheck; echo exit=$?`,PASS / 0。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/backend
git commit -m "app:演示后端(作品集情境,批准 / 交办 / 说一句都有模拟结果)"
```

---

### Task 6: 状态存储 + hooks(查询缓存、连接状态、提交锁)

**Files:**
- Create: `apps/app/src/state/store.ts`、`apps/app/src/state/store.test.ts`、`apps/app/src/state/hooks.ts`、`apps/app/src/state/BackendProvider.tsx`

**Interfaces:**
- Consumes: Task 4 `Backend`;Task 5 `makeDemoBackend`。
- Produces:
  - `store.ts`(纯 TS,无 React):`export function makeStore(backend: Backend)` 返回:
    - `query<T>(key: string, load: () => Promise<T>): { get(): QueryState<T>; subscribe(cb): Unsubscribe; refresh(): Promise<void> }`,`QueryState<T> = { data?: T; error?: string; loading: boolean; syncedAt?: number }`;同一个 key 共用一份;`refresh` 在飞时复用。
    - `submit(key: string, run: () => Promise<void>): Promise<'ok' | 'busy' | { error: string }>` —— 同一 key 在飞时再调 ⇒ 立刻 `'busy'`,不重复提交;`BackendError('timeout')` ⇒ `{ error: 'uncertain' }`(界面显示「不确定,正在重新确认」并刷新)。
    - `topic<T>(name): { get(): T | undefined; subscribe(cb): Unsubscribe }` —— 包一层 `backend.subscribe`,引用计数,最后一个退订时退订后端。
    - `connection(): Connection` + 订阅。
  - `hooks.ts`:`useQuery(key, load)`、`useTopic(name)`、`useConnection()`、`useSubmit()`,都用 `useSyncExternalStore`。
  - `BackendProvider.tsx`:上下文里放 `backend` + `store`;v1 这里只会是演示后端(下一份计划切换)。

- [ ] **Step 1: 写失败的测试**(`store.test.ts`,用一个极小的假 Backend)

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeStore } from './store'
import { BackendError } from '../backend/types'

describe('store', () => {
  it('同一 key 的查询共用、refresh 在飞复用', async () => {
    const s = makeStore({} as any)
    const load = vi.fn(async () => 42)
    const q1 = s.query('k', load), q2 = s.query('k', load)
    await Promise.all([q1.refresh(), q2.refresh()])
    expect(load).toHaveBeenCalledTimes(1)
    expect(q1.get().data).toBe(42)
  })
  it('submit:在飞时再点 ⇒ busy,只提交一次', async () => {
    const s = makeStore({} as any)
    let release!: () => void
    const run = vi.fn(() => new Promise<void>(r => { release = r }))
    const a = s.submit('approve:p1', run)
    expect(await s.submit('approve:p1', run)).toBe('busy')
    release()
    expect(await a).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('submit:超时 ⇒ uncertain;其它错误 ⇒ 错误码', async () => {
    const s = makeStore({} as any)
    expect(await s.submit('x', async () => { throw new BackendError('timeout') })).toEqual({ error: 'uncertain' })
    expect(await s.submit('y', async () => { throw new BackendError('stale') })).toEqual({ error: 'stale' })
  })
  it('topic 引用计数:最后一个退订才退订后端', () => {
    const unsub = vi.fn()
    const backend = { subscribe: vi.fn((_t: string, cb: (d: unknown) => void) => { cb(1); return unsub }) } as any
    const s = makeStore(backend)
    const t = s.topic('agents')
    const off1 = t.subscribe(() => {}), off2 = t.subscribe(() => {})
    expect(backend.subscribe).toHaveBeenCalledTimes(1)
    off1(); expect(unsub).not.toHaveBeenCalled()
    off2(); expect(unsub).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2–4**:跑确认失败 → 实现 → `cd apps/app && bun run test && bun run typecheck; echo exit=$?` 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/state
git commit -m "app:状态存储(查询缓存、主题引用计数、提交锁与「不确定」)"
```

---

### Task 7: 路由骨架 + 「此刻」+「一起做」

**Files:**
- Create/Modify: `apps/app/app/_layout.tsx`、`apps/app/app/(tabs)/_layout.tsx`、`apps/app/app/(tabs)/index.tsx`、`apps/app/app/(tabs)/together.tsx`、`apps/app/app/welcome.tsx`

**Interfaces:**
- Consumes: Task 3 组件与文案;Task 4 `nowView` / `togetherView` / `statusOf`;Task 6 hooks 与 `BackendProvider`。
- Produces: 可点击的首页与列表;`testID`:`now-needs-you-card`、`now-look-then-decide`、`now-say`、`now-together-item-<id>`、`tab-now`、`tab-together`、`together-item-<id>`、`welcome-look-first`、`welcome-pair`、`topbar-settings`、`topbar-connection`(Maestro 用)。

- [ ] **Step 1: 根布局与首次打开**

`_layout.tsx`:读系统语言(`expo-localization` 的 `getLocales()` → `pickLang`)与设置里的覆盖(本计划存内存,下一份计划落盘);`useColorScheme()` 定主题;`BackendProvider` 包演示后端;首次打开(内存标记 `seenWelcome`)⇒ 跳 `/welcome`。`welcome.tsx`:CC 形象 + 标题 + 说明 +「和我的电脑配对」(→ `/pair`)+「先看看」(→ 标记已看过、进入 `(tabs)`,并显示演示横幅)。

- [ ] **Step 2: 此刻**

`(tabs)/index.tsx` 从 `useTopic('approvals')`、`useTopic('agents')`、`useQuery('matters', ...)` 得数据 → `nowView(...)` → 按 Codex `screenshots/desktop-palette-light-moment.png` 摆:顶栏(`tendhearth` 字标 + 家里的电脑状态点 + 头像)、日期小字、问候大标题、一句概括(`now.needsYouCount`)、「需要你决定」卡(每件事一张;`count > 1` 显示「N 件」)+「看清楚,再决定」按钮(→ `/approval/<taskId>`,多条时由批准页出选择)、CC 形象 + 一两句近况、「一起做的事」简表(→ `/matter/<id>`)、`SayBar`(→ `/compose`)。演示模式在顶部显示小横幅 `demo.banner`。

- [ ] **Step 3: 一起做**

`(tabs)/together.tsx`:`togetherView(...)` 列表,每行标题 + 状态词 + 副标题,点进 `/matter/<id>`;空列表显示 `together.empty`;右下或底部 `SayBar`。

- [ ] **Step 4: 编译检查**

Run: `cd apps/app && bun run typecheck; echo exit=$?; bun run export:check; echo export=$?; bun run test`
Expected: 两个 0,测试 PASS。

- [ ] **Step 5: 目测**(iOS 模拟器)

Run: `cd apps/app && bunx expo run:ios` 或 `bunx expo start --ios`(development build 若尚无原生扩展可先用 Expo Go 目测纯 JS 界面);截一张「此刻」浅色与深色截图存到 `apps/app/.maestro/screens/`(不进 git 也可,放 `$CLAUDE_JOB_DIR/tmp`),在报告里附路径,对照 Codex 截图写差异清单。

- [ ] **Step 6: Commit**

```bash
git add apps/app/app
git commit -m "app:路由骨架、首次打开、「此刻」与「一起做」"
```

---

### Task 8: 进展页(单件事)

**Files:**
- Create: `apps/app/app/matter/[id].tsx`

**Interfaces:**
- Consumes: Task 4 `progressView`;`backend.matter` / `insight` / `changes`;`useTopic('matter/<id>')`(版本变了就刷新详情与洞察)。
- Produces: `testID`:`progress-status`、`progress-summary`、`progress-view-approval`、`progress-changes`、`progress-process`、`progress-say`。

- [ ] **Step 1: 实现**

按 `screenshots/desktop-palette-light-progress.png`:面包屑「一起做 / 事项」、大标题、**状态标签(在概括之上)**、「CC 的进展」卡(`summary` 为 null ⇒ 骨架占位)、步骤列表(已完成 ✓、等你决定 ⏸)、`pendingCount > 0` ⇒ 主按钮「查看需要批准的这一步」(→ `/approval/<id>`)、可展开「查看改动 · N 个文件」(`Sheet` 里逐文件显示路径 + diff 等宽字体;`truncated` 的只显示「太大了,回电脑上看」)、可展开「查看过程与执行信息」(执行者、路径、最近事件)、`SayBar`「接着跟 CC 说一句」(→ `/compose?matter=<id>`)。

- [ ] **Step 2: 编译检查** —— `cd apps/app && bun run typecheck; echo exit=$?; bun run export:check; echo export=$?`,两个 0。

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/matter
git commit -m "app:进展页(状态在概括之上、改动与过程可展开)"
```

---

### Task 9: 批准页

**Files:**
- Create: `apps/app/app/approval/[id].tsx`

**Interfaces:**
- Consumes: Task 4 `approvalView`;Task 6 `useSubmit`;`backend.decide`。
- Produces: `testID`:`approval-choose-<requestId>`、`approval-title`、`approval-ai-summary`、`approval-raw-inline`、`approval-view-exact`、`approval-deny`、`approval-allow`、`approval-handled`、`approval-uncertain`。

- [ ] **Step 1: 实现**

路由参数 `id`(事项 id)与可选 `request`(推送带来的 requestId)。拉 `matter(id)` 与 `insight(id, lang)` → `approvalView(...)`:
- `choose` ⇒ 列出各条,点选后带 `request` 重进本页。
- `none` ⇒ 显示「这一步已经在电脑上处理」+「回到事项」(→ `/matter/<id>`)。
- `card` ⇒ 按 `screenshots/desktop-palette-light-approval.png`:小 CC +「CC 想和你确认」+ 事项标题;大标题(问句);说明来自模型时在标题下显示小标签 `approval.aiSummary`(「AI 概括」);三行(要做的事 / 作用范围 / 这一步会发生什么);**`showRawInline` 时紧接着直接显示原始命令首行(等宽)与工作目录,不折叠**;可展开「查看具体操作」显示完整原始命令;底部「先不做 / 允许这一步」+「只针对这一次请求。」。
- 提交:`useSubmit('approve:' + requestId, () => backend.decide(...))`;在飞时两个按钮都禁用并显示忙;`'ok'` ⇒ 回到事项页;`{error:'stale'}` ⇒ 显示「已处理」状态;`{error:'uncertain'}` ⇒ 显示 `approval.uncertain` 并重新拉详情。

- [ ] **Step 2: 编译检查** —— 同上,两个 0。

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/approval
git commit -m "app:批准页(模型说明时原始命令直接可见、多条先选、提交锁、已处理与不确定)"
```

---

### Task 10: 交办页 + 配对说明 + 设置

**Files:**
- Create: `apps/app/app/compose.tsx`、`apps/app/app/pair.tsx`、`apps/app/app/settings.tsx`

**Interfaces:**
- Consumes: `backend.entryOptions` / `create` / `say`;Task 3 文案;Task 6 `useSubmit`。
- Produces: `testID`:`compose-input`、`compose-send`、`compose-adjust`、`settings-language`、`settings-exit-demo`、`settings-privacy`、`pair-steps`。

- [ ] **Step 1: 交办**(按 `screenshots/desktop-palette-dark-compose.png`):小标题「和 CC 一起」、大标题「想一起做什么?」、提示、多行输入(保留草稿:内存里按 `matter` 参数分开存)、「加张图片」(v1 演示模式里点了给一句「下一版支持」提示,不接相册)、「沿用:项目 · CC 安排执行 · 调整」(调整 ⇒ 底部表单选项目与执行者,来自 `entryOptions`)、「交给 CC」主按钮、「需要你决定的地方,我会回来问你。」、「也可以先说:帮我理一下这个想法」。带 `matter` 参数时是「接着说一句」模式 ⇒ 调 `say(matter, text)` 后回到事项页;否则 `create` 后进入新事项。

- [ ] **Step 2: 配对说明**:三步图文(打开电脑上的 Tendhearth → 「手机上用」→ 用这台手机扫码),底部说明「真正的配对在下一版上线」(`pair.comingSoon`)—— 下一份计划把它换成扫码。

- [ ] **Step 3: 设置**:语言(跟随系统 / English / 简体中文,改了立即生效)、演示模式说明与「退出演示」(回到 `/welcome`)、隐私(`settings.privacyBody` 全文)、关于(版本号、Nate Gu & Co.)。

- [ ] **Step 4: 编译检查** —— 同上,两个 0;`bun run test` 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/app/app
git commit -m "app:交办页、配对说明、设置(语言 / 演示 / 隐私)"
```

---

### Task 11: Maestro 演示流程 + 文档

**Files:**
- Create: `apps/app/.maestro/demo-walkthrough.yaml`、`apps/app/.maestro/approve.yaml`、`apps/app/.maestro/compose.yaml`、`apps/app/README.md`
- Modify: `docs/roadmap.md`、`docs/INDEX.md`

**Interfaces:**
- Consumes: 前面各任务的 `testID`。

- [ ] **Step 1: 装 Maestro(本机)**

Run: `brew tap mobile-dev-inc/tap && brew install maestro && maestro --version`
Expected: 打印版本。(装不上就在报告里写明原因,改为手动逐步目测并截图,不阻塞提交。)

- [ ] **Step 2: 写流程**

`approve.yaml`(其余两份同样粒度):

```yaml
appId: com.tendhearth.app
---
- launchApp:
    clearState: true
- tapOn:
    id: welcome-look-first
- assertVisible:
    id: now-needs-you-card
- tapOn:
    id: now-look-then-decide
- assertVisible:
    id: approval-raw-inline        # 模型说明时原始命令首行直接可见
- tapOn:
    id: approval-allow
- assertVisible:
    id: progress-status
- extendedWaitUntil:
    visible: "这一轮已回复|Replied this round"
    timeout: 5000
```

`demo-walkthrough.yaml`:首次打开 → 先看看 → 此刻 → 一起做 → 某件事 → 展开改动 → 设置 → 切换语言 → 退出演示。`compose.yaml`:此刻 → 跟 CC 说一句 → 输入 → 交给 CC → 新事项出现在一起做。

- [ ] **Step 3: 在 iOS 模拟器跑**

Run: `cd apps/app && bunx expo run:ios`(首次会生成 `ios/` 并构建 development build —— **`ios/` 与 `android/` 不进 git**,在 `apps/app/.gitignore` 加上;以后原生部分走 config plugin)然后 `maestro test .maestro/`
Expected: 三个流程 PASS。把 `maestro test` 的输出贴进报告。

- [ ] **Step 4: 文档**

`apps/app/README.md`:怎么跑(`bun install`、`cd apps/app && bunx expo start`、`bun run test`、`maestro test .maestro/`)、目录说明、「界面只认 Backend 接口;演示后端在 src/backend/demo.ts」、硬要求清单(批准页原始命令可见等)。`docs/roadmap.md` 子项目 3 加一行「app 骨架 + 演示模式完成(模拟器演示流程通过);下一份计划 = 真连接与配对」。`docs/INDEX.md` 登记本计划与 `apps/app/README.md`。

- [ ] **Step 5: 全量回路 + Commit**

Run:
```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..
bun run test > $CLAUDE_JOB_DIR/tmp/app-skel-final.log 2>&1; echo root=$?
npm run test:node > $CLAUDE_JOB_DIR/tmp/app-skel-final-node.log 2>&1; echo node=$?
bun run typecheck; echo tc=$?
bun run depcheck; echo dep=$?
```
Expected: 全部 0。

```bash
git add apps/app docs/roadmap.md docs/INDEX.md
git commit -m "app:Maestro 演示流程 + README + roadmap"
```

---

## 计划裁决

1. **界面只认 `Backend` 接口,这一份只做演示后端**:演示模式本来就要(审核),先用它把界面全部做对;真连接在下一份计划换上,界面不用改。
2. **纯逻辑用 vitest、界面靠 typecheck + 打包检查 + Maestro**:仓库已统一 vitest;RN 组件的单元渲染测试(jest-expo)收益低于维护成本,真实流程由 Maestro 在模拟器上覆盖。
3. **订阅主题形状补进协议包**(Task 1):app 与 daemon 用同一份,daemon 测试对着真实快照校验,防漂移。
4. **`ios/` `android/` 不进 git**:原生部分(下一份计划的通知扩展)用 Expo config plugin 管,保持「预构建可重生」。
5. **本计划的设置与「已看过欢迎页」只存内存**:落盘与安全存储在下一份计划(配对要用 `expo-secure-store`)一起做。
6. **加图片在 v1 演示里只给提示**:真上传走下一份计划的附件接口。
