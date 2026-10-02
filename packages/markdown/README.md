# 会话阅读格式

桌面、原生手机和浏览器手机页共用此包解析助手 Markdown。原生端用 `parseMarkdown` 的 token 构建原生视图，浏览器用 `renderMarkdown`，短摘要用 `markdownPlainText`。用户输入、命令、日志与交接快照保留原文；阅读格式不修改存储或提交的文字。

原始 HTML 只显示文字，图片只显示说明，链接只允许绝对 HTTP(S) 地址。本地文件及应用链接保留标签文字，避免历史记录触发本机操作。

修改共享源码后运行 `bun run build:markdown` 和 `bun run build:mobile`，提交两端生成物。桌面生成 ESM，手机网页生成并内联经典脚本；生成同步测试分别验证它们与源码一致。
