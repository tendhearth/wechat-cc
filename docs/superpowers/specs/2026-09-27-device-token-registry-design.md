# 手机设备令牌进 token-registry(梳理第 6 步)设计

日期:2026-09-27。状态:**完成**(2026-09-29,实施计划 [plans/2026-09-29-device-token-registry.md](../plans/2026-09-29-device-token-registry.md);与本稿不同的六条裁决写在计划开头,最要紧的两条:链接令牌与设备令牌同一套路由、路由门按「路径在册」放行)。基线 origin/dev 39cf7f5f。

**目标:** 三种操作面(微信 MCP 子进程、桌面 Tauri 宿主、手机页)的凭据在**同一个** token-registry 里,各有 origin / tier / routeAllow;手机设备能按台撤销而不只是一键全忘;隧道来的请求有一份具名的「只允局域网」集合;`runtime/http.ts` 默认监听 loopback。

**范围裁决(主人 2026-09-27):** 只换凭据底座(方案 A)。`/m/api/*` 路由**不**并进内部 API dispatcher(那是范围 B,等 Codex 第一批合入后再议)。实现机制:注册表保持纯内存、无 I/O;设备文件的读写抽成独立小模块。

## 1. 现状与问题

- `src/daemon/settings-panel.ts` 自己校验两种令牌:10 分钟短链接令牌(`t` + 32 hex,同一时刻只一枚)与长期设备令牌(`d` + 48 hex,落盘 `settings-devices.json`,上限 20 台,**永不过期是导图 [定]**)。校验不经过 `internal-api/token-registry.ts`,没有 tier、没有 routeAllow、没有统一撤销点;撤销只有「一键全忘」。
- `wiring/pipeline-deps.ts:634` 为隧道裸读 `settings-devices.json`,是文件的第二个读者。
- 隧道来的请求只有 `set_remote` 一条按 `_via=tunnel` 拒(`settings-panel.ts:522`)。
- 面板显式监听 `0.0.0.0`(手机要局域网直连,**有意**);`src/lib/runtime/http.ts` 的 node 分支默认 `0.0.0.0`,Bun 分支交给 Bun 默认(也是 0.0.0.0)。今天所有调用方都显式传了 host,改默认只是给未来调用方兜底。
- 现状文档:`docs/reference/internal-api-auth.md`「这套鉴权之外的门」一节。

## 2. 令牌模型(`src/daemon/internal-api/token-registry.ts`)

- `TokenInfo.origin` 扩为 `'file' | 'session' | 'operator' | 'device' | 'link'`。
- 新增 `register(tokenHex: string, info: RegisterInfo): void`,`RegisterInfo = { tier, origin: 'device' | 'link', sessionKey, routeAllow, ttlMs? }`。它接受**外部生成**的秘钥 —— 手机页按首字母认令牌种类(`d…` 设备 / `t…` 链接),所以秘钥不能由 `mint` 的 randomHex 产生。`ttlMs` 走已有的 `expiresAt` 机制,由 `resolve()` 逐点驱逐,不另起定时器。
- **设备令牌**:`tier:'admin'`、`origin:'device'`、`sessionKey:'device:<id>'`、`routeAllow = PHONE_ROUTES`、无 ttl(导图 [定]:加主屏永不过期)。
- **链接令牌**:`tier:'admin'`、`origin:'link'`、`sessionKey:'link'`、`routeAllow = LINK_ROUTES`、`ttlMs = SETTINGS_LINK_TTL_MS`(10 分钟)。「同一时刻只一枚」= 发新令牌前 `invalidateSession('link')`。
- `PHONE_ROUTES` / `LINK_ROUTES` 定义在新文件 `src/daemon/phone-routes.ts`,形状与 `routeAllow` 一致(`"METHOD /path"` 精确集合;`/m/api/sticker/*` 这一族用前缀键 `"GET /m/api/sticker/"` 单独匹配)。`LINK_ROUTES = PHONE_ROUTES ∪ { 'POST /set/api/pair' }` 减去手机数据面(`/m/api/*`):链接令牌只够打开设置页和换设备令牌。
- 撤销:`invalidateSession('device:<id>')` / `invalidateSession('link')`,和 session token 同一条路。
- `listSessions(origin)` 新增只读接口,给隧道拿当前设备令牌列表(替代裸读文件)。

## 3. 设备文件(新 `src/daemon/device-store.ts`)

从 `settings-panel.ts:160-183` 抽出。文件仍是 `<stateDir>/settings-devices.json`(0600),形状升级:

```json
{ "<token>": { "id": "a1b2c3d4", "created_at": "…", "last_seen_at": "…", "label": "可选" } }
```

- `id` = `sha256(token)` 前 8 位 hex:撤销和展示都用它,秘钥本身不出现在 UI 与日志。
- 读到旧格式(`{token:{created_at}}`)原地升级:补 `id`,`last_seen_at = created_at`。
- 接口:`list(): DeviceRow[]`(不含 token 明文之外的敏感字段;隧道要令牌列表用 `tokens()`)、`pair(): {token,id} | null`(上限 20)、`revoke(id): boolean`、`forgetAll()`、`touch(id)`(写盘节流:同一台 5 分钟内只写一次)、`label(id, text)`。
- 与注册表的同步在**一处**:`makeDeviceCredentials({ store, registry })` 提供 `bootRegister()`(启动时逐台 `register`)、`pair()`、`revoke(id)`、`forgetAll()`,每个动作文件与注册表同时改。settings-panel 与 pipeline-deps 只认这个对象。

