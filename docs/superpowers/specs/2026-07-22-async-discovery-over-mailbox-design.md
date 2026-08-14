# 全异步发现(discovery-over-mailbox + 同步回音退役)设计

**日期**: 2026-07-22
**状态**: 已批准(方案 C 直行:全网异步回音,老版本要求升级,无 proto 兼容分支)
**父级脉络**: `2026-07-18-anonymous-penpal-social-layer-design.md`(信箱传输不变量)、`2026-07-19-penpal-mailbox-transport-B-design.md`(narrow v0 把 discovery 留在 push-only)、`2026-07-15-async-foraging-spine-design.md`(row-driven 心愿状态机 = 本设计的底座)

## 背景与目标

seek→echo 目前是**同步 HTTP 请求/响应对**:心愿 POST 到对端 `/a2a/intent`,回音(MatchReceipt)在响应体里返回。两个后果:①双 NAT 的配对朋友永远收不到彼此的心愿(B 的 narrow v0 明确遗留);②接收方的判官在 HTTP 请求期间跑(冷启动 ~15s 实测),连接被挂着。

本设计一次治两个:**回音全面异步化**(fast-ack + 独立回程消息),intent 增加信箱传输(度一)。终态 = 单一异步语义,无同步/异步双路径分叉。

## 决策记录

- **方案 C 直行**(用户拍板"不如直接 C"+"老版本的让他们更新就好了"):不做 proto_version 兼容分支。老求方对新收方会收到空 receipt 且无法接收 `/a2a/echo`(404)→ 回音丢失。**要求全网升级,release notes 写明。**
- **信箱只覆盖度一**(用户拍板):2-hop 转发的传输仍是 push(W 需公网);但 2-hop 的**回程**被迫随同步 receipt 退役而异步化(§4)。

## §1 消息面

- **intent envelope**(`path:'/a2a/intent'`):心愿卡(IntentCard)走信箱。dispatch 层 `verifyBearer` 门,同 reveal envelope 先例——度一 = 配对好友,bearer 已互换。
- **echo 消息**(`path:'/a2a/echo'`):回音的独立回程,双入口喂同一 handler:
  - 新 HTTP 路由 `POST /a2a/echo`(a2a-server,bearer 验证,同 `/a2a/intent` 的验法);
  - envelope `path:'/a2a/echo'`(mailbox-dispatch 白名单新增,bearer 门)。
- body:`{ agent_id, intent_id, echo: { blurb, degree, relay_token? } }`。
- **回程地址永远查自己 registry 里该配对对端的记录**(信箱坐标有则信箱、否则 push url)——与 letters 的选路规则一致;绝不信任卡片/消息自带的回程地址(无伪造面)。

## §2 求方侧

- `broker.forage` 的 `send(hand, card)` 按对端记录分流:
  - 有 url → POST `/a2a/intent`(HTTP);响应现在只是 fast-ack,**不再读取回音**。
  - mailbox-only(pairing 产物,url 缺省)→ 封 intent envelope 投对方信箱。
  - 「问了 N 个」计数语义不变(发出即计)。
- **异步回音 intake**:把现有 MatchReceipt 处理里的回音落库逻辑抽成 `recordEchoFromPeer(senderAgentId, intentId, echo)` 共用:
  - blurb 过既有 sanitize;
  - echo 行 id 维持 `intent_id:agent_id` / relay 形态 `intent_id:agent_id:relay_token`;
  - **幂等**:同 id 已存在 → no-op(信箱 at-least-once 重投天然安全);
  - **过期**:对应 seek 不存在或 status ∉ {foraging, echoed} → 丢弃(迟到回音);
  - 首回音通知(既有三拍)照旧由落库路径触发。
- 心愿状态机零新增(async spine 已是 row-driven)。

## §3 收方侧(翻转)

- `/a2a/intent`(HTTP 与 envelope 同语义)一律**快速 ack**:`{ ok: true, async: true, echoes: [], forwarded: [] }`(保持骨架形状,老代码不崩、只是收不到内容)。
- 判官/匹配转后台(`void (async () => {...})()`,全 try/catch fail-closed):
  - 有匹配 → 按 §1 规则回投 echo 给 intent 的**已验证发送者**(bearer 对应的 registry 记录);
  - 判官失败/中途崩 → 无回音,与今天判官失败同语义;**不做持久化排队**(YAGNI)。
- 判官不在(headless)且 intent 来自信箱 → envelope 已被 ack 消费,该 intent 无回音;可接受(同上)。

## §4 2-hop 逐条异步中继

同步聚合(`MatchReceipt.forwarded[]` 等待收齐)随 sync receipt 退役。替代:**逐条异步中继**,无聚合等待:

- W 收到 S 的 intent(fast-ack S)→ 自己无匹配且 hop<2 → 照旧转发(hop+1)给自己的 peers(排除 S),传输仍 push。
- Q 的回音异步回到 W(`/a2a/echo`)→ W 查 `social_seen_intent` 发现这是**转发过的 intent** → 标 degree=2 + relay_token,按 §1 规则再转投给 origin(S)。relay_token/社交中继身份腿(`social_relay`)机制沿用现状。
- **migration v25**:`social_seen_intent` 加 `origin_agent_id TEXT`(nullable,intent 从谁来的)——W 重启后迟到的 Q 回音仍能找到回程。origin 为 null 的老行 → 回音丢弃(fail-closed)。
- 环路防护不变:hop cap + 不回传给 sender + seen-intent 去重。

## §5 兼容性

一刀切升级。老版本行为:向新收方撒心愿 → 空 receipt,永远无回音;收到新收方的 `/a2a/echo` POST → 404(发送侧丢弃,不重试)。**Release notes 必须写明"社交发现需全网升级到本版"**;下一次 dev→master PR body 里 surface(连同 route-tiers 里挂着的 trusted 评审旗)。

## §6 错误处理 / 测试 / 非目标

**错误处理**:后台判官任务全包 try/catch(fail-closed,无回音);echo 回投失败 = 丢,不重投(回音非信件,丢失可接受;重投 v2 再议);dispatch 对未知 path/坏形状维持现有 drop 语义。

**测试**:
- 双 store e2e:求方 forage → 收方 fast-ack → 后台判官 → 回音异步落到求方 echo 行(全 push 拓扑)。
- 信箱往返 e2e:mailbox-only 配对双方,intent envelope 去、echo envelope 回(复用 pairing integration 的假中继)。
- 2-hop 逐条中继:S→W→Q,Q 回音经 W 转投 S,degree=2 + relay_token 正确;origin 为 null 的老行丢弃。
- 幂等:同 echo 重投两次只落一行、只通知一次;迟到回音(seek closed)丢弃。
- fast-ack 形状:响应 echoes 恒空,判官慢也不阻塞响应(注入慢判官断言)。
- 回程选路:有信箱走信箱、否则 push(mirror letters 选路测试)。

**非目标**:2-hop 上信箱(W 仍需公网);回音重投/持久化排队;陌生人发现(仍限配对好友与其转发);proto 兼容分支;桌面 UI 改动(明信片区已消费 echo 行,自动受益)。
