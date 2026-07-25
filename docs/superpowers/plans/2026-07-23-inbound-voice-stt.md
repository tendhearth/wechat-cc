# 入站语音 STT(微信语音 → 转文字喂 bot)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已建好的 STT 客户端接进微信入站语音路径——微信没给 ASR 文本时,转写 `.amr` 附件并注入 `[语音] <text>` 到 bot 看到的消息;失败保持原样(零回归)。

**Architecture:** 新增一个入站中间件 `mw-transcribe-voice`,排在 `mwAttachments`(附件已落地成真实路径)之后、`mwActivity`/dispatch 之前。已落地的 `kind:'voice'` 附件本身就是"微信没给 ASR"的信号(poll-loop 只在 `voice_item.text` 缺失的 else 分支建它)。中间件读文件 → `ilink.voice.transcribe(buf, mime)` → 追加文本;`transcribe` 未配置时抛 `no_stt_config`,中间件 catch 掉。

**Tech Stack:** 现有 inbound middleware 框架(`compose([...])`、`Middleware = (ctx, next) => Promise<void>`)、注入式纯中间件 + vitest、`ilink.voice.transcribe`(现成 http-stt 客户端)。

**Spec:** `docs/superpowers/specs/2026-07-23-inbound-voice-stt-design.md`

## Global Constraints

- **零回归**:STT 未配置 / transcribe 抛错 / 返回空 → `ctx.msg.text` 与附件**原样不动**(bot 仍看到 .amr,同今天)。一条语音转写失败不中断其余附件或整条消息。
- `ctx.msg` 是 readonly **引用**,但 `msg.text`(`string`)是可变字段——直接 `ctx.msg.text = ...` 合法;不要重赋 `ctx.msg`。
- 只处理已落地的 voice 附件(`kind==='voice'` 且 `path` ≠ `PENDING_CDN_REF` 且非空);PENDING/其他 kind 跳过。
- transcribe **可选注入**:dep 缺省 → 中间件 no-op(等同 STT 未配置)。
- 中间件排序:**`makeMwAttachments` 之后、`makeMwActivity` 之前**(compose 数组既有 attachments 行的下一行)。
- **`bun run test`(vitest)不做类型检查**——本计划每个动 .ts 的任务跑 `bunx tsc --noEmit`(从仓库根;这周被咬两次的教训);backend 单文件测试用 `bun test <file>`(bunx vitest 有 bun:sqlite 解析怪癖)。
- 每任务 TDD:先测试跑 FAIL,再实现跑 PASS,commit。
- §2/§3(盒子 whisper server OpenAI 兼容化 + systemd + nginx `/stt/` + stt-config.json + 真机验证)是 **ops,不在本 SDD 计划**——合并后我 ssh 实操,记进 spec 部署节 + voice memory(见文末"部署清单")。

---

### Task 1: mw-transcribe-voice 中间件核心

**Files:**
- Create: `src/daemon/inbound/mw-transcribe-voice.ts`
- Test: `src/daemon/inbound/mw-transcribe-voice.test.ts`

**Interfaces:**
- Consumes: `InboundCtx`/`Middleware`(`./types`);`ctx.msg.attachments: {kind, path, caption?}[]`、`ctx.msg.text: string`;`PENDING_CDN_REF`(`../media`)。
- Produces: `makeMwTranscribeVoice(deps): Middleware`,deps = `{ transcribeVoice?: (audio: Buffer, mime: string) => Promise<{ text: string }>, readFile?: (path: string) => Promise<Buffer>, log: (tag: string, line: string) => void }`。Task 2 组装。

