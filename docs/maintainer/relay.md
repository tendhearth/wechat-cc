# 官方中继 v2(apps/relay)

## 1. 这是什么

手机 app / 手机网页与家里电脑上的 daemon 之间,需要一个公网上的「会合点」。官方中继 v2 就是这个会合点:一个跑在 Cloudflare Workers 上的服务(每个 daemon 一个 Durable Object),转发加密后的实时通道,并在手机不在线时替 daemon 发 APNs / FCM 推送。它看不到明文。代码在 `apps/relay/`,协议在 `packages/protocol/`。

- 设计:`docs/superpowers/specs/2026-09-30-relay-cloudflare-push-design.md`
- 计划:`docs/superpowers/plans/2026-09-30-relay-cloudflare-push.md`
- 老中继(VPS,`relay/`)的 `/tunnel/*` 只在过渡期服务已配对的老手机网页,mailbox 仍在那里。

主机名:生产 `relay.tendhearth.com`,staging `relay-staging.tendhearth.com`。

## 2. 本地

```bash
cd apps/relay
bun run typecheck
bun run test          # workerd 单测
bun run test:e2e      # node + 本地 workerd(wrangler unstable_startWorker)+ daemon 模块
bunx wrangler dev     # 本地起服务;本地连不了 APNs(workerd#4841)
```

wrangler 会在 `apps/relay/.wrangler/` 留临时目录,已在 `.gitignore`。

## 3. 部署

- dev 推了 `apps/relay/**`、`packages/protocol/**` 或 `relay/pset.src.html` ⇒ `Relay deploy` 工作流自动部署 **staging**(环境 `relay-staging`)。
- 生产:GitHub Actions → Relay deploy → Run workflow → `target: production` → 在 `relay-production` 环境批准。
- 部署前跑 typecheck + 单测;部署后轮询 `https://<host>/healthz`,直到返回的 `version` 等于本次提交前 8 位(`RELAY_VERSION`)。
- 回滚:`cd apps/relay && bunx wrangler rollback --env production`。
- 手动部署一律带 `--env staging` / `--env production`。`wrangler.toml` 顶层 `name` 是 `wechat-cc-relay-dev`,不带 `--env` 的裸 `wrangler deploy` 只会建出一个无路由的 dev worker,覆盖不了生产。
- **按 IP 限速(Worker 内,随部署生效,不用手动配)**:spec §6「按 IP 限制连接尝试」落在 Worker 里——Workers Rate Limiting 绑定 `IP_LIMIT`(`wrangler.toml` 的 `ratelimits`,staging `namespace_id = "1101"`、production `"1001"`,各自计数),按 `CF-Connecting-IP` 计 **60 次 / 10 秒**,只管 `/v2/` 路径;超了回 **429** + `Retry-After: 10` + `{"error":"rate_limited"}`。代码 `apps/relay/src/ip-limit.ts`。房间里的限额只管已知 id 的单个房间,挡不住一个 IP 狂开连接 / 扫 id,这一层就是补这个的。
  - 不记 IP、不记 `?id=`(spec §7):超限只打一个不带标识的 Analytics 计数 `ip_rate_limited`。
  - 没绑(本地 `wrangler dev`、裸顶层配置)或拿不到客户端 IP ⇒ 不限;绑定自己出错 ⇒ 放行。计数按机房本地、最终一致,不是精确账本。
  - `period` 只能 10 或 60;改了要同步 `IP_LIMIT_RETRY_AFTER_S`。`namespace_id` 是账号内唯一的正整数字符串,新环境别复用。
  - **为什么不用 WAF 限速规则**:区域 `tendhearth.com` 是 Free 计划,只允许 **一条** rate limiting rule,已经给更新源 `dl.tendhearth.com` 用掉了。升到付费计划后可以**另加**一条 WAF 规则当外层(表达式 `http.host in {"relay.tendhearth.com" "relay-staging.tendhearth.com"} and starts_with(http.request.uri.path, "/v2/")`,按 IP、60 次 / 10 秒、Block 60 秒)——它在 Worker 之前拦,不计 Worker 请求数;但这是可选加固,Worker 内这层不要因此拿掉。
- 巡检:`Relay watch` 每小时查生产 `/healthz`(非 200 或 `ok!=true` 即失败,GitHub 发失败邮件),并用 Analytics Engine SQL API 查过去 1 小时 `push_ok` / `push_fail`:`fail ≥ 20` 且 `fail/(ok+fail) > 0.5` 即失败。没设 `CF_ANALYTICS_TOKEN` 时只跳过后一步并打印提示。

## 4. Secrets(只列名字)

Worker(每个环境各设一次):

```bash
cd apps/relay
bunx wrangler secret put <NAME> --env staging      # 或 production
```

`APNS_KEY_P8`、`APNS_KEY_ID`、`APNS_TEAM_ID`(`9Y6JAPDP7A`)、`APNS_TOPIC`、`FCM_SERVICE_ACCOUNT`、`ANDROID_CERT_SHA256`(可选;逗号分隔的安卓签名 SHA-256,见第 9 节)。

