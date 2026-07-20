# 配对码 + 中继碰头 — 设计 spec(建边自动化)

> 状态:设计定稿(2026-07-20 讨论,用户批准"只做配对"范围 + 显式命令入口)。
> 背景:dogfood 证明建边是采用率咽喉(手工 JSON 手术);种子见
> `docs/design/2026-07-20-social-dogfood-report.md`。落地计划由 writing-plans 另出。

## 0. 一句话

**两个微信好友各自对自家 bot 说一句话、在已有聊天里传一个 6 位码,两边 bot 经已部署的内容盲中继自动交换名片、写好双方配置——建边从"手工 JSON 手术"变成"蓝牙配对"体感。**

## 1. 用户体感(合约)

```
你:  「配对」            → bot:「配对码 483921,发给朋友,10 分钟内有效」
你:  (微信里把码发给老王——人唯一要做的传递)
老王: 「配对 483921」     → 两边 bot 自动握手(碰头信箱见 §4)
两边 bot:「和 <对方名字> 的 bot 连上了 ✓ 现在可以互相觅食/写信了」
```

- 错码/过期:「码不对或已过期,让朋友重新生成一个」。
- 发起方超时(10 分钟无人接):「配对码过期了,没等到朋友——要再来一次说"配对"」。
- 入口 = **显式文本命令**(管道层解析,同 揭晓/回信 一样确定,不依赖模型自觉)+ CLI `wechat-cc pair [code]`。桌面按钮/二维码 = 后续同机制套皮(非本期)。

## 2. 唯一身份(前置修复,本期内)

现状缺口:每台 daemon 自报 id 默认 `WECHAT_A2A_SELF_ID || 'wechat-cc'` ——两个 peer 都自称
`wechat-cc` 时注册表按自报 id 查密钥直接撞车(dogfood 实测,手动改 env 才绕开)。

修复:**每台 daemon 一个稳定唯一 slug**:
- 生成:首次需要时 `cc-` + 信箱地址(Ed25519 addr)SHA-256 的前 8 个 hex(信箱密钥稳定 ⇒ slug 稳定);
- 持久化:写入 `agent-config.json` 新 optional 字段 `self_agent_id`;
- 解析顺序:`WECHAT_A2A_SELF_ID` env(兼容现状)> config `self_agent_id` > 生成并写回;
- 用途:随名片交换;对方以它为注册表 id;所有出站 a2a 消息以它自报(替换 wire-social 里的 SOCIAL_SELF_ID 常量解析)。

## 3. 配对码

- **6 位数字**,展示为 `483921`;一次性;**TTL 10 分钟**。
- 安全账:在线暴力 = 10^6 空间 × 中继既有 per-IP 限流 ⇒ 10 分钟内不可行;码在好友私聊里被偷看 ⇒ TTL 内可被劫持——**接受**(私聊即信任边界;这与"熟人建边走带外"的父 spec 立场一致);升级 PAKE = v1 加固,协议位置留好(码只进 HKDF,换 PAKE 不改消息形状)。

## 4. 碰头机制(零改中继)

**核心:双方从码推导同一对确定性密钥,把已部署的中继当碰头信箱用。**

- 推导:`seed = HKDF-SHA256(ikm=code, salt='wcc-pair-v1', info='rendezvous')`(**固定参数**——不掺 relayUrl:双方配置的 URL 串未必逐字节一致,掺入会静默失配)→ 拆出
  Ed25519 种子(碰头信箱身份:地址 = 其 pubkey,fetch/ack 签名密钥)+ X25519 种子(封套加密目标)。
  实现注:node:crypto 从 32 字节裸种子构造密钥 = 拼 PKCS#8 DER 前缀 + seed(已知稳定技法,单测锁定)。
- 协议(全用现有 drop/fetch/envelope 原语,中继无感知、照旧内容盲):
  1. 发起方:生成码 → 推导密钥 → `sealEnvelope(CardI, 碰头encPub)` → drop 到碰头地址 → 开始轮询(~10s 一次,至多 10 分钟);
  2. 接受方(收到「配对 <code>」):推导同样密钥 → fetch(用推导的签名钥)→ 解出 CardI → 校验角色 → drop CardA → 写本地配置(§6)→ 通知主人;
  3. 发起方轮询到 CardA → 写本地配置 → 通知主人 → 停止轮询(码作废)。
