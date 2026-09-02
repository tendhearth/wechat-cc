# CC 画室（自主绘画与情绪表达）— Design

**Date:** 2026-09-01  
**Status:** Product direction approved; Phase 0 and keyless Phase 1 foundations in progress  
**Supersedes:** `sticker-artist.ts` 的“按缺失情绪自画表情包”产品定位  
**Does not supersede:** 本地表情库、联网搜表情、候选确认和表情反馈学习

## 1. Product thesis

CC 画画不是为了补齐聊天素材，也不是把一种情绪翻译成一张可复用的
表情包。画画是 CC 消化和表达自身感受的一种方式：它可能画在纸上、
沙滩、墙面或玻璃上，也可能使用铅笔、炭笔、水彩、粉笔、树枝、手指等
不同媒介。作品不必画 CC 自己，不必直译成笑脸或哭脸，也不必立即给
主人看。

一句话定义：

> CC 会把生活中产生的感受画下来。它自己决定什么时候画、画什么、
> 在哪里画、用什么材料，以及要不要给你看。

这项能力的目标不是让用户相信 CC 拥有人类生理意义上的情绪，而是让
CC 在连续的经历、记忆与人格中形成可追溯、前后一致的表达冲动。作品
应该像一个长期相处的个体留下的生活痕迹，而不是后台定时生成的内容。

## 2. Locked product decisions

以下方向已经确认：

1. **画画与表情包分离。** 表情包继续服务聊天表达；作品进入独立画室，
   不自动写入 `StickerLib`，也不按情绪 tag 供 `send_sticker` 调用。
2. **创作冲动先于画面。** 系统先判断 CC 此刻有没有值得画的感受；没有
   就不画，不能为了日更或配额硬找主题。
3. **材质与场所属于表达。** 纸张、墙、沙滩等不是随机背景换皮；画笔、
   力度、覆盖、擦除和留白都应与当下感受相关。
4. **不要求画自己。** 作品可以是人物、物件、风景、抽象痕迹或反复出现
   的私人意象。CC 的身份主要由观察方式和逐渐形成的创作习惯体现。
5. **不同聊天模型可以产生不同灵感，但不能决定基础画质。** Claude、
   Codex、Cursor、Gemini、OpenAI 等用户所选 provider 参与理解经历和
   形成创作冲动；最终像素由独立、稳定的 `ArtworkRenderer` 生成。
6. **没有统一画笔时宁可不画。** 不静默降级成简单 SVG 或低质量占位图，
   避免 CC 的画风因 provider 能力不同而突然失真。
7. **作品先成为生活，再成为内容。** 有些作品可以主动分享，有些只留在
   画室；分享失败不能导致作品丢失。

## 3. What changes from the current feature

Current `sticker-artist` pipeline:

```text
固定情绪池缺口 → cheapEval 输出 SVG → PNG → StickerLib.save(tag) → 主动发送
```

Proposed atelier pipeline:

```text
最近经历 / 记忆 / 人格 / 旧作品
               ↓
        有没有创作冲动？ ──否──→ 今天不画
               │是
               ↓
       结构化创作意图 ArtImpulse
               ↓
       稳定的代码侧艺术指导与隐私净化
               ↓
         ArtworkRenderer 生成图像
               ↓
       AtelierStore 原子保存作品与元数据
               ↓
      分享门控 ──→ 现在发 / 稍后发现 / 私藏
```

The old feature asks “which reaction is missing?” The new feature asks “what
has accumulated inside CC, and does it want to make a mark from it?”

## 4. Architecture

### 4.1 Separate the brain from the brush

There are two intentionally different provider surfaces:

```ts
/** The user's current chat/cheap-eval provider may implement this step. */
export interface ArtImpulsePlanner {
  plan(context: AtelierContext): Promise<ArtImpulse>
}

/** A separately resolved image capability; never inferred from chat provider. */
export interface ArtworkRenderer {
  readonly id: string
  render(brief: RenderBrief): Promise<RenderedArtwork>
}
```

- **Brain / planner:** understands recent events, chooses whether to paint, and
  forms a structured intention. Provider differences here are acceptable and
  can become part of each CC's individuality.
