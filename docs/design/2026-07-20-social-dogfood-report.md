# 社交层实弹验证报告 + 下一步种子(2026-07-20)

> A+B+C(匿名笔友通道 / 内容盲信箱传输 / 转发预算)全量发布到 master 后的首次真机 dogfood。
> 参与机器:A = Mac 真 daemon(真微信);B = NAT 后的 Linux 工作站(headless,隔离 state)。

## 已上线的基础设施

- **中继**:`https://brain.youdamaster.cc/mailbox`(VPS systemd `mailbox-relay.service`,
  bun 单进程 + bun:sqlite,实测 ~11MB 内存;nginx `/mailbox/` 反代,8787 不裸露公网)。
  部署 runbook 见 `relay/README.md`。

## 验证通过(端到端,真机)

1. **外部 HTTPS 合约**:空 drop → 400 `invalid_body`;坏签名 fetch → 401(与设计逐字一致)。
2. **NAT 后的 poller 打卡真中继**:B 启动后 ~108s 发出签名 fetch → 200(120s±30% 窗口内)。
3. **模型调用 `social_seek`**(明确措辞后)→ seek 落库 `foraging` → A 跨 NAT(ssh 隧道)把意图卡
   投到 B 的 `/a2a/intent` → B 判官会话启动。跨 NAT 的 A2A 发现路径工作。
4. **信件全链路(核心验证,绕过判官直驱真模块)**:
   通道密钥 E2E 封信(`penpal-crypto`)→ 信箱密封(`mailbox-crypto` sealed-box)→ drop 真中继
   → **中继 sqlite 行仅 `{eph_pub,nonce,ct,tag}` 纯密文,明文/路由/bearer/channel_id 零泄露(内容盲实锤)**
   → B 的在线 poller 自动取回 → 信箱私钥解封套 → `getByMyChannelId` 命中 → 通道密钥解信
   → 明文只在 B 落库。**B+C 的信件传输在真实 NAT 机器间被证明。**

## 两个真发现(backlog)

1. **社交工具触达性差(affordance gap)**:微信里说「帮我发个心愿」,模型会**嘴上说发了但不调工具**
   (`social_seek` 存在、admin 也够,纯粹没伸手);要说「用 social_seek/调工具广播」才触发。
   真实用户不会这么说。→ 根治 = P4 派心愿显式命令(propose→confirm)。
2. **headless/无插件机器上的社交判官会卡住**:SESSION_INIT 后无子进程、无结果(该机手动跑 claude 正常)。
   一个 peer 的意图能触发挂死的判官 = 资源隐患。非 A/B/C 代码缺陷,环境向,待查
   (试验台留在 ws 机器上:`~/wcc-dogfood` + `WECHAT_CC_STATE_DIR=~/wcc-dogfood-state`)。

## 运维备忘(dogfood 中踩到的)

- state dir 有**两个**环境变量:daemon 主入口读 `WECHAT_CC_STATE_DIR`,`src/lib/config.ts` 读
  `WECHAT_STATE_DIR`——隔离部署两个都要设(值得统一,小 backlog)。
- daemon 启动要求 ≥1 个账号目录(`accounts/<id>/account.json` + `token`);headless 测试可用假账号
  (ilink 连不上只刷日志,不影响 a2a/social/信箱)。
- `pkill -f "bun cli.ts run"` 会自匹配远程 shell 的命令行——杀 daemon 用更精确的模式。
- Mac 真 daemon 由 launchd 管理(`com.wechat-cc.daemon`),重启用
  `launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon`。

## 通往用户:差距排序 + 已批准的下一步种子

用户旅程卡点(dogfood 亲测):**建边是手工 JSON 手术**(双方互换 url/密钥/信箱地址)→ 采用率咽喉。

**已批准的设计种子——「配对码 + 中继碰头」(下一局 brainstorm 开局):**

```
你:  对自家 bot 说「和老王配对」
bot: 「配对码 4839-21,发给老王,10 分钟内有效」
你:  微信里把码发给老王(一句话)
老王: 对他的 bot 说「配对 4839-21」
—— 以下全自动 ——
两边 bot 从码 HKDF 推导临时碰头信箱地址 + 加密密钥
  ↕ 经内容盲中继互投名片(url / mailbox_addr / enc_pub / 互发 bearer)
  ↕ 自动写好双方 agent-config → 各自回主人「连上了 ✓」
```

要点:零新基建(复用 B 的 drop/fetch/envelope);中继仍内容盲(名片用码推导密钥加密);
码一次性 + TTL + 限流(将来可升 PAKE);二维码/桌面按钮 = 同机制的皮。
自然延伸:配对拿到对方信箱地址后,**直接朋友的 seek 顺手也走信箱**(解直接朋友双 NAT 的发现,
比通用 discovery-over-mailbox 小得多)。

**优先级:配对码 → P4 派心愿(propose→confirm,设计已谈定)+ 一键开社交 → 桌面 v1.3.4 → 通用 discovery-over-mailbox。**
