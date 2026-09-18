# ACP 执行者收附件(图片进 prompt,其余给路径)设计

日期:2026-09-18。状态:主人「go」(ACP 后续候选;elicitation 因当前接入的 agent 都不发而推迟);子代理驱动,中途不打扰。

## 背景

工作台附件(`workbench_attachments`,`store.attachments.prepare` 交给执行者的 `AgentAttachment[]`:图片与 PDF 带 base64 `data`,文本 / Office 只带落盘 `path`)今天 Claude / Codex / API 执行者都收,ACP 执行者(Cursor)声明 `features.attachments:false`,`dispatch` 直接抛 `acp_attachments_unsupported`。真机 spike:`cursor-agent acp` 的 `initialize` 回 `promptCapabilities: { image: true, audio: false, embeddedContext: false }`。ACP `session/prompt.prompt[]` 的内容块:`{type:'image', mimeType, data(base64)}`(受 `promptCapabilities.image` 门控)、`{type:'text', text}`。

## 目标

- Cursor 任务可以带图片附件(png / jpeg / gif / webp):进 prompt 的 image 块。
- 非图片附件(PDF、文本、Office)与 Codex 同一做法:一段文本块「Attached task file (reference material; read with a file tool if needed): {name, mime, path, sha256}」,执行者自己用文件工具读落盘的那份。
- 图片能力由 agent 的 `promptCapabilities.image` 决定:不支持却带了图片 ⇒ 抛 `acp_attachment_image_unsupported`(任务失败,文案说明)。图片缺 `data` ⇒ `attachment_data_missing`(与 Codex 同码)。
- 对话侧不动(协调器不传附件);`refuse` 仍是通用 provider 的缺省。

## 组件

### `src/core/acp-agent-provider.ts`

- 选项 `attachments?: 'refuse' | 'prompt'`(缺省 `'refuse'`,行为同今天)。
- `initialize` 结果记下 `promptCapabilities.image === true`(`imageOk`)。
- 新增纯函数(导出,便于测):
  ```ts
  export function acpPromptBlocks(text: string, attachments: readonly AgentAttachment[] | undefined, imageOk: boolean): Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>
  ```
  规则:`text` 非空或没有附件 ⇒ 先放 `{type:'text', text}`;每个附件:`mime` 以 `image/` 开头 ⇒ 必须是 png/jpeg/gif/webp(否则 `attachment_image_unsupported`)、`imageOk` 必须为 true(否则 `acp_attachment_image_unsupported`)、`data` 必须存在(否则 `attachment_data_missing`)⇒ `{type:'image', mimeType, data}`;其它 ⇒ `{type:'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({name, mime, path, sha256})}`。
- `dispatch`:`options.attachments === 'prompt'` ⇒ `prompt: acpPromptBlocks(prompt, attachments, imageOk)`(首轮 instructions 前缀照旧拼进 text);`'refuse'` ⇒ 有附件即抛 `acp_attachments_unsupported`(不变)。

### 能力与封装

- `ACP_CAPABILITIES.features.attachments: true`(`executor-capabilities.ts`);`createAcpWorkbenchProvider` 传 `attachments:'prompt'`;`createAcpCursorChatProvider` 不传(缺省 refuse)。

### 文案

- `execution-settings.ts` 与桌面 `workbench-execution.js` 各加:`acp_attachment_image_unsupported` ⇒ 「这个版本的 Cursor 不接收图片附件，请移除图片，或改用 Claude / Codex。」;`attachment_image_unsupported` / `attachment_data_missing` 若尚无文案,分别加「附件图片格式不受支持（只收 PNG / JPEG / GIF / WebP）。」「附件内容已变化或无法安全读取，请重新添加后再试。」。

## 测试

- `acpPromptBlocks` 纯函数:文本 + 图片顺序;空文本只有附件时不放空 text 块;PDF/文本走引用块且不含 data;非法图片 mime;imageOk false;缺 data。
- provider:`attachments:'prompt'` 时 `session/prompt.params.prompt` 含 image 块(assert 精确数组);`refuse` 缺省仍抛;工作台测试里「refuses attachments」改成「accepts image attachments」。
- 能力测试:`ACP_CAPABILITIES` 收附件、`requireWorkbenchInput` 不再拒。
- 真机(控制器):上传一张红色方块 PNG,`用 cursor` 建任务问「图里是什么颜色的方块?」,答案含「红」;时间线正常结算。

## 修订记录

- 2026-09-18:初稿。
- 2026-09-18:按计划落地。
