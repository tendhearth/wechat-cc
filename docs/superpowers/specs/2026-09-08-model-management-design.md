# 模型与后端的统一管理(2026-09-08)

**状态:SHIPPED on `feat/model-management`(5 commits,295ebfd1..187841bd)**

## 问题

主人原话:「api 和订阅、cli 的方式有点乱乱的 …… 没有一个统一管理的地方。」

诊断:表面按品牌组织(`/cc /codex /cursor /api /gemini /agy`),约束按机制组织
(进程内 SDK / 外挂 CLI / 自己跑循环),计费按第三条线(订阅 vs API key),三套
坐标系叠在一起。架构本身**不动**(主人拍板);补的是「所有模型相关的事都在
一处」的面,以及让 bot 自己能答、能切。

## 决定(主人拍板)

| 问题 | 决定 |
|---|---|
| 统一管理放哪 | 设置面板「模型与后端」+ `/set` 快改双入口 |
| `/api` 一整面模型怎么输入 | 拉网关列表 + 自己起短名(别名只对 `/api`) |
| 钉模型范围 | 按对话(和 provider 切换同粒度) |
| bot 能否答「你是哪个模型」 | 能 —— 真相写进系统提示,零工具零权限 |
| bot 能否自己换模型/换后端 | 能 —— `model_set`(同家换版本)/ `provider_switch`(换厂家,只动本对话) |

## 落点

1. **提示词身份行**:`你是 claude(当前模型 claude-opus-5)` + 「问你是谁 → 如实答」。
   session-manager 先解 model 再建提示;bootstrap 的 `currentModelFor` 没钉时返回
   provider 实际默认值(与 providers.ts 注册字面量一致)。
2. **`/v1/model` 按 provider**:GET/POST 接受 `provider`(六家白名单);POST 写完
   释放该 provider 的活会话(缓存键无 model,不放就一直旧模型)。wechat-mcp 的
   `model_get/model_set` 默认传 `WECHAT_PARTICIPANT_TAG`。
3. **`Mode.solo.model`**(conversations v44 `mode_model`,不 COALESCE:`/api` 不带
   模型 = 回全局默认);coordinator 把它交给 acquire,同 provider 换钉时
   `releaseFor(provider, chat)`。`provider_switch({chat_id, provider, model?})` →
   `POST /v1/conversation/set-mode`(新 `quiet`),ToolKind `mode_switch` trusted+。
4. **`/api list|alias|unalias`**:网关 `GET {base}/models`(主人主动触发才拨,60s
   缓存,拨不通就说);别名存 `openaiAliases`;`/set cheap <p|auto>`(管理员)走
   config-surface 新键 `cheap_eval_provider`,注册表接 getter 热改。
5. **面板「模型与后端」**:六家一行(注册/体检缓存/模型/未接入提示)、自配 API
   表单(地址/默认模型/key —— key 走 `llm-keys.ts saveLlmKey`,和桌面共用,值不
   进日志/audit/state)、短名增删、后台评估下拉。

## 有意不做

- 新动词 `/model`/`/use`(主人:别名只对 `/api`);provider 命令照旧。
- 别名跨 provider;gemini(API key)的模型在面板只读(未进白名单,用得少)。
- 面板主动外呼体检(纪律:面板绝不自动 dial;通/不通只读缓存)。

## 真机验收

- 计划内重启静默:`[NOTIFY] skip startup notify: planned restart (self-restart-stale-code)`
  ✅(pid 35386 → 85155,微信无消息)
- 面板 HTML/JS:`new Function` 语法检查通过,九个新 id 全在,`f-model` 无残留 ✅
- `/v1/model?provider=`、`set-mode quiet`、面板 state/apply:单测覆盖;operator
  token 的 routeAllow 不含这些路由,活体调用留给主人下一句微信
- **待主人**:微信里问「你是哪个模型」/「换成 opus 5」/「用 DeepSeek」(需先配
  `WECHAT_OPENAI_API_KEY`);`/api list`;面板打开看「模型与后端」