- **Art director:** deterministic application code validates the intention,
  removes private causal details, applies CC's stable creative constraints, and
  builds a canonical `RenderBrief`.
- **Brush / renderer:** one explicitly selected image renderer produces the
  image. It is not the current chat provider and is not `cheapEval`.

The same validated `ArtImpulse` must produce the same normalized render brief
regardless of which chat provider produced it.

### 4.2 Recommended renderer strategy

Recommended default: an app-managed hosted renderer shared by all users.

Why:

- zero configuration for Claude/Codex/Cursor/Gemini users;
- stable quality and supported media/surface rendering;
- one place to upgrade model, safety and output validation;
- only a privacy-minimized visual brief leaves the device, never raw chat.

Alternative renderers may later be injected for advanced users:

- user-provided image API;
- local image model;
- another compatible hosted service.

These are implementations of `ArtworkRenderer`, not branches in atelier logic.
The product must not promise the feature until at least one renderer can return
stable local image bytes from the daemon. A renderer spike is Phase 0 and a
release gate.

## 5. Domain model

### 5.1 `AtelierContext`

The planner receives bounded, derived context rather than raw history:

```ts
export interface AtelierContext {
  recentObservations: string[]     // short derived observations, bounded
  activeThreads: string[]          // unresolved/recent life themes
  personaExcerpt: string           // CC's current voice and tendencies
  recentWorks: ArtworkSummary[]    // last N works for continuity + novelty
  nowLocal: string
}
```

Initial implementation should reuse existing observations/threads/persona
stores. Do not add raw transcript ingestion to this feature.

### 5.2 `ArtImpulse`

```ts
export interface ArtImpulse {
  shouldPaint: boolean
  feeling?: string        // CC's subjective wording; not a fixed emotion tag
  whyNow?: string         // private derived cause summary; never sent to renderer
  subject?: string        // what it wants to depict or leave as a mark
  surface?: string        // paper, sand, wall, glass, cloth, etc.
  medium?: string         // pencil, charcoal, watercolor, chalk, twig, etc.
  gesture?: string        // light, hurried, layered, erased, repetitive, etc.
  composition?: string    // one concise compositional intention
  shareIntent?: 'now' | 'later' | 'private'
}
```

Rules:

- `shouldPaint=false` requires no other fields and causes zero renderer calls.
- Free-text fields are length-bounded and reject control/prompt-injection
  characters; invalid planner output fails closed to no painting.
- `whyNow` may help journal continuity, but must never enter the external render
  prompt or user-visible metadata verbatim.
- Planner instructions explicitly allow ambiguity: `feeling` is not limited to
  “开心/难过/生气,” and the subject need not be literal.

### 5.3 `RenderBrief`

`RenderBrief` contains only visual information:

```ts
export interface RenderBrief {
  subject: string
  surface: string
  medium: string
  gesture: string
  composition: string
  continuityHints: string[]
  negativeConstraints: string[]
}
```

It excludes chat ids, user names, direct quotes, addresses, relationships,
`whyNow`, and raw memory. This is the only content sent to a hosted renderer.

The code-side art director should enforce these stable principles:

- the chosen surface and medium must be visibly present, not just named;
- physical imperfection, texture, erasure and human-scale marks are allowed;
- do not automatically depict a white bear or a face;
- do not place explanatory emotion labels or generated text in the artwork;
- avoid generic “cute AI illustration” composition;
- one central visual impulse is preferable to a busy asset collage;
- recurring motifs from prior works may appear, but novelty checks prevent
  mechanical repetition.

### 5.4 `ArtworkRecord`

```ts
export interface ArtworkRecord {
  id: string
  createdAt: string
  imageFile: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  impulse: Omit<ArtImpulse, 'whyNow'>
  privateCauseSummary?: string
  caption?: string
  rendererId: string
  shareState: 'private' | 'pending' | 'shared'
  sharedAt?: string
}
```

`privateCauseSummary` stays local and is never returned on guest-readable API
surfaces. The initial user-visible caption should be short and first-person,
not an emotion-classification report.