- **不 ack**(共享信箱,ack 是全局删除会互相踩;靠 10 分钟 TTL 清理);名片带 `role`(initiator/acceptor)+ 随机 nonce,各自忽略己方名片。
- **同中继前置条件**:双方必须使用同一个碰头中继——v0 约定用各自 `mailbox_relays[0]`,且装机默认值即内置中继(brain),因此默认场景天然满足;自建中继的用户需两边一致(文档写明)。多中继协商 = v1。
- 残余风险:知道码的第三方可在 TTL 内抢答/替换名片(race)——同 §3 接受,PAKE 后收口。

## 5. 名片(Card)

```json
{ "v": 1, "role": "initiator|acceptor", "nonce": "<random>",
  "self_id": "cc-a3f92b", "name": "<bot_name 或主人设置的名字>",
  "url": "<a2a_listen 可达地址,可缺省>",
  "mailbox_addr": "...", "mailbox_enc_pub": "...", "relays": ["https://brain.youdamaster.cc/mailbox"],
  "bearer": "<我为对方铸的密钥:对方今后向我发消息时用>" }
```

- bearer 语义:各自铸一把发给对方 → 接收方存为该 peer 的 `outbound_api_key`,铸造方存为该 peer 记录的 `inbound_api_key`——一来一回密钥对自动成型。
- 名片整体经 `sealEnvelope` 密封(中继只见密文)。

## 6. 落库(收到对方名片后)

写 `a2a_agents` 一条 `A2AAgentRecord`:
`{ id: peer.self_id, name: peer.name, url: peer.url(可缺省,见下), transport: 'mailbox',
   inbound_api_key: <我铸的>, outbound_api_key: peer.bearer, capabilities: [],
   mailbox_addr / mailbox_enc_pub / relays: 名片值 }`

- **schema 改动(本期内)**:`A2AAgentRecord.url` 在 `transport === 'mailbox'` 时**可选**
  (纯 NAT 用户没有公网 url;现 schema 强制 `z.string().url()`)。zod superRefine 保证
  push/ws 记录仍必填 url。
- **重复配对** = 刷新:若已存在同 `self_id` 记录,整条覆盖(密钥轮换的天然入口)。
- 配对完成即普通 a2a peer:可被觅食转发触达(C 的转发预算管滥用),觅食台 §③ 自动出现。

## 7. 入口与路由

- **微信命令**(管道层,mirror 揭晓/回信 的解析+分发):`配对` → 发起;`配对 <6位数字>` → 接受。管理员专属(admin chat)。
- **CLI**:`wechat-cc pair`(发起,打印码)/ `wechat-cc pair <code>`(接受)。经 internal-api 新路由
  `POST /v1/pair/start` / `POST /v1/pair/accept`,**tier = trusted**(与 reveal 同理:internal-api 仅
  127.0.0.1、file token 0600 属主人;CLI 无 admin 令牌是既有现实)。发布时照例把 tier 决定亮出来 review。
- 配对执行体在 daemon 内(需要 mailbox client、config 写、registry、通知主人)。

## 8. 超时/边界

- 发起方轮询任务有界(10 分钟),daemon 重启不恢复(码作废,重新来——一次性语义的自然结果,不做持久化)。
- 同时只允许一个进行中的发起码(再说「配对」= 作废旧码换新码)。
- 接受方码错/过期(fetch 无 CardI)→ 友好提示,不重试。
- 自己配自己(两边同一 daemon/同一 self_id)→ 检测并拒绝。

## 9. 测试策略

- **推导确定性**:同码同 relayUrl 两次推导逐字节相等;不同码不同;PKCS#8 seed 包装能被 node:crypto 接受(签名/解封回环)。
- **名片回环**:seal→open,角色/nonce 过滤,bearer 双向落位正确(A 的 outbound == B 的 inbound,反之亦然)。
- **完整配对集成测**:两套 config/store + 进程内中继(复用 relay 的 fetchHandler 测试法),发起→接受→双方 registry 各多一条正确记录 + self_id 互指 + url-less mailbox 记录合法。
- **命令解析**:「配对」/「配对 483921」/非命令不拦截;CLI 两形态;internal-api 路由 tier。
- **e2e 手动验收**:线上真中继 + ws 试验台(现成)跑一次真配对。
- **schema 回归**:url-optional 只对 mailbox 生效;旧 config 照常解析。

## 10. 明确不做(本期)

- 异步发现(seek→echo 走信箱)——独立下一期(同步应答改异步,体量大)。
- PAKE / 防中继离线爆破加固;二维码/桌面按钮皮;多中继协商;配对撤销(删 peer 走既有 remove);
  非管理员发起配对。
