# 中继搬上 Cloudflare + 推送(手机 app 子项目 2)设计

日期:2026-09-30。状态:设计稿,主人已在对话中逐节批准(三节设计 + 一版白话复述)。基线 origin/dev 410c6581。

## 0. 这件事解决什么(白话)

主人的 CC 住在主人自己的电脑上。手机在外面要找到它,中间得有个传话的 —— **中继**:手机把话交给中继,中继转给家里的电脑,回话原路送回。子项目 1 已经把「话怎么加密、怎么说」定好了(`packages/protocol`,协议 v2);这一步修「路」:

1. 中继现在是为主人一个人搭的,跑在一台兼着别的活的小服务器上;给陌生人用,一挂全挂。
2. 中继不认人:知道「门牌号」(daemon id)的人就能冒充家里的电脑把它挤下线(内容看不了,但能捣乱)。
3. 中继不会叫醒手机:app 关着时,CC 想说「任务做完了」「有操作等你批准」没有办法。

三件事:**把中继搬到 Cloudflare**、**让中继认得出真正的家里电脑**、**能给手机发加密通知**;顺带加上面向陌生人必须有的限额与防护。

## 1. 已定的决定(主人 2026-09-29 / 30)

- 手机 app:Expo 双端、海外上架、定位「住在你自己电脑上的个人 AI,也能替你指挥编码 agent」;微信只是获客通道(见子项目 1 设计稿 §0)。
- 中继:官方托管、默认免费、允许自托管,给以后「官方中继进订阅」留余地。
- **托管:Cloudflare Workers + Durable Objects。** 全球边缘就近接入;每个 daemon 一个 Durable Object(「房间」);WebSocket 休眠让空闲连接几乎不花钱;主人已在用 Cloudflare(R2、钥匙串里的凭据)。
- **范围:只搬手机隧道 + 推送。** 社交层的 mailbox(笔友信箱、6 位配对码)留在 VPS,另立子项目,它自己的安全债(配对码可离线枚举、全局限流、写入无上限)跟着它走。
- **身份:匿名、基于密钥。** 中继不存名字、邮箱、账号,只存 daemon 公钥、推送 token、用量计数。

