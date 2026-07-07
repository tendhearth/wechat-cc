# Bundled (first-party) plugins

wechat-cc 启动时会扫这个目录当作**内置插件**(默认启用、随产品版本走),和
`~/.claude/channels/wechat/plugins/` 下的用户插件（默认停用）并列。

**本目录内容不进公开仓库**（见 `.gitignore`）。内置插件按安装单独交付：
- 桌面包在构建时把它们打进去；
- 或产品在 setup / Pro 激活时从私有源拉取到这里。

这样有法律风险的能力（如微信解密 `wxvault`）**只通过产品交付、不在公开源码里**，
公开的插件市场只列无风险的第三方插件。
