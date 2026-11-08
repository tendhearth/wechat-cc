# 每轮话题召回评测

`kind: "topic-recall"` 使用生产 `resolveTopicRecall`，先索引、拿不准再走回合内快判。旧 `topic` 样本继续可用；`topic` 的 `search: true` 是工具检索，不算每轮召回评测。`topic-recall` 不应设置 `search`。

样本格式见 `examples/topic-recall-backup-{1,2,3,4}.json`：

- `input.text`：主人这一句。
- `input.topics`：独立的话题索引，含 id、title、summary、aliases、tags 和 entries（id、kind、line，可附 body、due）。不读取正式库。
- `rules: [{"recalls":{"topic":"backup","entry":"backup-weekly"}}]`：期望命中话题及条目。
- `rules: [{"recalls":null}]`：闲聊负例，期望没有召回。

每条事实至少准备三种表达，并加入不应命中的闲聊。示例全部虚构；正式样本由整合者脱敏生成，勿提交私人记忆。

将选定 JSON 复制到测试环境 `<STATE_DIR>/eval/samples/`，在已授权的测试 daemon 下运行现有命令：

```sh
wechat-cc eval run --only topic-recall-backup-1,topic-recall-backup-2,topic-recall-backup-3,topic-recall-backup-4 --json
wechat-cc eval diff
```

报告仍在 `<STATE_DIR>/eval/runs/`。无需调用真实模型的索引回归由 `src/daemon/threads/recall.test.ts` 覆盖。回合内 `turn_judge_provider=auto` 优先已配置 OpenAI 兼容 API（包含 DeepSeek 网关），没有则只用索引；`index` 显式禁用模型。它与后台 `cheap_eval_provider` 独立，`config_set` 可即时修改。

2026-11-08:新增 `topic-routine-receipts-only`(只有机器流水时不召回)和 `topic-routine-vs-owner-decision`(保留主人修复升级能力的决定)。两条均为独立文本样例,随离线索引回归执行;排序由 `topic-priority.test.ts` 验证。
