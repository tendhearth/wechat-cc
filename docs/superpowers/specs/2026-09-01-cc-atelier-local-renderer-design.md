# CC Atelier local renderer design

**Date:** 2026-09-01
**Status:** Approved for spec review; implementation not started
**Parent:** `2026-09-01-cc-atelier-design.md` (resolves the §17.1 "renderer
ownership" and §17.3 "hosted quota/economics" open decisions)

## 1. Decision and rationale

CC Atelier renders on **each user's own machine, for free**. Autonomous
drawing is a default capability every user's CC can have, not a paid tier.

- The product is not at a paid stage, so per-image cost must be zero.
- A hosted renderer would make the product owner pay per image for every
  user, growing without bound with the user base, and would require a
  per-user entitlement/metering/abuse subsystem. Rejected for now.
- Requiring each user to supply an image API key was already rejected by the
  parent design (§17): poor UX, extractable keys.

Therefore the "brush" is a **local Stable Diffusion engine bundled with the
desktop app**. The "brain" (whether/what to draw) continues to use the chat
provider the user already pays for; only the brush changes.

## 2. Engine: stable-diffusion.cpp

The engine is [`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp)
(`sd-cli`). Verified 2026-09-01:

- ships a **CLI binary** `sd-cli` (an embedded web UI also exists as of
  2026-04, but the CLI is the path we use);
- supports the **Apple Metal** backend on macOS;
- accepts `ckpt` / `safetensors` / `gguf` weights;
- covers SD1.x, SD2.x, SDXL, **SD-Turbo**, SDXL-Turbo, SD3/3.5, FLUX;
- **writes a PNG file** (with webui-compatible metadata embedded);
- modest memory: ~2.3 GB for a 512×512 fp16 txt2img.

Because generation happens at most twice per week (parent §7.2), the renderer
**spawns `sd-cli` per render and reads the output PNG**. There is no resident
server and no localhost port — a per-render process that exits after each
image is simpler and more robust than a long-lived HTTP server.

### 2.1 Model

- Default candidate: **SD-Turbo** (confirmed supported, few-step, fast).
  The official single-file safetensors artifact is 5.21 GB; this is a
  qualification candidate until packaging and disk-UX are finalized.
- SDXL-Turbo is listed by the repo overview but an older discussion reports it
  unsupported; treat SDXL-Turbo as an implementation-time quality upgrade to
  verify against the actual binary, not a launch requirement.
- Sampling: few steps (turbo 1–4), 512×512. The model and prompt path must be
  tested across materially different choices—such as watercolor, pencil or
  pen sketch, and oil/oil-pastel—not optimized around one permanent painterly
  look. The goal is a quiet, expressive work whose marks truthfully belong to
  the medium CC selected for that moment.

## 3. Architecture and component boundaries

```
introspect tick
  → planner → ArtImpulse            (implemented: atelier-planner.ts, art-impulse.ts)
  → RenderBrief (privacy-minimized) (implemented: art-impulse.ts)
  → ArtworkRenderer.render(prompt)  (NEW local implementation)
       → spawn sd-cli -m <model> -p <prompt> -o <tmp.png>
       → wait with timeout watchdog
       → read + validate PNG bytes  (reuse artwork-renderer.ts validators)
  → AtelierStore.save(...)          (implemented: atelier-store.ts)
```

No network access and no cost anywhere in this path.

### 3.1 `makeSidecarRenderer`

A second implementation of the existing `ArtworkRenderer` interface
(`src/daemon/artwork-renderer.ts`), alongside `makeOpenAiImageRenderer`. It:

- resolves the bundled `sd-cli` path and the local model path;
- writes the visual prompt to `sd-cli` via argv (never logs it);
- spawns `sd-cli -m <model> -p <prompt> -o <tmp.png> --steps <n> --width 512
  --height 512` (exact flags pinned at implementation time against the built
  binary) into a private temp directory;
- reuses the existing PNG magic-number check, byte-cap check, and
  "errors never echo the prompt / model bytes" behavior from
  `artwork-renderer.ts`;
- returns `RenderedArtwork` bytes; persistence stays in `AtelierStore`.

Injectable dependencies (for tests, no real spawn): a `spawn`-like function,
the `sd-cli` path, the model path, timeout, byte cap, and a clock.

### 3.2 Sidecar packaging

`sd-cli` is bundled as a Tauri **`externalBin`** sidecar. The desktop app
already uses `externalBin` and a `build-sidecar` step
(`apps/desktop/src-tauri/tauri.conf.json`); that step is extended to build or
fetch a pinned `sd-cli` for the target arch. Model weights are **not** bundled.

### 3.3 Model provisioning

Weights download on **first enable** (when the user first switches Atelier
mode from `off` to `private`), to `~/.wechat-cc/atelier/models/`, mirroring the
MeetingNotes provision pattern:

- shows progress, is cancelable;
- verifies SHA-256 of the downloaded file;
- resumable / retryable on failure;
- default mode stays `off`, so no download happens until the user opts in.

## 4. Failure isolation

Reuses the parent design's guarantees; the renderer must never break the
introspect tick.

- **Timeout watchdog** around the spawn (same philosophy as `http-stt.ts`): a
  wedged `sd-cli` can never stall the tick. On timeout → kill the process →
  `ArtworkRendererError('renderer_timeout')` → fail-closed.
- Non-zero exit → `renderer_http_error`-class error (rename to a
  spawn-appropriate code, e.g. `renderer_exec_error`).
- Output missing / not PNG → `renderer_bad_output`; over byte cap →
  `renderer_output_too_large`.
- **No retry.** A failed attempt consumes the current attempt and is not
  retried in a loop.
- Renderer failure is non-fatal to the introspect tick and never loses an
  already-saved work (guaranteed by `atelier-runtime.ts`).

## 5. Platform phasing and hardware gating

The product ships on **macOS, Windows, and Linux** (Tauri `nsis`/`msi`/`deb`/
`appimage` targets; three-OS CI). `stable-diffusion.cpp` is itself
cross-platform (Metal on macOS; CUDA/Vulkan on Windows/Linux NVIDIA and other
GPUs; CPU fallback everywhere), so local free rendering is **not** Mac-only.

**Phase 1 targets Apple Silicon (Metal) only.** This is a sequencing choice,
not a permanent exclusion of non-Mac users. Phase 1 of the parent design is a
private internal validation of whether outputs "feel like expression"; that
only needs one working platform (the owner's Mac). Windows and Linux support
is a **planned follow-up** that reuses the same `makeSidecarRenderer` and adds
per-platform `sd-cli` builds (CUDA/Vulkan/CPU backends) plus slow-CPU
degradation UX.

The real capability gate is **hardware, not OS**: a machine with a capable GPU
renders in seconds; a weak/no-GPU machine renders slowly on CPU (still free) or
is marked unavailable. Phase 1 encodes this as: Apple Silicon + model
provisioned + sufficient disk ⇒ available; anything else ⇒ unavailable.

An unavailable renderer routes through the existing fail-closed path in
`atelier-runtime.ts`: the cycle no-ops — no drawing, no error shown to the
user, no cost. This behavior is already tested.

## 6. Testing (vitest, injected fake spawn)

No real `sd-cli` spawn in unit tests; the spawn function is injected.

- happy path: fake spawn writes a valid PNG → renderer returns those bytes;
- timeout → kill → `renderer_timeout`;
- non-zero exit → exec error;
- output not PNG → `renderer_bad_output`;
- output over cap → `renderer_output_too_large`;
- errors never contain the prompt;
- renderer-unavailable → `atelier-runtime` cycle no-ops (reuse existing
  runtime tests);
- model provisioner: SHA-256 verification, resume, and failure-retry tests.

A single, manual, opt-in real-spawn smoke (analogous to
`scripts/atelier-renderer-spike.ts`) generates one image with the actual
`sd-cli` and bundled model, reporting latency and output size. It is never
invoked by the daemon or CI.

## 7. Scope

**In scope (this spec):** `makeSidecarRenderer`, `sd-cli` sidecar packaging,
the model provisioner, and their tests — enough to produce and locally save
one real image end-to-end, default-off, with no automatic trigger.

**Out of scope (separate later steps):**

- **Windows and Linux support** (per-platform `sd-cli` builds with
  CUDA/Vulkan/CPU backends and slow-CPU degradation UX) — a planned follow-up
  reusing this spec's `makeSidecarRenderer`, not a permanent exclusion (§5);
- wiring the renderer into the daemon introspect tick (the tick already has a
  default-off `runAtelierTick?` seam);
- the "此刻" desktop view of stored works;
- `share` mode and proactive sending.

## 8. Acceptance criteria

1. On an Apple Silicon Mac with the model provisioned, `makeSidecarRenderer`
   produces a locally saved, validated PNG from a text prompt with no network
   access and no charge.
2. A wedged / slow / crashing `sd-cli` cannot stall or break the introspect
   tick; every failure mode maps to a typed `ArtworkRendererError` and no
   retry loop.
3. Errors never echo the visual prompt.
4. On unsupported hardware or before the model is downloaded, the renderer is
   unavailable and the Atelier cycle no-ops with zero cost.
5. Model provisioning verifies integrity, resumes, and retries; default mode
   `off` downloads nothing until the user opts in.
6. All existing Atelier suites (25 tests) and sticker/search/feedback tests
   remain green.

## 9. Open items to pin at implementation time

- exact `sd-cli` flags and step count against the built binary;
- final default model (SD-Turbo vs a verified SDXL-Turbo) and its download URL
  + SHA-256;
- whether that model can keep watercolor, pencil/pen line, and oil/oil-pastel
  materially distinct instead of collapsing them into photography or one
  generic house style;
- `sd-cli` build/fetch mechanism inside `build-sidecar` for the release arch.
