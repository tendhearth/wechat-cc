# 工作执行者能力准入

2026-09-13。当前目标授权持续推进，不打断用户重复确认。此切片只解决工作台接入契约，不把 Cursor / agy 现有聊天适配器直接开放为项目执行者。

## 用户结果

用户选择执行者后，CC 能诚实地说明并执行本次任务：权限在任务内处理，停止要等执行资源退出，恢复必须保持原会话身份，提交的材料和设置不能被静默忽略。聊天里配置了某个模型，不代表它已经能安全管理项目。

现有两栏与完整对话保留。不新增能力配置表；执行者设置中只按需说明接入边界。没有可用执行者时，说明需要连接支持工作任务的执行者，不声称电脑上没有安装程序。

## 选择与边界

继续按名字允许 Claude / Codex，不能防止同名的旧聊天适配器误接入；直接开放注册表所有 provider 则会放行没有确认停止和任务权限的适配器。采用代码注册时的显式工作台契约，业务准入根据契约，不根据品牌名。

此声明是适配器开发者承担的协议责任，仍需原生验收；不是操作系统沙箱或能力自动检测。配置文件、用户表单和模型返回值不能自行开启它。

## 契约

新增 `src/core/workbench/executor-capabilities.ts`。`ProviderRegistration.workbench` 为可选 `WorkbenchExecutorCapabilities`：

```ts
interface WorkbenchExecutorCapabilities {
  version: 1
  permissions: 'task'
  configuration: 'task-policy'
  completion: 'native'
  stop: 'confirmed'
  background: 'tracked' | 'disabled'
  features: {
    nativeResume: boolean
    attachments: boolean
    executionSettings: boolean
    modelCatalog: boolean
  }
}
```

必需字段缺失或值不符，不可从工作台发起任务。`configuration` 表示工作任务排除陪伴凭据、自动钩子及未准入工具，并明确保留项目规则；不承诺文件系统隔离。`background: disabled` 必须在原生执行者禁止后台启动，不能丢掉后台事件；`tracked` 必须跟踪到真实退出。

`MANAGED_NATIVE_CAPABILITIES` 是本次两个专用适配器的注册配置，四个 feature 为 true、background 为 tracked。只在 `wire-workbench.ts` 和隔离开发/原生验收脚本中为专用 Claude SDK / Codex app-server 接入设置；不修改普通聊天执行者的声明。

纯函数 `isWorkbenchExecutorCapabilities(value: unknown)` 严格核对字段，`requireWorkbenchInput(capabilities, {attachments, execution, resume})` 在任何持久化或分派前拒绝不支持的请求。`attachments` 非空需要对应 feature；显式 model / reasoningEffort 或 native defaults 需要 executionSettings；resume 需要 nativeResume。`modelCatalog` 单独控制查询，不以是否存在方法猜测。

## 服务集成

- 服务列表、默认选择、微信项目目录只取显式准入的注册项。未知或普通聊天接入保留在各自注册表，但不能发起工作。
- create、continue/restart、handoff、live input、queued dispatch 都使用同一能力检查。继承的历史材料也要检查；拒绝时不绑定附件、不创建空任务、不插入输入回执。
- 无 nativeResume 能力不调用 `canResume`，沿用已存在的明确重开确认流程。历史导入只支持已有原生 reader，不因准入新 provider 自动宣称可导入它的历史。
- 执行前再次核对请求能力，防止排队期间注册声明发生变化。用户可查看已有对话和成果，即使执行者不再可用。
- provider API 条目可以携带已验证 capabilities 副本；UI 不根据名称假定能力。错误码由桌面和微信翻译为可操作文字。
- HTTP 创建、模型查询与交接使用 `isWorkbenchProviderId(value)` 校验 `^[a-z][a-z0-9._-]{0,63}$`，随后由服务决定准入；原生历史 reader 仍只支持 Claude/Codex。三个能力错误返回 422，保留可操作错误码。
- 微信新增明确选择语法 `任务 新建 <项目编号> 用 @<执行者编号> <要求>`。保留旧 `用 Claude` / `用 Codex`；`用 Python 处理数据` 等普通要求不作为执行者选择。无效或不可用的显式 @ 选择不能回落到默认执行者，项目帮助里的示例使用真实可用默认值。

## 本轮原生调查结论

Cursor 2026.09.02-c22c1a3 的 `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR` 不覆盖 MCP、home/project Claude settings 和 hooks。headless 交互问题自行跳过，没有发现外部权限答复通道。ask 模式依赖可用 sandbox，不能保证 hook/MCP 不启动。现有适配器的 close 又不等待子进程退出，因此不准入。

agy 1.2.2 的新版 stdin stream-json 接受 user 消息，但静态代码明确拒绝 control_request/control_response。其隐藏根目录参数值得后续隔离探测，原生清理还允许 daemon 任务留存。本轮不伪造 agy 支持。用户允许 Cursor / agy 真实模型测试，但只在已有隔离依据时运行拥有的测试项目。

## 验收

1. 同名普通 Claude/Codex、Cursor/agy、任意 API provider 未声明契约均无法创建工作任务；有效的不同品牌 fixture 能完成独立任务。
2. 桌面列表与微信目录的准入和默认值一致。
3. 不支持附件、执行设置或 resume 时，拒绝发生在持久化和 spawn 前；原输入和附件仍可重试。
4. 排队时能力变化不得放行；停止及历史查看继续可用。
5. 两个正式专用接入和隔离开发/原生验收脚本显式声明；原生 provider 的普通聊天注册不变。
6. 相关工作台/微信/桌面测试和 typecheck，通过独立代码复核。测试是协议证据，不等于完整 CLI/App 功能覆盖。
