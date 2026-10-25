/**
 * ACP 执行者能在哪些平台上跑(重构第二批步 7)。acp-agent-provider 在 spawn 时对 win32 无条件抛(进程树清理在 Windows 上
 * 没验证过),对话侧与工作台、内置 cursor 与自定义 ACP 共用那一处 —— 所以这道门要在**注册之前**统一挡:以前只有对话侧的
 * cursor 挡了,工作台和自定义 ACP 会先注册、能选,一跑才报「暂不支持 Windows」。
 */
export function acpSupportedOn(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}
