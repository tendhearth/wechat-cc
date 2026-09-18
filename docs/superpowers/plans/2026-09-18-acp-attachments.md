# ACP 执行者收附件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台的 Cursor(ACP)执行者接收附件:图片进 `session/prompt` 的 image 块,其余附件给引用文本块;能力由 agent 的 `promptCapabilities.image` 门控。

**Architecture:** `acp-agent-provider.ts` 加 `attachments:'refuse'|'prompt'` 选项与纯函数 `acpPromptBlocks`;工作台封装传 `'prompt'`;`ACP_CAPABILITIES.features.attachments:true`;两处文案。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest)。

**Spec:** `docs/superpowers/specs/2026-09-18-acp-attachments-design.md`

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树。测试 `bun --bun vitest run <paths>`;`bun run typecheck`;`bun run depcheck`(0 errors / 7 warnings 既有);业务代码不 import `bun:*`。
- 图片块形状精确为 `{ type:'image', mimeType, data }`(base64 `data`,不带 data: URL 前缀);引用块文本与 Codex 的 `turnInput` 逐字一致(`'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name, mime, path, sha256 })`)。
- 错误码:`attachment_image_unsupported`(mime 不在 png/jpeg/gif/webp)、`acp_attachment_image_unsupported`(agent 无 image 能力)、`attachment_data_missing`、`acp_attachments_unsupported`(refuse 模式)。
- 对话侧 `createAcpCursorChatProvider` 不传 `attachments`(缺省 refuse);`acp-cursor-chat.test.ts` 的接线断言不用改(它断言的是显式传入的键)。
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。

---

### Task 1: 附件进 prompt

**Files:**
- Modify: `src/core/acp-agent-provider.ts`、`src/core/acp-workbench-provider.ts`、`src/core/workbench/executor-capabilities.ts`、`src/core/workbench/execution-settings.ts`、`apps/desktop/src/modules/workbench-execution.js`、`docs/cc-workbench.md`(修订记录一条)、spec 修订记录
- Test: `src/core/acp-agent-provider.test.ts`(追加)、`src/core/acp-workbench-provider.test.ts`(改「refuses attachments」一例)、`src/core/workbench/executor-capabilities.test.ts`(ACP 一例)、`src/core/workbench/execution-settings.test.ts`(追加)

- [ ] **Step 1: 写失败的测试**

`acp-agent-provider.test.ts` 追加(`acpPromptBlocks` 从 `./acp-agent-provider` import):

```ts
describe('attachments into the prompt', () => {
  const png = { name: 'a.png', mime: 'image/png', path: '/store/a.png', sha256: 'f'.repeat(64), data: 'iVBORw0KGgo=' }
  const pdf = { name: 'b.pdf', mime: 'application/pdf', path: '/store/b.pdf', sha256: 'e'.repeat(64), data: 'JVBERi0=' }
  it('acpPromptBlocks: text first, images as image blocks, others as reference text blocks; no empty text block', () => {
    expect(acpPromptBlocks('看图', [png, pdf], true)).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name: 'b.pdf', mime: 'application/pdf', path: '/store/b.pdf', sha256: 'e'.repeat(64) }) },
    ])
    expect(acpPromptBlocks('', [png], true)).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])
    expect(acpPromptBlocks('只有字', undefined, false)).toEqual([{ type: 'text', text: '只有字' }])
    expect(JSON.stringify(acpPromptBlocks('x', [pdf], true))).not.toContain('JVBERi0=')
  })
  it('acpPromptBlocks: refuses unsupported image mimes, agents without image capability, and images without bytes', () => {
    expect(() => acpPromptBlocks('x', [{ ...png, mime: 'image/bmp' }], true)).toThrow('attachment_image_unsupported')
    expect(() => acpPromptBlocks('x', [png], false)).toThrow('acp_attachment_image_unsupported')
    expect(() => acpPromptBlocks('x', [{ ...png, data: undefined }], true)).toThrow('attachment_data_missing')
  })
  it('prompt mode sends image blocks in session/prompt; refuse mode (default) still throws', async () => {
    const { session, child } = await start({}, c => { c.initializeResult = { protocolVersion: 1, agentCapabilities: { loadSession: true }, promptCapabilities: { image: true } } }, { attachments: 'prompt', text: 'append', permissions: 'bridge' })
    const { done } = collect(session, '看图')
    await prompted(child)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'task instructions\n\n---\n\n看图' }])
    child.finishPrompt(); await done
    const second = (async () => { for await (const _ of session.dispatch('再看', [png])) { /* noop */ } })()
    await prompted(child, 2)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: '再看' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])
    child.finishPrompt(); await second
    const noImage = await start({}, c => { c.initializeResult = { protocolVersion: 1, agentCapabilities: { loadSession: true }, promptCapabilities: { image: false } } }, { attachments: 'prompt', text: 'append', permissions: 'bridge' })
    await expect(async () => { for await (const _ of noImage.session.dispatch('x', [png])) { /* noop */ } }).rejects.toThrow('acp_attachment_image_unsupported')
    const refuse = await start()
    await expect(async () => { for await (const _ of refuse.session.dispatch('x', [png])) { /* noop */ } }).rejects.toThrow('acp_attachments_unsupported')
  })
})
```