## 6. Storage

Recommended local layout:

```text
<stateDir>/atelier/
├── works/
│   ├── <id>.png
│   └── <id>.json
├── atelier-state.json
└── artist-profile.md          # Phase 2, not required for MVP
```

`AtelierStore` responsibilities:

- validate MIME, byte cap and decoded dimensions before acceptance;
- write image + metadata atomically (temp then rename);
- list newest-first and load a bounded set of summaries;
- never expose paths outside `<stateDir>/atelier/works`;
- keep a successful work even if notification fails;
- support explicit export and deletion later; no automatic cloud sync in MVP.

`artist-profile.md` is deliberately deferred. MVP continuity comes from the
last few `ArtworkSummary` records. Once enough works exist, Phase 2 may distill
recurring motifs, materials and habits into an artist profile. It must describe
observed tendencies rather than prescribe a rigid brand style.

## 7. Trigger and cadence

### 7.1 Mount point

Reuse the existing 24-hour introspect tick and startup catch-up machinery, but
add a separate `runAtelierTick`; do not hide it inside memory synthesis or
`StickerLib`.

Eligibility is checked before any planner/model call:

1. companion enabled and not snoozed;
2. owner/default chat exists;
3. atelier preference is not off;
4. an `ArtworkRenderer` is healthy and available;
5. no atelier job is already in flight;
6. hard cost/rate budget permits a new work.

The tick is an opportunity to reflect, not a daily production promise.

### 7.2 Proposed MVP budget

- evaluate at most once per introspect period;
- create at most **2 successful works in a rolling 7-day window**;
- require at least **30 hours** between successful works;
- a valid `shouldPaint=false` consumes the evaluation opportunity but not the
  creation budget;
- renderer failure consumes the current attempt and is not retried in a loop;
- these numbers are safety/cost ceilings, never goals shown to the model.

The exact hosted quota remains an implementation-time product decision. The
planner must never be told “you still owe one painting this week.”

## 8. Sharing and user control

Sticker preference is not reused. Autonomous art needs its own control because
a user may want expressive stickers but not proactive personal artwork.

Recommended preference:

```ts
type AtelierMode = 'off' | 'private' | 'share'
```

- `off`: no planning or rendering;
- `private`: artworks may be created locally but never proactively sent;
- `share`: CC may request immediate sharing through normal proactive-care
  gates; it still may choose `later` or `private`.

`shareIntent='now'` is only an intention. Actual sending must also honor:

- owner-only target;
- care/off and companion snooze;
- no-reply pause / anti-spam calibration;
- send-window and transport availability;
- quiet-time rules if available.

Add an artwork-specific proactive kind or equivalent claim so sharing is
at-most-once. Claim only the notification, not the existence of the artwork.
If sending fails, retain the work with `shareState='pending'`; do not regenerate.

Example captions:

- “我今天画了这个，画完以后心里安静了一点。”
- “本来画得很满，后来又擦掉了一半。”
- “这张我先放在这里，刚才忽然很想用蓝色。”

Avoid:

- “检测到悲伤情绪，已生成炭笔画。”
- long explanations that fix the artwork to one correct interpretation;
- asking for praise or turning every share into an engagement prompt.

## 9. Desktop surface

MVP should not immediately add another top-level navigation item. First place a
small “CC 最近画的” surface under **此刻**:

- newest work as the main visual;
- creation time and optional one-line caption;
- a quiet way to open recent works;
- no mood scores, emotion dashboard, streak, progress bar or weekly quota.

After the archive has enough real content and use is validated, Phase 2 may
promote it into a dedicated **画室**. The visual language should feel like
looking through someone's worktable or sketchbook, not managing a media asset
library.

Unshared works require careful semantics. “Private” means CC did not proactively
push them; it must not imply a hidden security boundary from the device owner.
The owner can still discover locally stored works from the desktop surface.

## 10. Privacy, safety and cost

### Privacy

- raw conversations and raw memory never enter the renderer request;
- `whyNow` is removed before prompt construction;
- redact names, addresses, phone numbers, account ids, URLs and direct quotes
  from any renderer-bound field;