- [ ] **Step 1: 写失败测试** —— `src/daemon/inbound/mw-transcribe-voice.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwTranscribeVoice } from './mw-transcribe-voice'
import type { InboundCtx } from './types'
import { PENDING_CDN_REF } from '../media'

const mkCtx = (over: Partial<InboundCtx['msg']> = {}): InboundCtx => ({
  msg: { chatId: 'c1', text: '(non-text message)', attachments: [], ...over } as InboundCtx['msg'],
  receivedAtMs: 0, requestId: 'r',
})

function make(over: Record<string, any> = {}) {
  const transcribeVoice = vi.fn(async () => ({ text: '周末一起爬山吗' }))
  const readFile = vi.fn(async () => Buffer.from('AMRBYTES'))
  const mw = makeMwTranscribeVoice({ transcribeVoice, readFile, log: () => {}, ...over })
  return { mw, transcribeVoice, readFile }
}

describe('mwTranscribeVoice', () => {
  it('已落地 voice 附件 → 转写并注入 [语音] …(替换占位文本)', async () => {
    const { mw, transcribeVoice, readFile } = make()
    const ctx = mkCtx({ attachments: [{ kind: 'voice', path: '/inbox/c1/voice-1.amr' }] })
    await mw(ctx, async () => {})
    expect(readFile).toHaveBeenCalledWith('/inbox/c1/voice-1.amr')
    expect(transcribeVoice).toHaveBeenCalledWith(expect.any(Buffer), 'audio/amr')
    expect(ctx.msg.text).toBe('[语音] 周末一起爬山吗')       // 占位被替换,不是拼在后面
  })

  it('已有真实文本时,语音转写追加在后面', async () => {
    const { mw } = make()
    const ctx = mkCtx({ text: '看这个', attachments: [{ kind: 'voice', path: '/inbox/c1/v.amr' }] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('看这个\n[语音] 周末一起爬山吗')
  })

  it('多条语音各自追加', async () => {
    const transcribeVoice = vi.fn().mockResolvedValueOnce({ text: '第一条' }).mockResolvedValueOnce({ text: '第二条' })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: '(non-text message)', attachments: [
      { kind: 'voice', path: '/a.amr' }, { kind: 'voice', path: '/b.amr' },
    ] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('[语音] 第一条\n[语音] 第二条')
  })

  it('PENDING / 非 voice 附件跳过', async () => {
    const { mw, transcribeVoice } = make()
    const ctx = mkCtx({ attachments: [
      { kind: 'voice', path: PENDING_CDN_REF }, { kind: 'image', path: '/img.jpg' },
    ] })
    await mw(ctx, async () => {})
    expect(transcribeVoice).not.toHaveBeenCalled()
    expect(ctx.msg.text).toBe('(non-text message)')
  })

  it('transcribe 抛 no_stt_config → 文本不变、不崩', async () => {
    const transcribeVoice = vi.fn(async () => { throw new Error('no_stt_config') })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: 'x', attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await expect(mw(ctx, async () => {})).resolves.toBeUndefined()
    expect(ctx.msg.text).toBe('x')
  })

  it('transcribe 网络错只影响该条,其余语音仍转写', async () => {
    const transcribeVoice = vi.fn().mockRejectedValueOnce(new Error('cannot connect')).mockResolvedValueOnce({ text: '好的' })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: '(non-text message)', attachments: [
      { kind: 'voice', path: '/bad.amr' }, { kind: 'voice', path: '/ok.amr' },
    ] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('[语音] 好的')
  })

  it('空转写文本不追加', async () => {
    const transcribeVoice = vi.fn(async () => ({ text: '   ' }))
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: 'x', attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('x')
  })

  it('transcribeVoice 未注入 → no-op(仍调 next)', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwTranscribeVoice({ log: () => {} })
    const ctx = mkCtx({ attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await mw(ctx, next)
    expect(next).toHaveBeenCalled()
    expect(ctx.msg.text).toBe('(non-text message)')
  })

  it('无附件 → 不读文件、不转写', async () => {
    const { mw, readFile, transcribeVoice } = make()
    await mw(mkCtx(), async () => {})
    expect(readFile).not.toHaveBeenCalled()
    expect(transcribeVoice).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/daemon/inbound/mw-transcribe-voice.test.ts`(模块不存在,红)。

- [ ] **Step 3: 实现** —— `src/daemon/inbound/mw-transcribe-voice.ts`:

