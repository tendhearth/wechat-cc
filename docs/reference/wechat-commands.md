# 微信命令(现状)

> 2026-09-27 按代码重写。旧表里的 `/status` `/ping` `/users` `/project *` `@all` `@<name>` 早已不存在(源码 0 命中)。事实源:`src/daemon/mode-commands.ts`(`KNOWN_SLASH_COMMANDS` + `/help` 文案 + `SET_USAGE`)与 `src/daemon/admin-commands.ts`(正则常量)。`/help`(或 `/帮助`)在聊天里给的就是这份的实时版,按你的档位裁剪。索引见 [docs/INDEX.md](../INDEX.md)。

## 所有人(guest 只有身份 / 拆分 / 文件三组)

| 命令 | 效果 |
|---|---|
| `/help` `/帮助` | 按你的档位列出可用命令 |
| `/whoami` | 你的身份 + 当前模式 |
| `/name <昵称>` | 设置 / 改昵称(按对话) |
| `/cc` `/codex` `/cursor` `/api` `/gemini` `/agy` | 单 provider(solo);`/api` = 你配置的 OpenAI 兼容后端;可带模型名(`/cc opus`)按对话钉模型。`/agy` `/cursor` guest 不可用;`/gemini` 已弃用(用 `/agy`) |
| `/api list` · `/api <别名\|模型>` · `/api alias ds=DeepSeek` · `/api unalias ds` | 看网关模型 / 切(只对本对话)/ 起短名 / 删短名 |
| `/cc + codex` | Claude 主答、Codex 当工具(primary_tool) |
| `/both [p1 p2 …]` `/parallel` | 并行回复(裸 = 全部 provider) |
| `/chat [p1 p2 …]` | 圆桌讨论(chatroom) |
| `/solo` `/stop` `/mode` | 回到默认 / 退出多方模式 / 显示当前模式 |
| `/set split on\|off`(拆分 开\|关) | 回复像真人一样分几条发 |
| `/set care off\|low\|high`(关心 关\|低\|高) | 主动关心档位 |
| `/set stickers on\|off`(表情 开\|关)· `/set hunt on\|off`(打猎 开\|关)· `/set visit on\|off`(串门 开\|关) | 表情包 / 每日打猎 / 串门 |
| `/set` | 图形设置面板链接(手机上点开) |
| 拖图片 / 文件 / 语音 | 直接发即可;语音在配了 STT 网关时转成文字 |

## 管理员

| 命令 | 效果 |
|---|---|
| `/health` · `/health ai` | bot 健康 / 各 provider 会话状态(零 token 零网络) |
| `/reset` `/重置` | 丢掉本对话所有 provider 的会话,下一句从头开 |
| `/update` | 拉代码重装重启(源码模式) |
| `/botname [名字\|跳过]` | 设 / 看 / 清 bot 自称 |
| `/set cheap auto\|claude\|agy\|openai\|…` | 后台评估用哪家(热改) |
| `/set providers claude,openai\|all` | 非管理员对话能用哪些 provider |
| `/set provider cc\|agy\|api\|…` | 全局默认大脑(改完自动重启) |
| `/hearth ingest\|list\|show\|apply\|help` | vault 治理(hearth 启用后) |
| `整理记忆` `/synthesize` · `看记忆` `/overview` `你对我的理解` | 重新整理 / 读回 CC 对你的理解 |
| `清理 <bot-id>` `清理 all-expired` | 清理过期 bot |
| `让<手名><任务>` `派<手名><任务>` · `/hands` | 派活给已配对的「手」/ 列出手(按已注册的手名认,不按动词) |
| 粘一串 `WCCP1…` 配对码,或 `/hand <码>` `/配对 <码>` | 加一台手 |
| `/bag` `背包` `猎物` | 打猎战利品 |
| `自改 <需求>` · `自改 状态\|列表` | 让 CC 自己改自己(五道闸门 + 微信拍板,见 [maintainer/self-change.md](../maintainer/self-change.md)) |
| 回复权限卡 `y <码>` / `n <码>` | 放行 / 拒绝一次工具调用(只认被问的那个 chat) |
| `任务 …` | 工作台编号命令,见 [cc-workbench.md](../cc-workbench.md#离开电脑后从微信继续);也可以直接用自然语言指某件事 |

陪伴与记忆用自然语言:`开启陪伴` `别烦我` `切到 <alias>` 等。自检与自愈也是自然语言(「你怎么不回消息了,检查下」):它能查每回合结局、看会话是否卡住、释放会话 / 切模型 / 重启 daemon,每步回读确认;这些工具 admin-only,daemon 侧按 tier 二次把关(非 admin 拿 token 直调路由也是 403)。