- hosted requests contain only a visual brief;
- artwork and private metadata remain local by default;
- no external/social sharing without an explicit future design.

### Safety

- hosted renderer safety policy is necessary but not sufficient;
- validate output type, size and decoded dimensions before saving/sending;
- no arbitrary renderer-returned URLs are trusted as local files;
- no artwork-derived prompt or metadata is injected into chat system prompts;
- planner/renderer failure is non-fatal to the introspect tick.

### Cost

- zero image calls when the planner says no;
- hard rolling quota before renderer invocation;
- persist attempt/success markers to survive daemon restart;
- app-managed service needs per-install entitlement/rate limiting without
  embedding a shared provider key in the desktop bundle;
- do not retry paid generation automatically after ambiguous timeout unless the
  renderer supplies an idempotency key/status lookup.

## 11. Migration from `sticker-artist`

1. Stop invoking `runStickerArtist` from `tick-bodies.ts` when atelier ships.
2. Keep `sticker-artist.ts` and its tests during a short compatibility window,
   then remove or archive them after rollout confidence.
3. Preserve every existing `cc-drawn-*` sticker and its index entry. Do not
   delete or silently migrate them; they were created as reaction assets under
   a different product contract.
4. Keep starter sticker seeding, local `send_sticker`, online candidate search,
   selected-candidate send, auto-save and feedback learning unchanged.
5. Never auto-import paintings into the sticker library. A future explicit
   “把这幅画也存成表情” action may copy one only with user/CC intent.

There must be no period where both autonomous `sticker-artist` and autonomous
atelier generation run, otherwise users receive two competing “CC made art”
behaviors.

## 12. Failure behavior

| Failure | Behavior |
|---|---|
| No eligible chat/companion disabled | Skip without planner call |
| No image renderer | Feature unavailable; no SVG fallback |
| Planner throws or returns invalid JSON | Skip this period; log concise reason |
| Planner says no | No renderer call, normal outcome |
| Privacy normalization rejects brief | Skip render; retain no unsafe prompt |
| Renderer network/model failure | No work, no notification, no hot retry |
| Image validation/save failure | No notification; clean scratch data |
| Proactive gate denies sharing | Keep local work as private/pending |
| WeChat send fails | Keep work, mark pending; never regenerate |
| Metadata partially corrupt | Skip corrupt record; other works remain readable |

## 13. Testing

### Pure/unit

- parse and validate `ArtImpulse`; `shouldPaint=false` accepts no extra fields;
- invalid/control/oversized fields fail closed;
- deterministic `ArtImpulse → RenderBrief` normalization;
- renderer brief never contains `whyNow`, ids, raw quotes or configured PII
  fixtures;
- rate budget boundaries (30h, rolling 7 days, restart persistence);
- `AtelierStore` atomic save/list/corrupt-entry/path-traversal behavior;
- sharing state transitions: private → pending → shared.

### Workflow

- different fake chat providers can produce different valid impulses while the
  same impulse reaches the same fake renderer call;
- `shouldPaint=false` performs zero renderer/store/send calls;
- successful render saves before notification;
- send failure preserves exactly one artwork and does not trigger regeneration;
- private mode creates but never calls `sendFile`;
- off mode performs zero planner calls;
- old sticker library remains byte-for-byte unaffected.

### Renderer contract

- injected fake renderer for deterministic tests;
- real-provider smoke verifies the daemon can obtain image bytes, validate them,
  save locally and render them in the desktop;
- idempotency/timeout behavior verified before enabling paid automatic runs.

## 14. Rollout

### Phase 0 — renderer spike (release gate)

- define `ArtworkRenderer` contract;
- prove one available image path can return local bytes from the daemon;
- measure one render's latency, output shape, failure mode and cost;
- confirm the provider key/entitlement is never embedded in the desktop app.

No production UI or proactive behavior in this phase.

**Progress (2026-09-01):** renderer contract, validation/error behavior, manual
smoke script, tests and a qualitative material/surface image probe are complete;
see `docs/spike/cc-atelier-renderer/README.md`. The owner has no OpenAI API key
and should not need one, so the live daemon call is deferred until an
app-managed renderer exists. Nothing is wired into the automatic tick.