已核实:APNs(只说 HTTP/2)**在生产 Worker 上可用** —— Cloudflare 边缘替 Worker 跟 Apple 说 HTTP/2,有现成库 `cloudflare-apns2`;**本地 workerd 在 macOS 上发不出**(workerd#4841,仅本地运行时的问题),所以本地测试用假 APNs。FCM 是普通 HTTPS,无此限制。

## 2. 现状(410c6581)

- `relay/server.ts`:单个 Bun 进程,同时服务隧道(`/tunnel/daemon?id=`、`/tunnel/phone?id=`)与 mailbox(`/drop` `/fetch` `/ack`);部署在 195.133.192.92(`cc.tendhearth.com`,nginx 反代,Cloudflare Full 自签证书),与代理出口节点、tailnet DERP 同机;手工部署;无健康检查、无监控、无备份;`relay/README.md` 的部署章节已过时。
- `relay/tunnel.ts` `makeTunnelHub`:按 daemon id 配对,包 `{stream, frame}`,每条手机流令牌桶(突发 120、每秒 20),单帧 512 KiB,超限**静默丢弃**;daemon 侧帧不限速。
- daemon 侧:`tunnel-id.json` 里是随机 id(`'t' + 18 字节 hex`),连中继时只带 `?id=`,**不向中继证明身份**;`pipeline-deps.ts` 默认 `wss://cc.tendhearth.com/tunnel/phone`,daemon 端 URL 由它替换得来。
- 推送:`packages/protocol/src/push.ts` 有 `derivePushKey` / `sealPush` / `openPush`;`src/daemon/phone-topic-sources.ts` 有 `PhoneNotify` 出口,目前是空函数,没有任何调用方。

**对陌生人开放前必须解决的问题**
1. **daemon id 劫持**:任何知道 id 的人(每台配对过的手机、看过设置链接的人)都能 `/tunnel/daemon?id=X` 把真 daemon 顶掉(`tunnel.ts:72`)。
2. **僵尸 socket bug**:旧 daemon socket 迟迟关闭时,close 处理不核对是不是当前 socket,会把新注册删掉、踢掉所有手机(`server.ts:119`、`tunnel.ts:76-86`);攻击者连上再断开即可复现。
3. **限流在代理后变全局**:`requestIP` 拿到的是代理地址。
4. **一切无上限**:连接数、每 daemon 手机流数、daemon 帧速率、限流表都无界。
5. **静默丢帧**:限流 / 超大帧时手机只能等超时。
6. 无推送发送方。

## 3. 组成

新目录 **`apps/relay`**:Cloudflare Workers 项目(TypeScript,`wrangler.toml`),复用 `@wechat-cc/protocol` 的类型与 base64 工具;**不解密任何东西**。

1. **入口 Worker**:路由
   - `GET /v2/daemon` —— daemon 的 WebSocket(升级后先做挑战登录,见 §4);
   - `GET /v2/phone?id=<daemonId>` —— 手机的 WebSocket;
   - `GET /pset/` —— 手机网页的公网壳页(静态资源,由 `relay/pset.src.html` 生成的同一份);
   - `GET /healthz` —— 版本号 + 自检;
   - 其余 404。
2. **房间(Durable Object,每个 daemon id 一个)**:持有这台 daemon 唯一的 WebSocket 与连进来的手机流;沿用今天的 `{stream, frame}` 包装转发,daemon 端隧道代码改动最小;用休眠 API,靠 socket attachment 记住每条手机流的 stream id;执行 §6 的限额。
3. **推送发送(在同一个房间里)**:房间存储里放这台 daemon 登记的设备推送 token 与每日配额计数,负责调 APNs / FCM(§5)。

**手机不需要新身份**:手机仍然只知道 daemon id;真正的鉴权依旧是子项目 1 的端到端加密(密钥绑定设备令牌,令牌从不经过中继)。

## 4. daemon 身份与登录

- daemon 首次运行生成 **Ed25519 密钥对**,私钥存状态目录(0600);`relay-identity.json` 与现有 `tunnel-id.json` 分开。
- **daemon id** = `'r' + base32(sha256(公钥原始 32 字节))` 的前 26 个字符(小写,URL 安全)。以 `r` 开头与老的 `t…` id 区分。
- 登录:WebSocket 建立后,房间发 `{challenge: <32 字节随机 base64url>, ts}`;daemon 回 `{pub, sig}`,签名内容 = UTF-8 `wechat-cc/relay/v2/login:<challenge>:<daemonId>`;房间核对签名,并核对 id 确实由该公钥派生;10 秒内没完成登录 ⇒ 关连接。
- **同一 id 的第二条已认证连接替换第一条**(daemon 重连是常态);关闭处理**只删除确实是当前的那个 socket**(修掉僵尸 socket bug)。
- 公钥由房间第一次见到时记住;以后同 id 必须是同一把公钥(id 由公钥派生,天然一致)。
- 丢了私钥 = 换了一台新「电脑」:新 id,手机要重新配对。备份交给主人的状态目录备份,中继不托管。

## 5. 推送

**登记**
1. app 拿到 APNs token(iOS)或 FCM token(安卓)。
2. 经端到端隧道交给自己的 daemon:新手机路由 `POST /m/api/push/register {platform: 'apns' | 'fcm', token}`(登记进 `PHONE_ROUTES` 与接口 schema)。
3. daemon 经自己已认证的 socket 转给房间:`{push_reg: {device, platform, token}}`;房间按 daemon 的设备 id 存下。
4. 撤销 / 全部忘掉设备 ⇒ daemon 同时发 `{push_unreg: {device}}`。

**发送**
1. 需要主人的事发生时(待批准的权限、待回答的问题、任务完成 / 失败),daemon 的 `PhoneNotify` 触发;**正在用实时订阅连着的手机不发**,免得重复。
2. 组一段小载荷 `{ts, kind, title, body, taskId}`,截断到封装后不超过约 3 KB(APNs 上限 4 KB)。
3. 用该设备的推送密钥(`derivePushKey`,子项目 1)`sealPush`,发给房间:`{push: {device, sealed, collapseId}}`,`collapseId` 按任务,同一件事的更新互相覆盖而不是堆起来。
4. 房间查 token 并调用:
   - **APNs**:alert 推送,`mutable-content: 1`,中性的占位文字(「CC 有新动态」),加密块放自定义字段;手机上的通知扩展本地解密后换成真正的标题和正文。JWT 用 APNs 认证密钥(`.p8`,Team `9Y6JAPDP7A`)在 Worker 里签。
   - **FCM(HTTP v1)**:data message 带加密块;安卓 app 的消息服务解密后显示。用服务账号签 OAuth token。
5. 苹果 / 谷歌说 token 失效(APNs 410、FCM `UNREGISTERED`)⇒ 房间删掉登记并告诉 daemon `{push_invalid: {device}}`。
6. 结果回给 daemon:`{push_result: {device, ok, code}}`,daemon 记一条日志,不重试失效 token。

**中继与苹果 / 谷歌看得到的**:设备 token、时间、一个加密块;**看不到内容**。

**凭据(主人各做一次)**:在 Apple Developer 后台建 APNs 认证密钥(`.p8`,与已有的 App Store Connect 密钥不同);建一个 Firebase 项目给安卓推送。两者都进 Cloudflare Worker secrets,绝不进仓库。

## 6. 限额与防护

按 daemon 公钥,在房间里执行:
- 同时 1 条 daemon 连接、最多 16 条手机流;
- 单帧 512 KiB;每条手机流 每秒 20 帧、突发 120(同今天);**daemon 帧也限速**(每秒 200、突发 1000);
- 每天 500 条推送;
- 每天流量 1 GB,超了当天拒绝新的手机流。

入口 Worker:按 IP 限制连接尝试(Cloudflare 自带的限流规则;在 Cloudflare 后面能拿到真实客户端 IP,修掉「全局限流」)。

**显式错误**(明文,发完再关):`daemon_offline`、`frame_too_large`、`rate_limited`、`quota_exceeded`、`too_many_streams`、`login_failed`。协议客户端(`packages/protocol/src/client.ts`)认识这些码:`rate_limited` / `quota_exceeded` 退避更久,`frame_too_large` 让该请求立刻失败而不是超时。

## 7. 运维

- **两个环境**:`relay-staging` 与生产,各自的域名(如 `relay-staging.tendhearth.com`、`relay.tendhearth.com`)与 secrets。
- **部署**:CI 里 `wrangler deploy`;生产部署挂在与桌面发版同样的审批环境后面;staging 在 dev 上改了 `apps/relay/**` 时自动部署。
- **健康**:`/healthz` 返回版本与自检。
- **指标**:Cloudflare Workers Analytics 只记连接、帧、推送、各错误码的**计数**,不记 daemon id。daemon 不再把 id 放进 URL(改为在 socket 里登录);手机的 URL 仍带 `?id=`,所以 Worker 日志与采样一律不保留 query string。
- **报警**:错误率或推送失败率突增时,Cloudflare 通知发到主人邮箱。

## 8. 过渡

- 过渡期 daemon **两边都连**:老 VPS 中继(`cc.tendhearth.com`,服务已配对的手机网页)+ 新 Cloudflare 中继(新配对与 app)。
- 新生成的设置 / 配对链接指向新域名;新中继的 `/pset/` 壳页连新中继。
- 老中继的隧道部分在过渡期结束后关掉(过渡期长度与关闭时间由主人定,不在本项目内执行);mailbox 继续留在 VPS。
- agent-config 新增 `relay_v2_url`(缺省生产新中继),老的 `remote_relay_url` 保持原义。

## 9. 测试与验收

1. **中继单元测试**:vitest + `@cloudflare/vitest-pool-workers`,在本地跑真实的 Worker 与 Durable Object;APNs / FCM 用本地假服务器(本地运行时连不了 APNs)。覆盖:挑战登录(正确 / 错签名 / id 与公钥不符 / 超时)、同 id 替换与僵尸 socket 不踢新连接、手机流转发、每项限额与对应错误码、休眠后 stream 映射恢复、推送登记 / 发送 / 失效 token 清理 / 每日配额。
2. **daemon 侧**:密钥生成与 id 派生、登录签名、双连接(老 + 新中继)、推送登记与发送、订阅在线时不重复推送;端到端测试接本地 Worker 跑一遍:登录 → 手机连 → 推送到达假 APNs → 同 id 重连不踢新连接。
3. **协议客户端**:新错误码的处理。
4. **真机自检**:`wechat-cc selftest phone --relay v2`,对 staging(之后生产)跑:登录、配对一次性设备、v2 事件、**一条真推送被 APNs 接受**(没有真手机,只核对被接受),最后撤销。

**算做完**:
- staging 与生产都部署,`/healthz` 正常;
- `selftest phone --relay v2` 在生产 PASS;
- 已配对的手机网页经老中继照常可用(过渡期);
- 全量测试(bun / node)、类型检查(看退出码)、depcheck、CI 三平台绿。

## 10. 不做

- mailbox / 社交层的搬迁与其安全债(另立子项目)。
- 完全下线 VPS。
- 账号与付费。
- 手机 app 本身(子项目 3);灵动岛 / 小组件(子项目 4)。
- 中继多区域冗余之外的自建容灾(Cloudflare 自身即多区域)。

## 11. 交接

- 触碰:新 `apps/relay/`;`src/daemon/tunnel-client.ts`(登录、双连接)、新 `src/daemon/relay-identity.ts`、`src/daemon/wiring/pipeline-deps.ts`(接线、`PhoneNotify` 真实实现)、`src/daemon/settings-panel.ts` + `phone-routes.ts` + `packages/protocol/src/api.ts`(推送登记路由)、`packages/protocol/src/client.ts`(错误码)、`src/cli/selftest-phone.ts`(`--relay v2`)、`src/lib/agent-config.ts`(`relay_v2_url`)、CI 工作流、文档。
- **主人要做的**:APNs 认证密钥、Firebase 项目、Cloudflare 上两个域名 / Workers 付费计划(Durable Objects 需要 Workers Paid,$5 / 月起)。
- 实施计划另出(writing-plans)。
