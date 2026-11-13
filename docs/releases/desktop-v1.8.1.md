# Tendhearth CC desktop v1.8.1（待整合）

「CC 现在怎么样」增加管家状态：记性、用工具、上次体检、先看用量再开始、取消，以及默认关闭的小量复查开关。体检只用编造题，结果留本机。原生后端工具隔离限制见 [体检维护说明](../maintainer/butler-checkup.md)。

需随宿主发版带上 `generated/workbench-routes.json` 的五条 `/v1/checkup` 代理白名单；只换 sidecar 不够。发布版本号由整合者最终核对。UI 尚待 mini lab 统一验收，本页不代表已经发版。
