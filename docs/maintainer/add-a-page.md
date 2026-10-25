# 怎么加一页(或者给一页加一个能力)

「一页」= 主人在桌面、手机 App、手机网页(`/m`)里看得见的一块界面,背后几乎总是 daemon 的一条或几条路由。这一页说从路由到三端客户端要改哪几处、按什么顺序、漏了哪一处会被哪条测试抓到。

先读:[一页现状图](../architecture.md)里「唯一来源」那张表的「路由」和「错误码」两行;产品层面的规矩在 [`reference/product-naming.md`](../reference/product-naming.md)、[`reference/phone-wording.md`](../reference/phone-wording.md)。

## 0. 先想清楚放在哪

- **每样东西只有一个家**(10-05 定的此刻 / 一起做 / 回忆三层,见 [`superpowers/specs/2026-10-05-now-together-hierarchy.md`](../superpowers/specs/2026-10-05-now-together-hierarchy.md)):新东西归进三个家之一,不另开一个顶层导航。
- **桌面保持简单**:能放进微信或 CLI 的,先别加桌面页面;一定要加,优先在已有的页面里加一块,而不是加一个新的导航项。
- **设计原则**:只留 CC 和功能本身、全衬线、只有一个强调色、页面不变色(没有深色模式)。颜色只能取色板(唯一来源 `packages/design-tokens`,桌面 / 手机的 `tokens.css` 都由它生成,别手改),`--faint` 只作装饰,不能用来承载文字。
- **用词**:手机端一律照 `reference/phone-wording.md`;执行者的名字从名字表来(`src/lib/executor-facts.ts`),不手写「Claude Code」之类。

## 1. 路由:表里加一行

**唯一声明处是 `packages/protocol/src/routes.ts`。** 加一条路由 = 在 `ROUTES` 里加一行,然后 `bun run gen:routes`。

```ts
'GET /v1/foo/list': { desktop: { tier: 'trusted', tokens: ['operator'], tauri: true, devProxy: true } },
'GET /m/api/foo':    { phone: { link: 'none' } },
```

逐格想清楚:

| 格 | 意思 | 不确定时 |
|---|---|---|
| `desktop.tier` | 最低档位 guest / trusted / admin | 不写这条路由 ⇒ 按 admin(fail-closed) |
| `desktop.tokens` | 按路由逐条放行的令牌:`operator`(桌面宿主)/ `federation` / `selftest` | 桌面打包版要调 ⇒ 必须有 `operator` |
| `desktop.tauri` / `devProxy` | 打包版宿主代理放行 / 浏览器预览 dev 代理放行 | `devProxy` 必须同时 `tauri` |
| `desktop.ownerWorkspace` | 主人私事(待办、记下的想法):走 `customer_review_api` 宿主命令,不走 workbench 代理 | 跟 `tauri` 互斥 |
| `phone.link` / `set.link` | 10 分钟链接令牌能不能走:`none` / `read` / `write`(后两者要写 `reason`) | **缺省 `none`**:只给配过对的设备 |
| `module` | 属于哪个可整块关掉的模块(`MODULE_NAMES`) | 模块关着 ⇒ 鉴权之后统一回 503 `module_off` |

几条容易错的:

- **`gen:routes` 生成的 `apps/desktop/src-tauri/generated/workbench-routes.json` 是编进 `.app` 的**(`lib.rs` 用 `include_str!`)。动了 `tauri` / `ownerWorkspace` 那几格,`self deploy` 换 sidecar **换不到**宿主的白名单,要发版。PR 描述里写明「需要随 1.7.x 发版」,并记进 `docs/releases/desktop-v<下一版>.md`。
- **链接令牌的范围 = 链接页面源码里实际调用的那些**(`scripts/link-routes-from-source.guard.test.ts` 扫五处链接页面源码)。页面不调的不开,页面调的不能是 `none`。只给设备用的调用要在源码里写 `/* link-scan: device-only */`。
- **把消息送给执行者的路由只给设备**,不给链接令牌(规矩写在 `src/features/phone/phone-routes.ts` 的注释和 [`reference/internal-api-auth.md`](../reference/internal-api-auth.md))。
- 改了**已有**路由的档位 / 令牌 / link,`scripts/routes-snapshot.guard.test.ts` 会红:是有意的就把快照里那一条一起改,在 PR 里写明。

## 2. 处理器、请求格式、错误码

