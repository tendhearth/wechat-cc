# S4 历史证据与七天影子观察

由整合者在部署后串行操作；开发验收只使用合成库。不要为了回填复制或读取私人生产库到开发工作区。

```sh
wechat-cc speech backfill --json
wechat-cc speech audit --days 7
wechat-cc speech audit --days 7 --json
```

两个命令支持 `--db PATH`，默认使用状态目录中的 `wechat-cc.db`，要求已经完成数据库升级。audit 用 SQLite 只读连接，不调用 daemon、模型或外发接口。输出不含正文、接收人 ID 或消息 ID。backfill 使用已有库的读写连接，不自动建库或执行迁移。

历史回填采用维护命令，而不是升级迁移：存档证据可能后来才补齐，需要显式执行、独立复核和安全重跑。v110 仅追加影子事件和观察起点的表，不在启动时扫描历史或改写旧迁移。

回填只处理 `delivery_state=legacy_unknown AND spoken_at IS NULL`：

- `letter:<信 ID>`：从 letters act 的 delivery 步查 `status=completed`、`result=sent`、明确的 `sentAt` 与 app/wechat 通道，取最早可证明时刻。存在明确 owner 时还要求接收人一致。letters act 没有 owner 时依赖全局唯一信 ID，不做时间或正文匹配。
- `message:<消息 ID>` 或 ref 本身就是完整消息 ID：要求同接收人、`direction=out`、`source=live` 的明确消息引用，取消息时刻。导入会话记录不作为送达证据。没有这种显式引用的旧消息不猜关联。
- 多页信只关联同一笔账；失败 / waiting 步不能证明哪页送达，缺少明确页消息引用时保留 unknown。后来的完整送达步可以补证，但不能倒推出更早的第一页时刻。

只修改 `spoken_at` 和 `delivery_state`，不修改原有 at、outcome、origin、kind、channel、ref。证据不足保留原账及 legacy_unknown；allowed 不证明送达。分页扫描包含在一个 immediate 事务中，任何写失败整轮回滚。重复执行不改变已确认时间；存档补齐后可以再次执行。

影子事件从新版 wireSpeech 启动开始积累，每次 picker.submit 返回记一笔，不存正文。放行是 picker / policy 结果，不能读成“确认送达”；模型落选、资格失效、间隔等待等归延后。去重在提交层提前返回而未进入 picker 的调用不在 picker 计数内。历史 speech_log 同 ref 会合账，不能还原过去完整的挑选次数。

间隔按接收人检查，读取窗口前的上一笔证据，同时考虑 unknown 预留；同 ref 的确认账与崩溃恢复 unknown 属于一次逻辑开口，不互相算间隔违规；早报、周报作为当前发送方豁免，仍推进后续普通候选的间隔。历史 legacy_unknown 不伪造开口，也不自动建立占位。unknown 预留按 created_at 占一个 20 小时间隔，报告列出窗口内数量，并另列当前仍占位的数量（包含早于查询窗口但尚未满 20 小时的预留）。

“疑似直发绕过”检查观察起点以后的已确认 initiative 是否同时缺少同 ref、同接收人的 reservation 和持久 picker 放行事件（续寄失败可能清理替换后的预留）。预期为 0；它不能发现完全没入账的外发，需与现有 speech-send / 来源依赖守卫一起判断。历史回填的旧证据不应当被算成新版绕过。源码守卫和数据库对账都不等于外部通道的全量收据。

每天保存一次 JSON 和中文结果。`completeWindow=false` 时不下七天结论；它仅说明从最初观察起点到查询时的日历长度，不保证 daemon 连续在线或每次事件都写入成功，需同时检查 `SPEECH_AUDIT` 写入失败日志。满七天后核对来源计数、20 小时违规（应 0）、未知占位和疑似绕过（应 0），由整合者记录结论。代码验收不冒充已完成七天线上观察。
