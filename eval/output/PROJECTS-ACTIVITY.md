# 跨项目活动离线样本

`projects-activity-*.json` 使用现有 `id / kind / input / rules` 格式。新增 `kind: "projects-activity"` 是确定性取数评测，不启动模型、不查询生产库；题目对应的 `input.query` 明确给出窗口/项目，`now` 固定时刻，`evidence` 自带虚构话题、索引行、历史元数据和当前会话。

执行路径为现有 CLI `runEval` → 真 `POST /v1/eval/run` → 生产 `summarizeProjectsActivity`；规则检查序列化的工具数据。`src/cli/output-eval.test.ts` 注入本地 fetch，跑完仍生成原有 report/diff，并额外核对精确项目集合。registry、令牌铸造等路径一旦被调用立即失败。

```sh
bun --bun vitest run src/cli/output-eval.test.ts src/domain/projects-activity.test.ts src/features/memory/projects-activity.test.ts src/features/memory/projects-activity-routes.test.ts scripts/topic-activity-metadata.guard.test.ts
```

五问分别覆盖这周、昨天、等你、两项目现况、rici上次进展。合成字段中的 `PRIVATE_*` 是禁止传播的canary；条目body、命令、diff、输出、问题原文不进工具结果。SQL与真实owner/session HTTP鉴权另外通过内存数据库及独立临时API测试，避免用已投影夹具代替读取边界验证。

这组评测证明所需数据可取得和聚合，不证明真实模型会选择正确窗口、调用工具并写出一两句回答。真实模型输出评测需整合者另行授权；本任务禁止live模型/daemon，所以没有执行通常的 `wechat-cc eval run`。
