# 全异步发现升级说明(需全网升级)

> **日期:** 2026-07-22 | **实现计划:** `docs/superpowers/plans/2026-07-22-async-discovery.md`

## 本版改变

### ① 全网升级要求 —— 求方版本对齐

**本版起,社交发现(`seek` → `echo`)全面从同步聚合改为异步流程。**

**关键变化:** 收方不再在 HTTP 响应里返回回音(`MatchReceipt.forwarded[]`),而是异步提交一条 `/a2a/echo` 消息。

**升级影响:**

- **新求方(v2)** 向 **旧收方(v1)** 发送心愿 → 旧收方返回空 `MatchReceipt(forwarded: [])` → 新求方把 `async: true` 标记放在 fast-ack 里,继续等待后续 `/a2a/echo` → 永远收不到(v1 从不投 echo 消息) → **心愿无回音**

- **旧求方(v1)** 向 **新收方(v2)** 发送心愿 → 新收方快速返回 `{async: true}` → 旧求方不识别 async 标记,当成 no-match → **心愿无回音,且不会后续检查**

**结论:** 所有节点必须同时升级。混版本对等中,任何一方还跑 v1 都会收不到回音。建议滚动升级时**先灰度跑新版本,验证社交发现仍能工作后(通过 echo intake 落库而非同步 receipt),再全面切换**。

### ② 信箱支持 —— 度一朋友现在能互相收到心愿

本版开放了**信箱配对好友**的`seek` 转发权(之前只有 url 可达的对等):

- `discover()` 时不再过滤掉 url-less mailbox 对端,**度一配对的朋友现在是 forage 的候选人**
- `seek` 和 `echo` 消息都可以通过 **mailbox envelope**(密封 + bearer 门) 往返
- 无公网(NAT 后只有 mailbox)的朋友之间现在**能互相收到心愿**了

**NAT 容忍度一 —— 从推送限 2-hop 变成完整支持:**

- 求方可通过 mailbox 投递 seek → 收方用 mailbox 回投 echo
- 转发链(2-hop)时,中间人(W)也能通过 mailbox 往返,**不需要公网 IP**
- 回音回程仍按发送者的 registry 记录选路(mailbox or push HTTP)

**结果:** 之前躲在 NAT 后的用户组现在能**完整收发心愿,包括 2-hop 中继**。

### ③ 发布审核需求 —— Trusted 定级旗

本版落地了**求方热源审核**(trusted 定级),与全网升级同步对齐:

`src/daemon/internal-api/route-tiers.ts` 里的 `RELEASE-REVIEW FLAG` 标记了本次升级涉及的敏感分级检查。下次 `dev → master` PR body 必须包含:

```
## 社交发现升级(需全网公告)

- 本版 A2A_PROTO_VERSION bump 到 2(旧 v1 节点无法接收回音)
- 求方热源受信评审(trusted 定级)启用
- 信箱度一转发权放开;relay 一腿防环保持

**发布前检查:** route-tiers.ts 里的 RELEASE-REVIEW FLAG
```

---

## 技术底座回顾(Task 1-9)

| 部分 | 内容 | 关键文件 |
|-----|------|--------|
| **消息** | `EchoMessage` 异步回音 + `A2A_PROTO_VERSION = 2` | `src/core/a2a-intent.ts` |
| **求方** | `makeEchoIntake` 的幂等落库 + `applyFinishSeek` 状态机 | `src/core/social-echo-intake.ts` |
| **收方** | `makeAsyncResponder` fast-ack + 后台判官/回音 | `src/core/social-async-responder.ts` |
| **中继** | `makeEchoHandler` 双角色(自家 intake / 转发铸腿) | `src/core/social-echo-relay.ts` |
| **网络** | `/a2a/echo` HTTP 路由 + envelope 白名单 | `src/core/a2a-server.ts`, `src/core/mailbox-dispatch.ts` |
| **DB** | `social_seen_intent.origin_agent_id` v25 迁移 | `src/lib/db.ts` |
| **接线** | wire-social 换轨 async responder 与 handler | `src/daemon/bootstrap/wire-social.ts` |
| **测试** | 三拓扑 e2e(push / mailbox / 2-hop relay) | `src/core/social-async.e2e.test.ts` |

---

## 回归清单

- ✓ `grep -rn "makeForwarder" src/` → 零命中(旧同步聚合器全删)
- ✓ `grep -rn "recordEcho\|finishSeek" src/core/social-broker.ts` → 零命中(deps 已删)
- ✓ `EchoRecord` 类型保留导出(intake 消费)
- ✓ Proto 注释已含升级要求(Task 1 写入)
- ✓ `bun run test` 全绿 + `bunx tsc --noEmit` 干净(除已知桌面测试基线)
- ✓ 双回程选路(mailbox/HTTP)统一通过 `postToPeer` 注入

---

## 后续关键词

- **resume 7 天线:** 超 7 天未回音的心愿在下次 resume 中标记 closed(无自动 close 特性)
- **reveal 零感知:** social_relay 行的形状与旧同步路径**逐字节一致**,reveal 解密无改动
- **2-hop 一腿防环:** relay_token 单腿存在,已有 token 的回音不再二次中继