```ts
/**
 * mw-transcribe-voice — inbound STT (voice arc, symmetric to outbound TTS).
 * Runs AFTER mwAttachments (the .amr is now a real inbox file) and BEFORE
 * dispatch, so a transcribed voice message reaches the bot as text.
 *
 * A MATERIALIZED voice attachment (path ≠ PENDING_CDN_REF) is itself the
 * signal that WeChat gave us NO ASR text: poll-loop only builds the voice
 * attachment in the else-branch where `voice_item.text` was absent; when
 * WeChat's own ASR is present it goes straight into the message text and no
 * attachment is created. So there's nothing else to check.
 *
 * Fail-safe / zero-regression: STT unconfigured (transcribe throws
 * `no_stt_config`), a network error, or an empty transcript all leave
 * ctx.msg.text and the attachment UNTOUCHED — the bot still sees the .amr,
 * exactly as before STT existed. One clip's failure never aborts the others.
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import type { Middleware, InboundCtx } from './types'
import { PENDING_CDN_REF } from '../media'

export interface TranscribeVoiceMwDeps {
  /** Injected = ilink.voice.transcribe (loads STT config, throws
   *  `no_stt_config` when unset). Absent → the middleware is a no-op. */
  transcribeVoice?: (audio: Buffer, mime: string) => Promise<{ text: string }>
  readFile?: (path: string) => Promise<Buffer>
  log: (tag: string, line: string) => void
}

/** Rough mime from the inbox filename ext (WeChat voice = .amr). whisper
 *  decodes by content, so this is only a best-effort hint for the server. */
function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'amr' ? 'audio/amr'
    : ext === 'mp3' ? 'audio/mpeg'
    : ext === 'ogg' ? 'audio/ogg'
    : ext === 'wav' ? 'audio/wav'
    : 'application/octet-stream'
}

export function makeMwTranscribeVoice(deps: TranscribeVoiceMwDeps): Middleware {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p).then(b => Buffer.from(b)))
  return async (ctx: InboundCtx, next) => {
    const transcribe = deps.transcribeVoice
    const atts = ctx.msg.attachments
    if (transcribe && atts) {
      for (const att of atts) {
        if (att.kind !== 'voice' || !att.path || att.path === PENDING_CDN_REF) continue
        try {
          const buf = await readFile(att.path)
          const { text } = await transcribe(buf, mimeFor(att.path))
          const clean = (text ?? '').trim()
          if (!clean) continue
          const line = `[语音] ${clean}`
          // Replace the poll-loop placeholder; otherwise append a line.
          ctx.msg.text = (!ctx.msg.text || ctx.msg.text === '(non-text message)')
            ? line
            : `${ctx.msg.text}\n${line}`
          deps.log('STT', `transcribed ${att.path} (${clean.length} chars)`)
        } catch (err) {
          // Zero-regression: leave text + attachment as-is; the bot still
          // sees the .amr. Never abort the rest of the loop or the turn.
          deps.log('STT', `transcribe failed for ${att.path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await next()
  }
}
```

（注意:`mimeFor` vs 上文测试里用 `mimeFor`——实现里叫 `mimeFor`。测试断言 `'audio/amr'`,与 `mimeFor` 输出一致。）

- [ ] **Step 4: 跑 PASS** —— `bun test src/daemon/inbound/mw-transcribe-voice.test.ts`,全绿;`bunx tsc --noEmit`(仓库根)无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/inbound/mw-transcribe-voice.ts src/daemon/inbound/mw-transcribe-voice.test.ts
git commit -m "feat(voice): mw-transcribe-voice 入站语音转写中间件(ASR 缺失时兜底,失败零回归)"
```

---

### Task 2: build.ts + pipeline-deps 接线

**Files:**
- Modify: `src/daemon/inbound/build.ts`(import + `InboundPipelineDeps` 加字段 + compose 顺序)
- Modify: `src/daemon/wiring/pipeline-deps.ts`(组装 `transcribeVoice` + `log`)
- Test: `src/daemon/inbound/build.test.ts`(如存在,顺序断言;否则在 mw-transcribe-voice.test.ts 里加一条"顺序"守卫见下)

**Interfaces:**
- Consumes: Task 1 `makeMwTranscribeVoice` / `TranscribeVoiceMwDeps`;`ilink.voice.transcribe`(pipeline-deps 作用域内 `ilink` 可达;未配置时抛 `no_stt_config`)。
- Produces: `InboundPipelineDeps.transcribeVoice: TranscribeVoiceMwDeps`;compose 数组在 attachments 之后插入 `makeMwTranscribeVoice(d.transcribeVoice)`。

