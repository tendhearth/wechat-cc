# App Voice-Out (voice arc — Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the app conversation, an opt-in 🔊 toggle makes each CC text reply also be spoken — reusing Stage 0's converse text + the daemon's existing VoxCPM TTS config.

**Architecture:** New daemon route `POST /v1/companion/speak` synthesizes caller text via the daemon's existing `loadVoiceConfig`+`TTSProvider` and returns the audio as base64 in JSON. The operator token's `routeAllow` gains `speak`. A Tauri `agent_speak` command proxies; the webview decodes base64→Blob and plays via HTML5 Audio, gated by a localStorage toggle.

**Tech Stack:** daemon TypeScript (`src/`, vitest); Tauri Rust (`apps/desktop/src-tauri`, cargo); vanilla-JS webview.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-app-voice-out-design.md`. Key rules:
  - **Reuse synthesis** — do NOT rebuild TTS. `src/daemon/ilink/voice.ts` has `providerFromConfig(cfg): TTSProvider` and `TTSProvider.synth(text, voice) → {audio: Buffer, mimeType}` (`src/daemon/tts/types.ts:13`); `loadVoiceConfig(stateDir)` gives the config. The speak route does exactly what `replyVoice` does up to synth, then returns the bytes instead of ilink-sending. `reply_voice` behavior must stay byte-unchanged.
  - **Audio transport = base64 in JSON** (avoid a binary response path in the internal-api): `{ ok, audio_b64, mime }`.
  - **Operator token stays route-scoped**: `routeAllow` becomes `{POST /v1/companion/converse, POST /v1/companion/speak}` — nothing else. Session/file tokens unaffected.
  - **No voice config ⇒ clear error** (not a crash): route returns e.g. 422 `{ok:false, error:'no_voice_config'}`; the app surfaces it once.
  - Text path (converse) and `reply_voice` are untouched; the toggle defaults OFF.
- TDD for the daemon task; tsc clean; explicit `git add`. App tasks: cargo check + node --check + manual-verify (no JS test harness).

---

### Task 1: daemon `speak` route + synth reuse + operator routeAllow

**Files:** Modify `src/daemon/ilink/voice.ts` (extract synth helper if needed), `src/daemon/internal-api/routes.ts` (new route), `src/daemon/internal-api/route-tiers.ts`, `src/daemon/internal-api/types.ts` (a `synthesizeSpeech?` dep OR reuse an existing voice dep — see below), `src/daemon/internal-api/token-registry.ts` (routeAllow), wiring in `main.ts`/`pipeline-deps.ts`. Tests: `internal-api.test.ts`, `token-registry.test.ts`, and keep `voice`/`reply_voice` tests green.

**Interface:** the route needs to synthesize. Cleanest: add to the voice dep (or a new dep) a method
```ts
// returns synthesized audio for arbitrary text using the daemon's voice config,
// WITHOUT ilink-sending. null/throw if no voice config.
synthesizeSpeech(text: string): Promise<{ audio: Buffer; mime: string }>
```
Implement it in `src/daemon/ilink/voice.ts`'s `makeVoice(...)` (it already has `loadVoiceConfig` + `providerFromConfig` in scope — reuse them exactly as `replyVoice` does, minus the ilink send). Thread it onto `InternalApiDeps` (e.g. `deps.voice?.synthesizeSpeech` if the voice dep is already there, else a new optional dep) wired in main.ts.

**Route** `POST /v1/companion/speak`:
```ts
if (!deps.<voiceSynth>) return { status: 503, body: { error: 'voice_not_wired' } }
const { text } = body as { text?: unknown }
if (typeof text !== 'string' || text.trim().length === 0) return { status: 400, body: { error: 'text required' } }
try {
  const { audio, mime } = await deps.<voiceSynth>(text)
  return { status: 200, body: { ok: true, audio_b64: audio.toString('base64'), mime } }
} catch (err) {
  const m = errMsg(err)
  if (/no.?voice.?config|not configured/i.test(m)) return { status: 422, body: { ok: false, error: 'no_voice_config' } }
  return { status: 500, body: { ok: false, error: m } }
}
```
**route-tiers.ts:** `'POST /v1/companion/speak': 'admin'`.
**token-registry.ts:** `registerOperatorToken` routeAllow set now includes BOTH `'POST /v1/companion/converse'` AND `'POST /v1/companion/speak'`.

- [ ] **Failing tests:** speak route — 503 no synth dep; 400 empty text; no-voice-config ⇒ 422 `no_voice_config` (mock synth throws that); happy ⇒ mock synth returns `{audio: Buffer.from('RIFF...'), mime:'audio/wav'}` ⇒ `{ok:true, audio_b64, mime}` (assert base64 round-trips). token-registry: operator routeAllow has converse AND speak; still 403s on `GET /v1/sessions`. Confirm a `reply_voice`/voice test still green (synth extraction didn't change replyVoice).
- [ ] RED→GREEN. `bun --bun vitest run src/daemon/internal-api.test.ts src/daemon/internal-api/token-registry.test.ts src/daemon/ilink/voice.test.ts` (or wherever voice is tested); full `bun --bun vitest run` (name pre-existing failures); `bunx tsc --noEmit`.
- [ ] Commit (explicit paths): `feat(app-voice): POST /v1/companion/speak — synth reply audio (operator-scoped)`.

---

### Task 2: Tauri `agent_speak` command

**Files:** Modify `apps/desktop/src-tauri/src/lib.rs` (new command + register). Mirror `agent_converse` (same operator-token discovery via `operatorTokenFilePath`).

```rust
#[tauri::command]
async fn agent_speak(text: String) -> Result<SpeakOut, String> {
  // POST {base}/v1/companion/speak {"text":text} with the OPERATOR bearer
  // parse {ok, audio_b64, mime} → Ok({audio_b64, mime}) ; !ok/http-err → Err(error)
}
// SpeakOut: a small #[derive(Serialize)] struct { audio_b64: String, mime: String }
```
Register in `invoke_handler`.

- [ ] Implement; `cd apps/desktop/src-tauri && cargo check` clean (report the Finished/error line). If toolchain unavailable, STOP + DONE_WITH_CONCERNS.
- [ ] Commit: `feat(app-voice): agent_speak Tauri command → /v1/companion/speak`.

---

### Task 3: app UI — 🔊 toggle, autoplay, replay

**Files:** Modify `apps/desktop/src/modules/converse.js` (+ `apps/desktop/src/styles.css`, and `apps/desktop/src/mock.js` for a dev `agent_speak` mock). Read the existing `converse.js` from Stage 0 first.

- A 🔊 toggle in the compose row; persist its state in `localStorage` (`key: 'cc.voiceOut'`, default OFF).
- After a converse reply renders a CC bubble: if the toggle is ON, call `invoke('agent_speak', { text: reply })`, decode `audio_b64` → `Uint8Array` → `Blob([...], {type: mime})` → `URL.createObjectURL` → `new Audio(url).play()`; revoke the URL on `ended`.
- Each CC bubble gets a small ▶ replay button that re-runs the speak+play for that bubble's text (works regardless of the toggle).
- On `agent_speak` error: show a muted `🔇 语音失败` note on that bubble (reuse the empty-reply muted style from Stage 0's fix); if the error is `no_voice_config`, show `🔇 未配置语音` once (don't spam). No crash on any path.
- Autoplay policy: playing right after a user-initiated send is a user gesture chain — fine; if `.play()` rejects (autoplay blocked), fall back to leaving the ▶ button (no error note).

- [ ] Implement. Verify: `node --check apps/desktop/src/modules/converse.js`; `cd apps/desktop/src-tauri && cargo check` still clean; confirm toggle+replay wired. Manual end-to-end (tauri dev + daemon + voice config) noted as pending.
- [ ] Commit: `feat(app-voice): 🔊 toggle + autoplay + replay in the app conversation`.

## Self-Review notes

Spec §2 → T1 (route+synth+routeAllow) / T2 (Tauri) / T3 (toggle/playback). Reuse invariant: synth helper extracted from replyVoice's existing path, replyVoice byte-unchanged (pinned by keeping its test green). Operator token widens by exactly one route (speak), still fully scoped (negative test on /v1/sessions stays). Names: `synthesizeSpeech`/`voiceSynth` T1→(route); `agent_speak`/`SpeakOut` T2→T3; `audio_b64`/`mime` T1→T2→T3. Stage-0 residuals unchanged. base64-in-JSON avoids a binary response path.