`start()` 的第三个参数已是 provider 选项覆盖(缺省 `{permissions:'mode', text:'messages'}`);`collect(session, text)` 沿用。`acp-workbench-provider.test.ts` 里「refuses attachments, overlapping turns and win32」:把 attachments 那一句改成「accepts an image attachment」—— 用 `FakeProcess.initializeResult` 加 `promptCapabilities:{image:true}`,`session.dispatch('x', [png])` 后 `session/prompt.params.prompt` 第二项是 image 块;其余断言不动。`executor-capabilities.test.ts` ACP 一例:`attachments` 断言反过来(`requireWorkbenchInput(ACP_CAPABILITIES, { ...input, attachments: [{}] })` 不抛)。`execution-settings.test.ts` 追加三码文案断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp-agent-provider.test.ts src/core/acp-workbench-provider.test.ts src/core/workbench/executor-capabilities.test.ts src/core/workbench/execution-settings.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`acp-agent-provider.ts`:
```ts
export type AcpPromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** 图片进 prompt 的 image 块(受 agent 的 promptCapabilities.image 门控);其它附件给引用文本块,执行者自己用文件工具读落盘那份 —— 与 Codex 的 turnInput 同一做法。 */
export function acpPromptBlocks(text: string, attachments: readonly AgentAttachment[] | undefined, imageOk: boolean): AcpPromptBlock[] {
  const list = attachments ?? []
  const blocks: AcpPromptBlock[] = text || !list.length ? [{ type: 'text', text }] : []
  for (const attachment of list) {
    if (attachment.mime.startsWith('image/')) {
      if (!IMAGE_MIMES.has(attachment.mime)) throw new Error('attachment_image_unsupported')
      if (!imageOk) throw new Error('acp_attachment_image_unsupported')
      if (!attachment.data) throw new Error('attachment_data_missing')
      blocks.push({ type: 'image', mimeType: attachment.mime, data: attachment.data })
    } else {
      const { name, mime, path, sha256 } = attachment
      blocks.push({ type: 'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name, mime, path, sha256 }) })
    }
  }
  return blocks
}
```
选项 `attachments?: 'refuse' | 'prompt'`(文档注释:缺省 refuse);`initialize` 后 `const imageOk = object(initialized.promptCapabilities) && initialized.promptCapabilities.image === true`;`dispatch` 里:
```ts
if (attachments?.length && options.attachments !== 'prompt') throw new Error('acp_attachments_unsupported')
…
const blocks = options.attachments === 'prompt' ? acpPromptBlocks(prompt, attachments, imageOk) : [{ type: 'text', text: prompt }]
void connection.request('session/prompt', { sessionId, prompt: blocks }, 0)…
```
(`acpPromptBlocks` 抛错要在 `active = turn` 之前抛 —— 放在 dispatch 开头、`if (active)` 检查之后、建 turn 之前。)`acp-workbench-provider.ts`:`createAcpProvider({ ...options, permissions: 'bridge', text: 'append', attachments: 'prompt' })`;`AcpWorkbenchProviderOptions` 的 Omit 列表加 `'attachments'`。`executor-capabilities.ts`:`ACP_CAPABILITIES.features.attachments: true`(注释:图片进 prompt,其余给路径)。文案两处 + `docs/cc-workbench.md` 修订记录:`- **2026-09-18**：Cursor（ACP）执行者收附件：图片（PNG / JPEG / GIF / WebP）作为 image 块进 prompt，PDF / 文本 / Office 给引用文本块由执行者用文件工具读；agent 不报图片能力时带图直接失败并说明。` spec 修订记录 `- 2026-09-18:按计划落地。`

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp src/core/acp-agent-provider.test.ts src/core/acp-workbench-provider.test.ts src/core/acp-cursor-chat.test.ts src/core/workbench/executor-capabilities.test.ts src/core/workbench/execution-settings.test.ts src/core/workbench/service-capabilities.test.ts src/daemon/bootstrap/wire-workbench.test.ts apps/desktop/src/modules/workbench-execution.test.ts && bun run typecheck && bun run depcheck`
Expected: 全绿;0 errors

- [ ] **Step 5: 提交**

```bash
git add -A src docs apps/desktop/src/modules/workbench-execution.js
git commit -m "ACP 执行者收附件:图片进 prompt 的 image 块(按 promptCapabilities.image 门控),其余附件给引用块"
```
