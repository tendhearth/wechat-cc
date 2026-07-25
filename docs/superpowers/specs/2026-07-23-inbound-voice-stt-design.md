# 入站语音 STT(微信语音 → 转文字喂 bot)端到端设计

**日期**: 2026-07-23
**状态**: 已批准(端到端上线:软件走 SDD + 盒子/网关部署 ops)
**父级脉络**: `voice-tts-via-gateway`(出站 TTS 已 live,同一 gateway `brain.youdamaster.cc`;STT 是对称的入站半)

## 背景与目标

微信语音消息进来时,poll-loop(`poll-loop.ts:131-141`)两种走法:①`voice_item.text` 有(微信自带 ASR)→ `[语音] <text>` 直接进消息文本,bot 读得懂;②只有 `voice_item.media`、无 ASR → 建一个 `kind:'voice'` 附件 → `materializeAttachments` 下载成 `voice-<ts>.amr`,bot 只看到一个读不懂的文件路径。**②就是 STT 要填的洞。**

STT **客户端已全建好**(`src/daemon/stt/`:`http-stt.ts` OpenAI 兼容客户端、`stt-config.ts`、`types.ts`;`ilink.voice.transcribe/saveSTTConfig/sttStatus`;`/v1/stt/save_config`+`/v1/stt/status`+`/v1/companion/transcribe` 路由 + 定级 + 桌面 Stage-2 消费)。缺的只有:①把 `transcribe` 接进微信入站语音路径;②盒子 whisper server 上线 + 网关路由 + config(像 TTS 那样)。

## §1 软件:transcribe 接入站语音管线(SDD)

### 注入点

新中间件 `src/daemon/inbound/mw-transcribe-voice.ts`,在 `build.ts` 的 compose 数组里排在 **`makeMwAttachments` 之后、`makeMwActivity` 之前**——附件已落地成真实路径,转写文本能在 dispatch 前进 `ctx.msg.text`。

### 逻辑

- **信号**:遍历 `ctx.msg.attachments`,取 `kind==='voice'` 且 `path` 是真实文件(≠ `PENDING_CDN_REF`、非空)的附件。这类附件的存在**本身**就意味着微信没给 ASR(poll-loop 只在 `voice_item.text` 缺失的 else 分支建它);有 ASR 时走的是 textParts,不建附件。所以无需再判 msg.text。
- 对每个这样的附件:读文件字节 → `transcribeVoice(buf, mime)`(mime 由扩展名推,`.amr`→`audio/amr`)→ 得到非空文本 → 追加 `[语音] <text>` 到 `ctx.msg.text`(若 msg.text 是占位 `(non-text message)` 则替换)。多条语音附件各自追加。
- **兜底(零回归)**:`transcribeVoice` 抛 `no_stt_config`(未配置)/ 网络错 / 返回空 → catch + log,`ctx.msg.text` 与附件**原样不动**(bot 仍看到 .amr,同今天)。一条语音转写失败不影响其余附件或整条消息。

### 依赖注入

中间件 deps:`{ transcribeVoice?: (buf: Buffer, mime: string) => Promise<{ text: string }>, readFile: (path) => Promise<Buffer>, log }`。`transcribeVoice` 缺省(未接线)→ 中间件整体 no-op(同 STT 未配置)。wiring 侧把 `ilink.voice.transcribe` 接进来(它内部 `loadSTTConfig`,未配置抛 `no_stt_config`——中间件 catch 掉)。`build.ts` 的 deps 结构 + pipeline-deps 组装同步加一项。

### 隐私/安全

语音字节本就是主人自己收到的消息内容;转写发往 gateway STT(同 TTS 的 `brain.youdamaster.cc`,同事共享无鉴权 posture,残留同 TTS)。不新增暴露面。转写文本按普通消息文本走既有管线(消毒/记忆/dispatch 不变)。

### 测试

`mw-transcribe-voice.test.ts`(纯注入):
- voice 附件(真实路径)+ transcribeVoice 返回文本 → msg.text 追加 `[语音] …`;
- 无 voice 附件 / 附件是 PENDING → 不调 transcribeVoice;
- transcribeVoice 抛 `no_stt_config` / 网络错 → msg.text 不变、不崩;
- 返回空文本 → 不追加;
- 多条语音各自追加;
- transcribeVoice 未注入 → no-op。
`build.ts` 组装顺序回归(mw 在 attachments 后 activity 前)。

## §2 盒子改 OpenAI 兼容 + 上线(ops,ssh 部署)

现成 `http-stt.ts` 客户端是 OpenAI 形状(字段 `file`、带 `model`、path `/v1/audio/transcriptions`、返回 `{text}`);盒子现有 `~/voice-svc/stt_server_cuda.py` 是 bespoke(字段 `audio`、path `/transcribe`、`{text,language}`)。**改盒子**(小)保持客户端 provider-agnostic:

- server 接 `POST /v1/audio/transcriptions`,字段 `file`,容忍/忽略 `model` 表单字段,返回 `{text}`(可保留 `language`);faster-whisper `large-v3-turbo` 用 PyAV 解码,**amr 原字节直吃,daemon 端不转码**。
- 绑 **tailscale IP 单口**(`100.101.160.96`,不再 `0.0.0.0`——同 voxcpm 硬化)。
- user systemd `stt.service`(照 `voxcpm.service`:conda/venv、`STT_MODEL=large-v3-turbo`、`systemctl --user enable --now`)。
- nginx `brain.youdamaster.cc:8443` 加 `location /stt/` → `proxy_pass http://100.101.160.96:8090/`(镜像 `/voice/`,strip `/stt/` 前缀;先备份 conf)。

## §3 配置 + 真机验证

- daemon(Mac 真机 + 需要的 dogfood 机)写 `stt-config.json` = `{provider:'http_stt', base_url:'https://brain.youdamaster.cc/stt/v1/audio/transcriptions', model:'large-v3-turbo', saved_at:<ISO>}`(经 `/v1/stt/save_config` 或直接写文件;`saved_at` 必填否则 loader 返回 null)。
- 验证:`GET /stt/health` 200 → 真发一条**无 ASR** 的微信语音 → daemon 日志见转写行 → bot 读到 `[语音] …` 并回复对上。§2/§3 记进本 spec 部署节 + 更新 `voice-tts-via-gateway` memory(STT 补齐)。

## 非目标

声线克隆;强制语种(whisper auto 够);桌面 UI 改动(`/companion/transcribe` 已在用);daemon 端 amr→wav 转码(whisper 直吃);gateway STT 路由鉴权(同 TTS 残留,留待统一处理);历史语音批量回填(只处理新入站)。