- [ ] **Step 1: 写失败测试** —— 顺序守卫。若 `src/daemon/inbound/build.test.ts` 存在,追加;否则新建最小文件:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// build.ts wires middlewares by source order; assert transcribe-voice sits
// AFTER attachments and BEFORE activity (dispatch reads the transcribed text).
describe('inbound pipeline order — transcribe-voice', () => {
  it('makeMwTranscribeVoice is composed after attachments, before activity', () => {
    const src = readFileSync(join(__dirname, 'build.ts'), 'utf8')
    const iAtt = src.indexOf('makeMwAttachments(')
    const iStt = src.indexOf('makeMwTranscribeVoice(')
    const iAct = src.indexOf('makeMwActivity(')
    expect(iAtt).toBeGreaterThan(-1)
    expect(iStt).toBeGreaterThan(iAtt)
    expect(iAct).toBeGreaterThan(iStt)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/daemon/inbound/build.test.ts`(`iStt === -1`,红)。

- [ ] **Step 3: 实现**

3a. `build.ts`:
- import:`import { makeMwTranscribeVoice, type TranscribeVoiceMwDeps } from './mw-transcribe-voice'`(放 `mw-attachments` import 旁）。
- `InboundPipelineDeps` 在 `attachments: AttachmentsMwDeps` 之后加:`transcribeVoice: TranscribeVoiceMwDeps`。
- compose 数组:`makeMwAttachments(d.attachments),` 之后加一行 `makeMwTranscribeVoice(d.transcribeVoice),`。

3b. `pipeline-deps.ts`:在 `attachments: { materializeAttachments, inboxDir, log },` 之后加:

```ts
    transcribeVoice: {
      // ilink.voice.transcribe loads STT config internally and throws
      // `no_stt_config` when unset — the middleware catches it (no-op).
      transcribeVoice: (audio, mime) => ilink.voice.transcribe!(audio, mime),
      log,
    },
```

（`ilink.voice.transcribe` 在 IlinkAdapter 上是可选,但 main.ts:194 已恒接为函数;`!` 断言与该处一致。若严格模式报可选,用 `ilink.voice.transcribe ? (a,m)=>ilink.voice.transcribe!(a,m) : undefined` 传条件。以 tsc 结果为准。）

- [ ] **Step 4: 跑 PASS** —— `bun test src/daemon/inbound/build.test.ts src/daemon/inbound/mw-transcribe-voice.test.ts`;`bunx tsc --noEmit`(仓库根)**零新错**。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/inbound/build.ts src/daemon/wiring/pipeline-deps.ts src/daemon/inbound/build.test.ts
git commit -m "feat(voice): 入站管线接 mw-transcribe-voice(attachments 后 activity 前)+ 接 ilink.voice.transcribe"
```

---

### Task 3: 全量回归 + 收尾

**Files:** 无代码改动(纯验证)。

- [ ] **Step 1: 全量** —— 仓库根 `bun run test`,全绿(本弧只加中间件,任何红先查是不是自己引的)。
- [ ] **Step 2: 类型** —— `bunx tsc --noEmit`(仓库根),零错(桌面基线也已在 v1.3.5 修净,应彻底 0)。
- [ ] **Step 3: grep 守卫** —— `grep -rn "makeMwTranscribeVoice" src/daemon/inbound/build.ts` 命中一次;`grep -n "transcribeVoice" src/daemon/wiring/pipeline-deps.ts` 命中组装。
- [ ] **Step 4: Commit(若 Step 1-3 无改动则跳过)** —— 仅当需要微调时提交。

---

## 部署清单（§2/§3,ops，合并后 ssh 实操,不在 SDD)

1. **盒子 `~/voice-svc/stt_server_cuda.py` → OpenAI 兼容**:`POST /v1/audio/transcriptions`、表单字段 `file`(容忍 `model`)、返回 `{text}`;绑 tailscale `100.101.160.96:8090`(不再 0.0.0.0)。
2. **user systemd `stt.service`**（照 `voxcpm.service`:venv/conda、`STT_MODEL=large-v3-turbo`、`systemctl --user enable --now stt`）。
3. **nginx `brain.youdamaster.cc:8443` 加 `location /stt/`** → `proxy_pass http://100.101.160.96:8090/`（先备份 conf;镜像 `/voice/`）。
4. **daemon 写 `stt-config.json`** = `{provider:'http_stt', base_url:'https://brain.youdamaster.cc/stt/v1/audio/transcriptions', model:'large-v3-turbo', saved_at:<ISO>}`（`/v1/stt/save_config` 或直接写;`saved_at` 必填）。
5. **真机验证**:`GET https://brain.youdamaster.cc/stt/health` 200 → 发一条无 ASR 微信语音 → daemon 日志见 `[STT] transcribed …` → bot 读到 `[语音] …` 回复对上。记进 spec 部署节 + 更新 `voice-tts-via-gateway` memory（STT 补齐）。

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:§1 注入点/信号/兜底/依赖注入/测试 = Task 1+2;§2/§3 = 部署清单(ops,spec 明列非 SDD)。无缺口。
- **占位符**:无;所有步骤含完整代码。
- **一致性**:`mimeFor` 实现名与测试断言 `'audio/amr'` 对齐;`ctx.msg.text` 可变字段(readonly 仅引用);中间件排序 attachments→transcribe→activity 三处(spec、Task 1 注释、Task 2 顺序测试)一致;`transcribeVoice` 可选(未注入 no-op)与 wiring 恒接(catch no_stt_config)两条兜底路径都覆盖。
