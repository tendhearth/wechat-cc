# CC 统一入口：现有能力与真实调用验证

日期：2026-09-12。本次是验证性实验，未更改产品行为、生产配置、现有会话或冻结资产。只使用临时目录中的合成材料，没有微信发送。调用沿用本机已配置的登录与API凭据；此报告不含凭据或私有端点。

## 真实调用

统一通过现有 AgentProvider 的 spawn / dispatch / close 驱动。实验注册表复用 createProviderRegistry；不启动完整生产bootstrap，因为它还会维护全局MCP配置。

| 接入 | 真实检查 | 结果 | 本次耗时 |
|---|---|---|---|
| Claude CLI + SDK | 根据125/275/100给出三步核对方案 | 完成，提出合计500与保存、复核步骤 | 5.6秒 |
| Codex CLI + SDK | 接收上一步方案、读取sales.csv、写report.md | 完成，合计500、记录3条，原文件未变 | 20.1秒 |
| 当前兼容API（配置模型名KIMI） | 独立复核上述报告 | 完成，确认合计500、3条 | 7.8秒 |
| Cursor CLI | 第一轮求和、第二轮从刚才结果减100 | 500→400，同一个native session ID | 25.2秒 + 12.7秒 |
| agy CLI | 纯文本求和，plan模式 | 完成，500 | 8.9秒 |
| 当前兼容API工具循环 | 实际读取sales.csv和错误draft.md，并写audit.md | Read→Read→Write，发现550应为500、多报50 | 34.1秒 |

时间只代表这次小样本，不构成模型质量或性能排名。KIMI是当前配置名，未验证网关实际路由的厂商模型；本次没有调用独立DeepSeek端点。Gemini原生API未实测。

Claude的测试禁用工具及项目hooks；Codex在strict策略下处理临时文件；Cursor与agy只接受纯文本算术且未报告工具调用。后两者本次成功不等于已验证文件写入安全、停止、任意既有会话接管或GUI自动化。

流程由实验脚本显式安排，不能将该接力称为已经上线的CC自主规划。Cursor续接的是本次新建的CLI会话，不是用户原先打开的IDE聊天。已有原生会话导入/接管需要单独验证。

## 代码已有的基础

- `src/daemon/bootstrap/providers.ts`：Claude、Codex、Cursor、agy、兼容API、Gemini的注册与配置条件。
- `src/core/provider-registry.ts`：统一provider目录和评估选择。
- `src/core/agent-provider.ts`：统一会话生命周期与事件。
- `src/core/openai-agent-provider.ts` / `openai-tools.ts`：兼容API已有CC自有工具执行循环，不只是文字接口。
- `src/core/provider-handoff.ts`：已有聊天换provider与冷启动历史交接；带最近记录，非原生会话无损迁移。
- `src/core/conversation-coordinator.ts`：已有solo / primary_tool / parallel / chatroom调度。其重点仍是对话模式。
- `src/daemon/bootstrap/delegate.ts`：已有结构化委派，生产构建目前主要覆盖Claude、Codex、兼容API。Cursor与agy能作为普通会话provider，不代表已进入同等委派能力集合。
- `src/core/workbench/service.ts`：上一轮工作台仍显式限定Claude/Codex。不能因为主registry支持其它后端就声称工作台已全部支持。

现有Agent关系使用代码调度和MCP委派接口，不能概括成全部靠hooks串联。

## 当前缺口

1. 多处各有一份可用性判断：普通聊天注册、委派可用列表、能力矩阵、工作台白名单。要统一展示发现/已配置/本次可用/执行能力，不能只检查安装就标可工作。
2. 兼容API配置当前主要是一个base URL +默认模型槽位。若同时保留多个厂商或网关，应增加可复用连接档案，让用户首次连接后复用；DeepSeek是模型来源，CC工具循环是执行方式，两者不该挤成同一种provider概念。
3. 现有交接以近期聊天文本为主，尚不是持久的目标、输入、约束、成果、验收、未决事项交接包。
4. 当前委派偏一次性咨询。长期工作需要由CC保存事情本身的状态，执行者可换而目标、文件与责任不丢。
5. 不能直接将Cursor/agy放开到所有执行模式：当前权限/工具隔离与停止能力不同，要先做能力验证。
6. 用户已有的IDE会话、跨设备执行、主动发起任务与预算约束仍未在本次验证。

## 推荐实现切片

先在后台建立一个复用现有registry的能力目录，让「发现了什么」和「可以安全交办什么」成为同一份真实数据；再接入单个持久委托：CC保持目标与验收条件→点名/默认选择执行者→接收成果→可选另一执行者复核→CC合并结论。先用已验证的Claude、Codex、兼容API实现，不新建一套接入表单，也不马上放开所有模式。

用户入口保持「交给CC」和按需点名帮手。高级配置属于首次连接或设置，能力差异由CC解释，不要求用户先选solo/parallel/primary_tool。

## 自动回归

- 6个相关测试文件、324项通过：provider注册、能力矩阵、对话调度、委派、历史交接。
- 单独使用e2e配置运行primary_tool daemon测试：1项通过（测试替身，无真实微信）。证明已有主执行者路由，不证明自主多步编排已上线。
- 本次未修改产品源代码，未重启生产daemon，未推送分支。
