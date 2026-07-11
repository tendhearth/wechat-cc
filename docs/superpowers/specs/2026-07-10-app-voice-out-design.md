# Design: App Voice-Out (voice arc — Stage 1)

Date: 2026-07-10
Status: approved design → implementation
Origin: voice arc Stage 1 (0 text-foundation ✓ → **1 CC voice-out** → 2 push-to-talk in → 3 streaming). The CC speaks its replies inside the app — the first sensory dimension WeChat cripples (WeChat only drops a voice *file*; the app plays real audio).

## 1. What

In the app conversation, an opt-in "🔊" toggle makes each CC text reply ALSO be spoken aloud. Reuses Stage 0's converse (text) + the VoxCPM TTS gateway already deployed. Text is unchanged; audio is an additive layer.

## 2. Locked decisions

- **Opt-in toggle**, default OFF (TTS adds ~3-5s latency; the owner opts in). State lives in the webview (localStorage) — Stage-0-simple, no daemon pref needed.
- **TTS is server-side**: new daemon route `POST /v1/companion/speak` { text } → the daemon synthesizes via its EXISTING `loadVoiceConfig` + `http-tts`/`qwen` provider (the VoxCPM gateway `voice-config.json` already points at) → returns the audio bytes (`audio/wav`, or whatever the provider yields) with the right content-type. Voice config + gateway credentials stay in the daemon; the app never sees them.
- **Auth**: `speak` is added to the operator token's `routeAllow` set (now `{POST /v1/companion/converse, POST /v1/companion/speak}`). Still admin-tier + route-scoped. Speak is lower-risk than converse (it only synthesizes caller-supplied text — no session/memory access), so a leaked token can at worst TTS arbitrary text.
- **Playback**: after converse returns text and renders the CC bubble, if the toggle is ON the webview calls `agent_speak(text)` (new Tauri command mirroring `agent_converse`, using the operator token), gets the audio bytes, and plays them via an HTML5 `Audio` element (object URL from a Blob). Each CC bubble also shows a ▶ replay button that re-triggers speak for that text.
- **Failure is non-fatal**: TTS error (daemon down, no voice config, gateway error) ⇒ the text reply still shows; a small muted "🔇 语音失败" note on that bubble, no crash. If no voice config is set, `speak` returns a clear error the app surfaces once ("未配置语音").
- **Reuse, don't rebuild**: the daemon `reply_voice` path already synthesizes via the same voice config — `speak` shares that synthesis code (extract a small `synthesize(text): Promise<{ bytes, mime }>` helper if `reply_voice`'s logic isn't already callable standalone), it just returns bytes to the caller instead of ilink-sending.

## 3. Non-goals (Stage 1)

Voice INPUT / STT (Stage 2); streaming/low-latency TTS (Stage 3 — Stage 1 is synth-whole-then-play); per-message voice in WeChat (that's the existing `reply_voice`, unchanged); voice cloning / 声线 UI; a persistent audio connection. The Stage-0 residuals (one-directional in-flight guard, etc.) are unchanged and still tracked.

## 4. Testing

- **Daemon**: `POST /v1/companion/speak` — operator-token route-allowed (converse token can now also speak); admin gate; 400 empty text; no voice config ⇒ clear error (503/422); happy ⇒ audio bytes + audio content-type (mock the synth). The synth helper extraction keeps `reply_voice` behavior byte-unchanged (existing voice tests green).
- **token-registry**: operator `routeAllow` now contains both converse AND speak; still 403s on any other admin route.
- **App**: `agent_speak` Tauri command compiles (cargo check); toggle persists; on-reply autoplay only when ON; replay button; TTS-failure shows the muted note not a crash (node --check + manual-verify note).
- Full daemon suite + e2e + cargo green.
