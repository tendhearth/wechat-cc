# 模型与后端管理(现状)

> 2026-09-27 首版。设计依据 `superpowers/specs/2026-09-08-model-management-design.md`(SHIPPED);README 2026-09-22 搬空后这块没有任何现行文档。

## 六家后端

`src/lib/provider-ids.ts`:`claude codex cursor openai gemini agy`。微信里对应 `/cc /codex /cursor /api /gemini /agy`。加一家要碰的每份名单由 `scripts/provider-registry.guard.test.ts` 钉住。

| id | 形态 | 计费 | 备注 |
|---|---|---|---|
| `claude` | 进程内 SDK(`@anthropic-ai/claude-agent-sdk`) | 订阅(Claude Code 登录) | 工作台执行者;cheapEval 候选 |
| `codex` | 进程内 SDK / `codex app-server` | 订阅或 API key,daemon 不区分 | 工作台执行者 |
| `cursor` | 常驻 `cursor-agent acp` | 订阅 | 对话侧与工作台都走 ACP;`CURSOR_API_KEY` 的 SDK 路只剩对话侧回落。guest 不可用 |
| `openai`(`/api`) | 自跑循环,任何 OpenAI 兼容端点 | API key(`WECHAT_OPENAI_API_KEY`) | DeepSeek / Kimi / Qwen / 本地;外部 Agent 的官方接入路径;cheapEval 顺序第一 |
| `gemini` | 自跑循环,`@google/genai` | API key(`GEMINI_API_KEY`) | **deprecated**(2026-09-27):被 agy 取代,保留给已配 key 的用户,不加功能 |
| `agy` | 外挂 Antigravity CLI | 订阅(Google AI Pro) | 订阅版 Gemini;所有对话共用一把钥匙,guest 不可用;真 `--conversation` resume |

## 三个入口

1. **提示词身份行**:每轮系统提示写「你是 <provider>(当前模型 <model>)」,问「你是哪个模型」如实答,零工具零权限。
2. **微信 `/set` 与斜杠**(`src/daemon/mode-commands.ts`):
   - `/set cheap <provider|auto>`(管理员)—— 后台评估(整理记忆 / moderator / introspect)用哪家,走 config-surface 的 `cheap_eval_provider`,热改不重启;
   - `/set providers a,b|all`(管理员)—— 非管理员对话能用哪些;
   - `/set provider cc|agy|api|…`(管理员)—— 全局默认大脑,改完自动重启;
   - `/api list`(拉网关 `GET {base}/models`,主人主动触发才拨,60s 缓存)、`/api <别名|模型>`(只对本对话)、`/api alias ds=DeepSeek` / `/api unalias ds`、裸 `/api` 回全局默认;
   - `/cc <model>` 等按对话钉模型,同时忘掉该对话在这家的会话存档,下一句按新模型冷启动。
3. **面板「模型与后端」**(`/set` 图形面板,`src/daemon/settings-panel*.ts`):六家一行(注册 / 体检缓存 / 模型 / 未接入提示)、自配 API 表单(地址 / 默认模型 / key —— key 走 `llm-keys.ts`,不进日志)、短名增删、后台评估下拉。面板**绝不主动外呼体检**(封号红线)。

## bot 自己能换

- `model_get` / `model_set`(wechat MCP,`src/mcp-servers/wechat/tools-daemon.ts`):同家换版本 → `GET|POST /v1/model?provider=`(`routes-daemon-control.ts`),写完释放该家的活会话(缓存键无 model,不放就一直旧模型)。
- `provider_switch`(`tools-mode.ts`):换厂家,只动本对话 → `POST /v1/conversation/set-mode`(quiet)。ToolKind `mode_switch`,trusted 以上。
- 钉模型按对话存 `conversations.mode_model`(迁移 v44,不 COALESCE),coordinator 交给 `SessionManager.acquire`。

## 有意不做

`/model` `/use` 新动词(别名只对 `/api`);别名跨 provider;面板主动拨号。(设计稿曾写「gemini 的模型在面板只读」,实现里 `geminiModel` 和别家一样可改 —— `settings-panel.ts` 白名单含它;gemini 已弃用,不再收口。)