## 4. 面板路由的鉴权(`settings-panel.ts`)

- `validToken(t)` 改为 `registry.resolve(t)`;命中后按 `routeAllow.has(\`${method} ${pathname}\`)`(sticker 族按前缀)放行,否则 403 `{ error: 'route_not_allowed' }`,日志字段与内部 API 同名(`event:'route_not_allowed', origin, path`)。
- 无令牌的三条(`/m/icon.png`、`/m/manifest.json`、`/m/sw.js`)与 `/m` 的 bootstrap 页不变;`/set` 无效令牌仍回 `EXPIRED_HTML` 401。
- 设备令牌命中即 `touch(id)`。
- `issueToken()` 改为经注册表铸链接令牌(仍是 `t` + 32 hex,由 settings-panel 生成后 `register`);`activeLinkToken()` 改为从注册表查 `link` 会话。

## 5. 隧道与「只允局域网」

- 具名集合 `LAN_ONLY_OPS = new Set(['set_remote', 'revoke_device', 'forget_devices'])`,放在 `phone-routes.ts`。检查点仍只有 `/set/api/apply` 一处:`_via=tunnel` 且 `op ∈ LAN_ONLY_OPS` ⇒ `{ ok:false, error:'lan_only' }`。
- `_via=tunnel` 的注入机制不动(隧道端注入;局域网请求伪造它只会把自己降权)。
- 隧道的 `knownDeviceTokens` 改从 `deviceCredentials.tokens()` 取;`activeLinkToken` 同上。HKDF 绑定与握手不变。

## 6. `runtime/http.ts` 默认 loopback

`serve(options)` 在交给 Bun 之前补 `hostname: options.hostname ?? '127.0.0.1'`;node 分支同样。面板(`0.0.0.0`)与 A2A(`opts.host`)显式传值,行为不变。

## 7. 设置页 UI(`settings-panel-html.ts` + `apps/mobile`)

「远程访问」块里从「已配对 N 台 / 一键全忘」改成列表:每台一行 `id · 配对时间 · 最近使用 · 标签`,末尾「忘掉这台」;当前手机自己那行标「这台」(按 `sessionKey` 匹配)。「一键全忘」保留。`/set/api/state` 的 `remote.devices` 从数字变成数组;新 op `revoke_device {id}`、`label_device {id, label}`(标签 ≤ 24 字符,`normalizeUserName` 同款清洗)。

## 8. 测试与守卫

- `token-registry.test.ts`:五种 origin;`register` 的 ttl 过期与 `invalidateSession` 撤销;`listSessions('device')`。
- `device-store.test.ts`:旧格式升级、上限 20、`revoke` 后注册表 `resolve` 为 null、`touch` 节流。
- `settings-panel.test.ts`:链接令牌 10 分钟过期(注入 `now`)、设备令牌按台撤销后 401、`LAN_ONLY_OPS` 每条经隧道被拒、`routeAllow` 外的路径 403。
- 守卫 `scripts/phone-routes.guard.test.ts`:解析 `settings-panel.ts` 的 `routeRequest` 里所有 `url.pathname === '…'` / `startsWith('…')` 字面量 + 方法,断言每条都在 `PHONE_ROUTES` 或 `LINK_ROUTES`,反向断言集合里没有多余的(同 `route-registry.guard` 的做法;新加手机路由漏登记会本地红)。
- `runtime/http.test.ts`:不传 hostname 时监听 `127.0.0.1`。
- 文档:`docs/reference/internal-api-auth.md` 的「体系之外的门」一节改成「设备与链接令牌」一节;`reference/state-layout.md` 的 `settings-devices.json` 行更新形状;全景导图加一条 [定]。

## 9. 不做

- `/m/api/*` 并进内部 API dispatcher(范围 B)。
- 设备令牌过期或轮换(导图 [定] 永不过期;撤销即可)。
- 改隧道握手或 HKDF 绑定。
- 改 `_via` 注入机制。
- 把面板监听改成 loopback(手机要局域网直连)。

## 10. 交接与顺序

- 触碰文件:`internal-api/token-registry.ts`(+test)、新 `device-store.ts`(+test)、新 `phone-routes.ts`、`settings-panel.ts`(+test)、`settings-panel-html.ts`、`wiring/pipeline-deps.ts`(两处:面板 deps 与隧道 deps)、`runtime/http.ts`(+test)、`apps/mobile`(设置页设备列表)、三份文档。
- 与 Codex `codex/cc-task-entry` 第一批的关系:它会改 `settings-panel.ts`(手机交办 / 上传入口)与 `pipeline-deps.ts`。**本项等它合入 dev 后再开工**;届时 `PHONE_ROUTES` 要把它新加的手机路由收进来。Codex 阶段 B 提到的「agent 用的窄权限凭据」应直接用 §2 的 `register(hex, {origin, routeAllow, ttlMs})`,不另造一套。
- 实施计划另出(writing-plans),按 §2 → §3 → §4 → §5 → §6 → §7 → §8 的顺序,每节一个 commit,守卫先红后绿。