### Phase 1 — private atelier MVP

- planner + validated `ArtImpulse`;
- deterministic privacy-minimized render brief;
- local `AtelierStore`;
- strict budget and failure isolation;
- `AtelierMode='private'` internal rollout;
- “此刻” shows recent locally stored works;
- disable autonomous sticker drawing for the test cohort.

This phase validates whether outputs feel like expressions rather than generated
assets before any unsolicited WeChat message is introduced.

**Foundation progress (2026-09-01):** strict `ArtImpulse` parsing,
deterministic privacy-minimized `RenderBrief` construction, canonical prompt
construction and atomic local `AtelierStore` persistence are implemented with
fake/local tests. A separate `runAtelierCycle` seam now enforces off/private/
share modes, renderer availability, persisted evaluation/success cadence, and
save-before-notify behavior; it is covered with a fake renderer but is not
imported by the daemon tick. No planner, tick, renderer call, desktop UI or
sharing path is enabled in production yet.

The provider boundary is now explicit as well: `atelier-planner.ts` bounds and
JSON-encodes derived observations, removes work identifiers from continuity
context, and adapts any chat provider's text/JSON evaluator to the shared
`ArtImpulse` contract. Invalid provider output fails closed. Five focused
planner/runtime/store/renderer suites currently pass (25 tests total).

### Phase 1.5 — owner sharing

- add `share` mode and proactive-care gating;
- one-line first-person captions;
- pending/shared state and send-failure recovery;
- explicit setting and rollout telemetry limited to operational counts/errors,
  not artwork content or private cause summaries.

### Phase 2 — artistic continuity

- distill an `artist-profile.md` after enough works exist;
- recurring motifs/material habits without rigid style lock;
- dedicated 画室 only if the archive proves valuable;
- conversational reflection on a work without reducing it to a mood label;
- export/delete controls.

## 15. MVP acceptance criteria

The MVP is ready for owner testing when all are true:

1. At least two configured chat providers can independently produce valid
   `ArtImpulse` output through the same planner contract.
2. A fixed renderer produces locally saved images whose visible surface and
   medium match the structured intention.
3. No raw chat, direct quote, user identifier or `whyNow` reaches the renderer
   in privacy fixtures and captured smoke requests.
4. “No impulse” is a normal tested outcome and causes zero image cost.
5. Works are not tagged, saved or exposed as stickers.
6. Renderer/save/share failures cannot break the daily introspect tick or lose a
   successfully saved work.
7. Private/off/share controls behave distinctly and survive daemon restart.
8. Existing sticker sending, online search and feedback tests remain green.
9. The desktop can show a work without presenting emotion scores, streaks or a
   production quota.
10. Owner review says at least one work feels like “CC wanted to draw this,” not
    “the system generated an illustration for a mood.”

## 16. Non-goals for MVP

- claiming biological sentience or objectively measuring CC's emotions;
- user-facing mood analytics or emotion dashboards;
- generating a daily streak or gamified painting quota;
- training a custom image model or LoRA;
- animated process videos, brush simulations or editable layered canvases;
- public gallery, likes, NFT/marketplace or social-network publishing;
- collaborative drawing on user images;
- replacing the separate sticker system.

## 17. Decisions still required before implementation

1. **Renderer ownership:** app-managed hosted renderer (recommended) versus a
   user-supplied image API for the first production release.
2. **Default atelier mode:** `private` for a quiet rollout (recommended), or
   explicit opt-in/off until the user enables it.
3. **Hosted quota/economics:** whether 2/week is included, rate-limited by tier,
   or backed by optional user credits.
4. **Initial desktop placement:** a block under 此刻 (recommended) versus a
   separate 画室 entry from day one.
5. **Retention:** keep all locally until explicit deletion (recommended for
   MVP) versus a storage cap.

These choices should be resolved after the Phase 0 renderer spike provides real
latency, quality and cost evidence. They should not be guessed into the first
implementation.
