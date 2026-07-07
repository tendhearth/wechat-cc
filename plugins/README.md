# Bundled (first-party) plugins

wechat-cc 启动时会扫这个目录当作**内置插件**(默认启用、随产品版本走),和
`~/.claude/channels/wechat/plugins/` 下的用户插件（默认停用）并列。

**本目录内容不进公开仓库**（见 `.gitignore`）。内置插件按安装单独交付：
- 桌面包在构建时把它们打进去；
- 或产品在 setup 时拉取到这里。

公开的插件市场只列公开的第三方插件；随产品交付的一等能力放在这里，不列市场。
