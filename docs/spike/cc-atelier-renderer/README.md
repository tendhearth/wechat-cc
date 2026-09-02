# CC Atelier renderer — Phase 0 spike

Date: 2026-09-01  
Status: contract + visual direction verified; owner has no API key, so paid live smoke is deferred to the future app-managed renderer

## Questions

1. Can the daemon use a chat-provider-independent image renderer and receive
   local image bytes?
2. Can it fail closed without falling back to the user's Claude/Codex/Cursor/
   Gemini provider?
3. Can the visual brief express emotion through physical medium and setting
   rather than a literal mood label or mascot face?
4. What still blocks a real paid end-to-end smoke?

## Official API finding

OpenAI's image-generation guide recommends the Image API for a single image
from one prompt, while the Responses API is more suitable for conversational,
multi-step editing. The Image API example returns `b64_json`, which can be
decoded and written directly to a local file.

- Guide: https://developers.openai.com/api/docs/guides/image-generation
- Model: https://developers.openai.com/api/docs/models/gpt-image-2

The Phase-0 implementation therefore uses `POST /v1/images/generations` behind
an `ArtworkRenderer` interface. It is not wired into the daemon tick.

## Implemented probe

- `src/daemon/artwork-renderer.ts`
  - provider-independent `ArtworkRenderer` contract;
  - direct OpenAI Image API implementation, default `gpt-image-2`;
  - injected fetch/model/base URL/time/limits for testing;
  - one request only, no automatic paid retry;
  - timeout, HTTP, missing-output, PNG-magic and byte-cap validation;
  - errors do not echo the API key, visual prompt or provider response body.
- `src/daemon/artwork-renderer.test.ts`
  - 5 passing contract/error tests.
- `scripts/atelier-renderer-spike.ts`
  - explicit, manual, paid smoke only;
  - refuses to run without `OPENAI_API_KEY`;
  - writes one validated image locally and reports renderer/request/latency
    metadata without printing credentials or prompt.

Validation on 2026-09-01:

```text
bun --bun vitest run src/daemon/artwork-renderer.test.ts
  1 file passed, 5 tests passed

bun run typecheck
  passed

bun run spike:atelier-renderer
  OPENAI_API_KEY is not set; live renderer smoke was not run. (exit 2)
```

## Visual direction probe

`sand-fish-concept.png` was generated through the built-in image-generation
surface as a qualitative prompt test, not through the daemon/API renderer.

- dimensions: 1402 × 1122
- bytes: 2,052,427
- SHA-256: `e90273a71ac220d2e15616efd86d916a3c6795f6b374d1dcb642baa3213e323e`
- observed generation wall time: approximately 26 seconds

The prompt deliberately requested an unseen companion drawing two almost-facing
fish in wet sand with a softened twig while a wave erased half of one fish. It
forbade text, mood labels, mascot faces, hearts and sticker aesthetics.

Result: the image visibly carries wet-sand grain, twig grooves, water-softened
marks, partial erasure and unresolved distance. This supports the product thesis
that surface, material and gesture can express the state without drawing a
literal “sad” face. It is a direction sample, not a locked house style.

## Conclusion and remaining gate

The renderer contract, byte path, validation behavior and visual-brief direction
are viable. A real daemon-to-provider call cannot be claimed yet because this
environment has no `OPENAI_API_KEY`. The owner does not have one and should not
need to create one: the product direction calls for an app-managed renderer
rather than silently borrowing each user's chat provider or requiring a
per-user image credential.

Keyless Phase-1 domain and storage work may continue with a fake renderer, but
automatic generation remains disabled until the product provisions:

1. an app-managed hosted renderer/relay credential;
2. per-install entitlement and rate limiting; and
3. a production smoke path that records latency, response size, request id,
   failure shape and cost without exposing the upstream credential.

The live smoke is an enablement gate, not a reason to make the owner buy an API
key and not a blocker for offline planner/privacy/store tests.

## Keyless continuation

The next foundation is implemented without a provider key:

- `src/daemon/art-impulse.ts` validates planner output and builds a visual-only,
  privacy-minimized brief;
- `src/daemon/atelier-store.ts` atomically stores validated local PNG works and
  metadata;
- `src/daemon/atelier-runtime.ts` enforces `off`/`private`/`share`, persisted
  cadence (30 hours between successes, at most two in seven days), no-impulse
  zero-call behavior, and save-before-notify recovery.
- `src/daemon/atelier-planner.ts` bounds derived context and adapts any selected
  chat provider's evaluator to the strict `ArtImpulse` contract; work ids and
  raw multiline control characters do not enter the planner prompt.

The runtime is a test seam only. It is not wired into the automatic tick and
the current test renderer is fake, so this continuation makes no network calls
or image charges. The five focused suites currently pass (25 tests total).

## Local renderer (2026-09-01)

The renderer-ownership decision resolved to **local, free, per-user** rendering
(spec: `docs/superpowers/specs/2026-09-01-cc-atelier-local-renderer-design.md`).
Implemented and unit-tested (Apple Silicon Phase 1):

- `src/daemon/sidecar-renderer.ts` — `makeSidecarRenderer` spawns
  stable-diffusion.cpp (`sd-cli`) once per render, times out a wedged process,
  and validates the output PNG; `buildSdCliArgs` isolates the argv.
- `src/daemon/atelier-renderer-resolve.ts` — `resolveAtelierRenderer` returns a
  renderer only on Apple Silicon with the bundled binary + provisioned model,
  else `null` (⇒ `skipped_no_renderer`, a cost-free no-op).
- `src/daemon/atelier-model-provision.ts` — first-enable model download with
  SHA-256 verification and skip-if-present.
- `src/daemon/artwork-renderer.ts` — extracted the shared `validatePngBytes`.

All 46 Atelier tests pass (25 prior + 21 new/changed); full repo suite green;
typecheck clean. Still **not** wired into the daemon tick.

**Not yet done (needs a Mac build):** bundling the real `sd-cli` binary as a
Tauri `externalBin` sidecar, pinning the default model URL/SHA-256, and the
manual real-spawn smoke (`scripts/atelier-sidecar-smoke.ts`). See Task 6 of
`docs/superpowers/plans/2026-09-01-cc-atelier-local-renderer.md`.