GitHub:
- secret `CLOUDFLARE_API_TOKEN`(Workers Scripts Edit + Workers Routes Edit + Account Read;两个环境各一份或共用)
- secret `CF_ANALYTICS_TOKEN`(Account Analytics Read,仅巡检用)
- variable `CLOUDFLARE_ACCOUNT_ID`
- environments:`relay-staging`、`relay-production`(后者配 required reviewers)

## 5. 验收

```bash
wechat-cc selftest phone --executor cursor --relay v2
```

## 6. 过渡

v2 **默认关**:daemon 只有在 `agent-config.json` 里显式设了 `relay_v2_url`(非空)才连 v2,此时与老中继双连,新生成的链接指向 v2。没设 ⇒ 只连老中继,行为与这次改动之前完全一样。想让某台 daemon 先走 staging:设 `"relay_v2_url": "wss://relay-staging.tendhearth.com"` 后重启 daemon。老中继隧道何时关,由主人定。

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| `login_failed` | 身份文件(`relay-identity.json`)不对或被换过。挑战签名不看时间,所以不是时钟问题。 |
| `not_configured` | Worker 的 secrets 没设(见第 4 节)。 |
| `InvalidProviderToken` | APNs:`.p8` / key id / team id 不对。 |
| `DeviceTokenNotForTopic` | `APNS_TOPIC` 与 app 的 bundle id 不符。 |

## 8. 上线前后必读 / go-live notes

- **首次部署前:先开 Workers Analytics Engine(账号级,一次)**:`wrangler.toml` 两个环境都绑了 `analytics_engine_datasets`(`METRICS`)。账号没开 Analytics Engine 时 `wrangler deploy` 直接失败,报错码 **10089**。到 Cloudflare 控制台 → Workers & Pages → Analytics Engine,点一次启用即可(数据集会在第一次写入时自动建)。**别为了让部署过去而删掉这个绑定**——巡检的 `push_ok` / `push_fail` 和 `ip_rate_limited` 计数都靠它。
- **上线步骤(顺序不能反)**:① 生产 Worker 部署完、secrets 设好、`https://relay.tendhearth.com/healthz` 正常;② 按 IP 限速随部署自带(第 3 节,Worker 内的 `IP_LIMIT`,无需手动配);③ 再在 `agent-config.json` 设 `"relay_v2_url": "wss://relay.tendhearth.com"` 并重启 daemon(`self deploy`)。设了之后 daemon 会把新生成的链接、`/m` 页的 REMOTE、手机上存的 `ccRemote` 全部切到 v2 中继(`r…` id)。没设这个键时,带这次改动的 daemon 部署下去也只走老中继,所以 daemon 可以先于中继发版。
- **id 变化**:daemon id 从 `t…` 变 `r…` 时,手机网页里按 id 存的浏览器缓存(首页缓存、附件 / 事项 / 条目草稿)会被孤立一次——预期行为。
- **自建中继**:只设 `remote_relay_url` 的自建者不受影响——v2 不会被隐式打开,链接照旧指向自建的老中继。
- **身份文件损坏**:`relay-identity.json` 损坏的 daemon 只跑老中继(日志 `relay v2 disabled this boot: relay_identity_corrupt`)。修好它,或有意删掉(= 新身份,手机要重新配对)。
- **不要双开**:绝不要让两个 daemon 用同一份 `relay-identity.json`——它们会互相顶掉(关闭码 4000,带退避)。
- **开关(首次运行前做完)**:先在 GitHub 建好环境 `relay-staging` 和 `relay-production`(后者要设 required reviewer = 主人,并把 deployment branch policy 限制为 dev / master),再设仓库变量 `RELAY_DEPLOY=on`(打开部署工作流);中继上线后再设 `RELAY_WATCH=on`(打开每小时巡检)。变量没设时两个工作流的作业是跳过状态,不会红、不会发邮件。
- **手机 app 的推送**需要:中继 v2 上线且 daemon 设了 `relay_v2_url`(否则 app 设置页显示「电脑还没用上 Tendhearth 中继」)、Worker 的 APNs / FCM secrets(第 4 节)。开发构建登记的是 `apns_sandbox`,TestFlight / 商店是 `apns`。

## 9. 通用链接 / App Links(plan 7a)

- Worker 在两个主机上都发 `/.well-known/apple-app-site-association`(appID `9Y6JAPDP7A.com.tendhearth.app`,只覆盖 `/pset`、`/pset/*`)与 `/.well-known/assetlinks.json`(`com.tendhearth.app`)。代码 `apps/relay/src/well-known.ts`。
- 安卓指纹:Play Console → 应用完整性 → 应用签名密钥证书的 SHA-256(EAS / 上传密钥的也加上),逗号分隔:`bunx wrangler secret put ANDROID_CERT_SHA256 --env staging`(production 同理)。格式必须是冒号分隔的 32 字节大写十六进制,畸形项会被丢掉。没设时 assetlinks 是 `[]`,安卓扫码照旧开网页壳。
- 自查:`curl -sI https://relay.tendhearth.com/.well-known/apple-app-site-association`(200、`application/json`、无重定向);`curl -s https://relay.tendhearth.com/.well-known/assetlinks.json`。Apple 走自己的 CDN 缓存 AASA,改完可能要等;开发构建可在设备「开发者 → 关联域名开发」里绕过。