- 处理器写在 `src/daemon/internal-api/routes-*.ts`(桌面 `/v1/*`)或 `settings-panel.ts` / `mobile-*.ts`(`/m`、`/set`),`{ status, body }` 返回。**不要**在处理器里自己判档位、令牌或模块开关:这三样在 `internal-api/index.ts` 的总入口按表判完了。
- 请求体要校验就在 `internal-api/schema.ts` 的 `REQUEST_SCHEMAS` 加一项(zod);响应形状给客户端用的,放进 `packages/protocol`,App 和桌面共用。
- **错误码只在 `packages/protocol/src/workbench-errors.ts` 声明**:一个码一行,写清各表面的 HTTP 状态。手机老 App 不认的新码收成 `unavailable`(`phone: [503, 'unavailable']`),因为装着的旧版 App 不能强制升级。`scripts/workbench-errors.guard.test.ts` 会反向扫源码里的 `Error('…')` / `fail('…')` 字面量,没登记的就红。
- 主人看得见的失败要说人话、说实话:「关着」和「坏了」是两句话(`module_off` / `module_degraded`);「不确定送到没有」不能说成「失败了」。

## 3. 三端客户端

### 桌面(`apps/desktop/src/`)

- 调用一律走 `api.js`:`invokeApi`(普通 `/v1/*`)、`invokeWorkbenchApi`(工作台,经宿主代理,前端拿不到 operator 凭据)、主人私事经 `OWNER_WORKSPACE_PATHS` 自动交给宿主。**不要**自己 `fetch` daemon。
- `invokeApi` 遇到非 2xx 是**抛** `Error(码)`:按码分支要 `catch` 以后看 `err.message`,别 `.catch(() => null)` 把码吞掉(#545 修过一处)。拒写配置这类码已经在 `api.js` 统一翻成人话(`configRefusalText`)。
- 新的一块放在已有模块里(`modules/*.js`),带同名的 `*.test.ts`(happy-dom)。显示执行者名字用 `executor-names.js`,它读 daemon 给的 `displayName` / `agentNames`,不手写。
- 端到端用 Playwright(`apps/desktop/playwright/`,`bun x playwright test`,端口 4176 别被占)。点侧栏 / 此刻页的控件一律走 fixtures 的 `clickNav` / `reveal`,不要直接 `page.click` 折叠区里的东西。

### 手机 App(`apps/app/`)

- 后端调用加在 `src/backend/live.ts`,同时在 `demo.ts` / `demo-data.ts` 加演示数据(没配对时 App 照样能看),`types.ts` 里补类型。
- 错误码在 `src/net/errors.ts` 映射成 `BackendCode`,再走 i18n(`src/i18n/zh-Hans.ts` + `en.ts` 两份都要加)。
- 页面在 `src/app/`(expo-router),纯展示逻辑放进 `src/view/*.ts` 并配测试。真机 / 模拟器验收见 [`apps/app/README.md`](../../apps/app/README.md) 的 Maestro 一节(`.maestro/*.yaml`)。

### 手机网页(`apps/mobile/src/`)

- 源码改完 `bun run build:mobile`,生成物进仓库。Bun 的 `String.raw` 里写中文要小心转义,行首括号注意 ASI(都踩过)。
- 网页现在只做「配对 / 此刻 / 一起做只看状态」,不再加深的交互页(收敛清单 5b);要加,先问是不是该放进 App。
- 错误码映射在网页里也有一份,`scripts/mobile-web-errors.guard.test.ts` 核它认的码都在错误码表里。

## 4. 验证

```bash
bun run gen:routes --check          # 生成物和表一致
bun run test                        # 含 scripts/ 下所有守卫
npm run test:node
bun run test:e2e                    # 改到入站 / 命令路由时必跑
(cd apps/app && bun run test)       # 动了 App
(cd apps/desktop && bun x playwright test)   # 动了桌面界面
bun run typecheck && bun run depcheck
```

主人在用机器(load 高)时本机全量不作数,以 CI 为准,PR 里照实写。

## 漏了哪一步,谁会红

| 漏了 | 红的地方 |
|---|---|
| 路由表加了行、没跑 `gen:routes` | `route-registry.guard`(生成物和表不一致) |
| 改了已有路由的档位 / 令牌 / link | `routes-snapshot.guard` |
| 表内约束没守住:`devProxy` 却没有 `tauri`、`tauri` 却没有 `operator`、`ownerWorkspace` 和 `tauri` 同时开 | `route-registry.guard` |
| 链接页面调了一条 `link: 'none'` 的路由,或开了页面不调的 | `link-routes-from-source.guard` |
| 处理器里 `Error('新码')`,没进错误码表 | `workbench-errors.guard` |
| 网页 / App 认了一个表里没有的码 | `mobile-web-errors.guard`、App 的 errors 测试 |
| 手写了执行者的名字 | `executor-display-names.guard` |
| 手改了 `tokens.css`(它是 `packages/design-tokens` 渲染出来的生成物) | `design-tokens.guard` |
| 页面里写了色板以外的颜色 | **没有测试会红** —— 评审时看 |
| 桌面改了白名单却没发版 | **没有测试会红** —— 部署后桌面那条请求 403,只能靠 PR 描述和发版说明记住 |

## 相关

- [加一个执行者](add-an-executor.md) · [加一个微信命令](add-a-command.md) · [数据库迁移](migrations.md)
- 路由表的完整字段说明在 `packages/protocol/src/routes.ts` 顶部注释。
