# 手机设备令牌进 token-registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机设置面板的链接令牌与设备令牌改由内部 API 同一个 token-registry 校验,带 origin / routeAllow,设备可按台撤销,隧道只允局域网的操作有具名集合,`runtime/http.ts` 默认监听 loopback。

**Architecture:** token-registry 加 `register`(外部生成的秘钥)、`listSessions`、可注入时钟、两个新 origin;内部 API 暴露一个窄接口 `panelTokens`,经 main.ts → wireMain → pipeline-deps 传给面板(面板没拿到时自建,老测试不动)。设备文件读写抽到 `device-store.ts`,与注册表的同步只在 `makeDeviceCredentials` 一处。路由集合与只允局域网的操作放 `phone-routes.ts`,由守卫对源码字面量双向核对。

**Tech Stack:** TypeScript、Bun / node 双运行时、vitest。

**Spec:** `docs/superpowers/specs/2026-09-27-device-token-registry-design.md`(基线 39cf7f5f;本计划按 dev 7e5ef191 之后的现状重画,#129 已合)。

## Global Constraints

- 设备令牌永不过期(导图 [定]);链接令牌 10 分钟(`SETTINGS_LINK_TTL_MS`),同一时刻只一枚。
- 令牌形状不变:链接 `t` + 32 hex,设备 `d` + 48 hex(手机页按首字母认种类)。
- `settings-devices.json` 仍在 state dir、0600、上限 20 台。
- 面板监听仍 `0.0.0.0`(手机局域网直连,有意);只改 `serve()` 缺省。
- 不把 `/m/api/*` 并进内部 API dispatcher(范围 B);不改隧道握手、HKDF、`_via` 注入。

## 与设计稿不同的裁决(执行前定)

1. **链接令牌的路由集合 = 设备令牌的集合**(设计稿 §2 想让链接令牌只够开设置页和换设备令牌)。现状是 `/set` 页链到 `/m`,`/m` 用链接令牌读 `/m/api/*`、配对前就要用;收窄会让「从设置链接打开随身 CC」在配对前坏掉。代价:10 分钟内链接令牌与设备令牌同权 —— 与今天相同。
2. **路由门按「路径在册」放行,方法错交给原处理器**(设计稿写的是 `METHOD /path` 精确匹配)。`mobile-workbench.ts` 对错方法回 405,测试钉着;门先拦就变成 403。集合仍按 `METHOD /path` 登记,守卫仍双向核对路径。
3. **`makeTokenRegistry(randomHex, now)`** 加可注入时钟(设计稿 §8 要注入 now,注册表原来直接读 `Date.now()`)。
4. **注册表经 `InternalApi.panelTokens` 窄接口传给面板**:只有 `register` / `resolve` / `invalidateSession` / `listSessions`,不暴露 `mint` 与 file/operator 注册。面板没拿到时自建一个。
5. **面板只认 origin 为 `device` / `link` 的令牌**:共享注册表后,session / file / operator 令牌也能 `resolve` 成功,必须挡住,否则内部 API 的会话令牌能打开手机面板。
6. **隧道的设备令牌列表经面板新方法 `deviceTokens()`**,不再裸读文件。

## Review Focus

1. 内部 API 的 session / file / operator 令牌拿去开 `/set` 或 `/m/api/*` ⇒ 401(裁决 5)。
2. 撤销一台后,那台的令牌在局域网与隧道两条路上都立刻 401,其余设备不受影响。
3. 旧格式 `settings-devices.json`(`{token:{created_at}}`)升级后老手机照常能用。
4. 新加一条手机路由忘了登记 ⇒ 守卫本地红;登记了但源码没有 ⇒ 也红。
5. 链接令牌过期后 `/set` 仍回 `EXPIRED_HTML` 401,`/m` 仍回 bootstrap 页。

---

### Task 1: 注册表加 register / listSessions / now / 新 origin,内部 API 暴露 panelTokens

**Files:**
- Modify: `src/daemon/internal-api/token-registry.ts`
- Modify: `src/daemon/internal-api/index.ts`、`src/daemon/internal-api/types.ts`(`InternalApi`)、`src/daemon/internal-api/lifecycle.ts`
- Test: `src/daemon/internal-api/token-registry.test.ts`

**Interfaces — Produces:**
```ts
export type TokenOrigin = 'file' | 'session' | 'operator' | 'device' | 'link'
export interface RegisterInfo { tier: UserTier; origin: 'device' | 'link'; sessionKey: string; routeAllow: ReadonlySet<string>; ttlMs?: number }
export interface PanelTokens {
  register(tokenHex: string, info: RegisterInfo): void
  resolve(tokenHex: string): TokenInfo | null
  invalidateSession(sessionKey: string): void
  listSessions(origin: 'device' | 'link'): Array<{ token: string; sessionKey: string }>
}
export function makeTokenRegistry(randomHex?: () => string, now?: () => number): TokenRegistry  // TokenRegistry extends PanelTokens
// InternalApi / InternalApiLifecycle: panelTokens: PanelTokens
```

- [ ] 写测试(红):`register` 后 `resolve` 得到 origin/tier/sessionKey/routeAllow;`ttlMs` 过期(注入 `now`)后 `resolve` 为 null 且 `listSessions` 不再列出;`invalidateSession('device:x')` 只删那台;`invalidateSession` 对 session origin 照旧;`listSessions('link')` 不含 device;不注入 now 时行为同今天。
- [ ] 实现:origin 联合扩成五种;`now` 参数替换两处 `Date.now()`;`register` 写 map(`expiresAt = now() + ttlMs`);`invalidateSession` 去掉 `origin === 'session'` 条件,按 sessionKey 删(file/operator 没有 sessionKey,不受影响);`listSessions` 遍历时先过期驱逐。
- [ ] 内部 API:`createInternalApi` 返回 `panelTokens: { register, resolve, invalidateSession, listSessions }`(绑定到同一个 registry),类型加到 `InternalApi` 与 lifecycle 包装。
- [ ] 跑 `bun --bun vitest run src/daemon/internal-api` 与 `bun run typecheck`,绿后提交。

### Task 2: phone-routes.ts + 守卫

**Files:**
- Create: `src/daemon/phone-routes.ts`
- Create: `scripts/phone-routes.guard.test.ts`
- Test: `src/daemon/phone-routes.test.ts`

**Interfaces — Produces:**
```ts
export const PHONE_ROUTES: ReadonlySet<string>   // "METHOD /path";以 '/' 结尾的是前缀键
export const LINK_ROUTES: ReadonlySet<string>    // === PHONE_ROUTES(裁决 1)
export const LAN_ONLY_OPS: ReadonlySet<string>   // set_remote / revoke_device / forget_devices / label_device 除外
export function phoneRouteAllowed(allow: ReadonlySet<string>, method: string, path: string): boolean
```

`PHONE_ROUTES` 内容(与 `settings-panel.ts` routeRequest 和 `mobile-workbench.ts` 现状一致):
`GET /set`、`GET /set/api/state`、`POST /set/api/apply`、`POST /set/api/pair`、`GET /m`、`GET /m/api/state`、`GET /m/api/art/blink`、`GET /m/api/memory`、`GET /m/api/home`、`GET /m/api/feed`、`POST /m/api/seen`、`GET /m/api/matters`、`GET /m/api/matter`、`POST /m/api/matter/say`、`POST /m/api/todo`、`GET /m/api/sticker/`(前缀)、`POST /m/api/attachment/chunk`、`GET /m/api/attachment/upload`、`POST /m/api/attachment/discard`、`GET /m/api/entry/options`、`POST /m/api/matter/create`、`GET /m/api/matter/create-receipt`、`POST /m/api/matter/permission`、`POST /m/api/matter/answer`、`GET /m/api/matter/artifact`。

`LAN_ONLY_OPS = { 'set_remote', 'revoke_device', 'forget_devices' }`。

`phoneRouteAllowed`:精确键命中;或某个以 `/` 结尾的键是 `METHOD path` 的前缀;或路径在册但方法不同(交给处理器回 405,裁决 2)。

- [ ] 单测(红):精确 / 前缀 / 方法不同但路径在册 ⇒ true;不在册路径 ⇒ false;`/m/api/sticker` 不带尾斜杠 ⇒ false。
- [ ] 守卫(红,文件还不存在时):读 `settings-panel.ts` 的 `routeRequest` 函数体(大括号配对,同 `route-registry.guard`)与 `mobile-workbench.ts` 全文,抓 `url.pathname === '…'` 与 `url.pathname.startsWith('…')` 字面量;去掉 tokenless 的三条(`/m/icon.png`、`/m/manifest.json`、`/m/sw.js`);断言源码路径集合 == `PHONE_ROUTES` 的路径集合(前缀键比路径本身);断言抓到的数量 ≥ 20(防抓空)。
- [ ] 实现 `phone-routes.ts`,两者转绿,提交。

### Task 3: device-store.ts + makeDeviceCredentials

**Files:**
- Create: `src/daemon/device-store.ts`
- Test: `src/daemon/device-store.test.ts`

**Interfaces — Consumes:** Task 1 `PanelTokens`、Task 2 `PHONE_ROUTES`。**Produces:**
```ts
export interface DeviceRow { id: string; created_at: string; last_seen_at: string; label?: string }
export interface DeviceStore { list(): DeviceRow[]; tokens(): string[]; pair(): { token: string; id: string } | null; revoke(id: string): string | null /* 返回被删的 token */; forgetAll(): string[]; touch(id: string): void; label(id: string, text: string): boolean; idOf(token: string): string | null }
export function makeDeviceStore(stateDir: string, now?: () => number): DeviceStore
export interface DeviceCredentials { bootRegister(): void; pair(): { token: string; id: string } | null; revoke(id: string): boolean; forgetAll(): void; touch(id: string): void; label(id: string, text: string): boolean; list(): DeviceRow[]; tokens(): string[] }
export function makeDeviceCredentials(deps: { store: DeviceStore; tokens: PanelTokens }): DeviceCredentials
export const deviceSessionKey = (id: string) => `device:${id}`
```

- `id = sha256(token).hex.slice(0, 8)`;旧格式读到就原地升级(补 id,`last_seen_at = created_at`),写回 0600。
- `touch` 同一台 5 分钟内只写一次盘(内存记上次写盘时间)。
- `label`:去控制字符、trim、≤ 24 字符;空串删标签。
- credentials 每个动作文件与注册表同时改:`bootRegister` 逐台 `register(token, { tier:'admin', origin:'device', sessionKey: deviceSessionKey(id), routeAllow: PHONE_ROUTES })`;`revoke` 删文件行 + `invalidateSession`;`forgetAll` 删文件 + 逐台 `invalidateSession`。

- [ ] 测试(红):旧格式升级且老令牌仍 `idOf` 得到;上限 20 ⇒ `pair()` 为 null;`revoke` 后注册表 `resolve` 为 null、别的设备仍在;`forgetAll` 后全部 null;`touch` 5 分钟节流(注入 now,看文件 mtime / 内容);`label` 清洗与长度;文件权限 0600(非 win32)。
- [ ] 实现,绿,提交。

### Task 4: 面板改走注册表;隧道与接线

**Files:**
- Modify: `src/daemon/settings-panel.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`、`src/daemon/wiring/index.ts`(`WireMainOpts`)、`src/daemon/main.ts`
- Test: `src/daemon/settings-panel.test.ts`(新 describe:注册表)、`src/daemon/settings-panel-workbench.test.ts`(只改 `remote.devices` 相关断言,如有)

**Interfaces — Consumes:** Tasks 1–3。**Produces:** `SettingsPanelDeps.tokens?: PanelTokens`;`SettingsPanel.deviceTokens(): string[]`;`SettingsPanel.state(currentToken?: string | null)`;`/set/api/state` 的 `remote.devices: Array<DeviceRow & { current: boolean }>`;新 op `revoke_device {id}`、`label_device {id,label}`。

- 构造:`tokens = deps.tokens ?? makeTokenRegistry(undefined, now)`;`creds = makeDeviceCredentials({ store: makeDeviceStore(stateDir, now), tokens })`;立即 `creds.bootRegister()`。
- `issueToken`:`invalidateSession('link')` 后生成 `t…`,`register(token, { tier:'admin', origin:'link', sessionKey:'link', routeAllow: LINK_ROUTES, ttlMs: SETTINGS_LINK_TTL_MS })`。
- `activeLinkToken`:`listSessions('link')[0]?.token ?? null`。
- `validToken(t)`:`resolve(t)` 且 origin ∈ {device, link}(裁决 5)。
- `routeRequest`:无令牌与无效令牌分支不变;有效后取 info,`phoneRouteAllowed(info.routeAllow!, req.method, url.pathname)` 不过 ⇒ `deps.log('SETTINGS', 'route_not_allowed', { event:'route_not_allowed', origin: info.origin, path: \`${req.method} ${url.pathname}\` })` + 403 `{ error:'route_not_allowed' }`;origin 为 device ⇒ `creds.touch(id)`。
- `/set/api/apply`:`_via=tunnel` 且 `op ∈ LAN_ONLY_OPS` ⇒ `{ ok:false, error:'lan_only' }`(替掉只查 `set_remote` 的那行)。
- `apply`:`forget_devices` ⇒ `creds.forgetAll()`;`revoke_device` ⇒ `creds.revoke(id)`,不存在 ⇒ `unknown_device`;`label_device` ⇒ `creds.label`,失败 ⇒ `invalid_value`。审计照写。
- `/set/api/pair` ⇒ `creds.pair()`。
- `state(currentToken)`:`devices` 为数组,`current` 按调用者的 sessionKey 判;`/set/api/state` 传入 `t`。
- pipeline-deps:`makeSettingsPanel({ ..., tokens: opts.panelTokens })`;隧道 `knownDeviceTokens: () => settingsPanel.deviceTokens()`(删掉裸读文件)。`PipelineDepsOpts` / `WireMainOpts` 加 `panelTokens?: PanelTokens`;main.ts 的 `wireMain({...})` 传 `panelTokens: internalApi.panelTokens`。

- [ ] 测试(红):内部 API 会话令牌(同一注册表 `mint('admin','x')`)开 `/set/api/state` ⇒ 401;设备按台撤销后该令牌 401、另一台 200;`LAN_ONLY_OPS` 每条经 `_via=tunnel` ⇒ `lan_only`;有效令牌访问不在册路径(如 `GET /m/api/nope`)⇒ 403 `route_not_allowed`;错方法仍 405(`GET /m/api/attachment/chunk`);`remote.devices` 为数组且 `current` 标对;`label_device` 往返;链接令牌 10 分钟后 `/set` ⇒ `EXPIRED_HTML` 401;`deviceTokens()` 与配对结果一致。
- [ ] 实现;改掉旧测试里 `remote.devices === 0` 之类的数字断言(改成数组长度)。
- [ ] `bun --bun vitest run src/daemon` + `bun run typecheck` + `bun run depcheck` 绿,提交。

### Task 5: 设置页设备列表

**Files:**
- Modify: `src/daemon/settings-panel-html.ts`
- Test: `src/daemon/settings-panel-html.test.ts`

- 「已配对设备」行下渲染列表:每台 `id · 配对日期 · 最近使用 · 标签`,当前这台标「这台」,每行「忘掉」按钮(`revoke_device`,确认框,成功后移除该行;若是当前这台提示「这台手机需要重新配对」)。「全部忘掉」保留。`lan_only` 的提示沿用已有 toast 文案。
- 列表用 `textContent` 拼,不拼 HTML(标签是用户输入)。

- [ ] 测试(红):HTML 里有 `revoke_device` 与列表容器 id;不再出现 `s.remote.devices + " 台`;标签渲染走 `textContent`(字符串里无 `innerHTML` 拼 label)。
- [ ] 实现,绿,提交。

### Task 6: runtime/http.ts 默认 loopback

**Files:**
- Modify: `src/lib/runtime/http.ts`
- Create: `src/lib/runtime/http.test.ts`

- [ ] 测试(红):不传 hostname 起一个服务,`server.hostname`(或实际连接 `127.0.0.1` 成功、用本机 LAN IP 连接失败 —— 用前者,不依赖网卡)为 `127.0.0.1`;显式传 `0.0.0.0` 照旧。
- [ ] 实现:Bun 分支 `bun.serve({ ...options, hostname: options.hostname ?? '127.0.0.1' })`;node 分支缺省改 `'127.0.0.1'`。
- [ ] bun 与 `npm run test:node` 两边跑该文件,提交。

### Task 7: 文档

**Files:** `docs/reference/internal-api-auth.md`(origin 表加 device / link;「这套鉴权之外的门」一节改成「设备与链接令牌」)、`docs/reference/state-layout.md`(`settings-devices.json` 新形状)、`docs/全景导图.md`(加一条 [定]:手机令牌进同一注册表、按台撤销、LAN_ONLY_OPS),设计稿状态行改「完成」并链本计划。

- [ ] 改完跑 `bun run test` 全量 + `npm run test:node` + typecheck + depcheck,提交。

## 收尾

整支 PR 一次 fresh reviewer(opus);合 dev 后 `self deploy` + 两条 selftest;真机:手机扫设置链接 → 配对 → 设置页看到这台 → 忘掉这台 → 手机 401。
