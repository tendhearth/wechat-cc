# Design: Voice-in (STT) — daemon layer (voice arc Stage 2)

Date: 2026-07-11
Status: approved design → implementation
Origin: the app-conversation voice arc has text (Stage 0) + voice-out (Stage 1, `/v1/companion/speak` → gateway TTS) but no voice-**in**. Stage 2 adds speech-to-text so the desktop app becomes a full voice companion (hear → think → speak) — the "unconstrained surface" WeChat can't be, and the foundation for a phone thin-client voice entry point. STT runs on the SAME gateway (user's VPS) as TTS, keeping data sovereignty + phone reusability. This spec is the DAEMON layer only (the keystone contract); the gateway whisper server + the app mic-capture are separate. See [[app-voice-arc]], [[voice-tts-via-gateway]].

## 1. What

A daemon STT stack that mirrors the existing TTS stack (`src/daemon/tts/`), using the **OpenAI-compatible audio API**: TTS posts to `/v1/audio/speech`; STT posts multipart audio to `/v1/audio/transcriptions` and gets `{text}` back — the shape every whisper server (faster-whisper-server / speaches / whisper.cpp server) speaks. The daemon just needs the gateway URL, exactly like TTS.

## 2. Locked decisions (mirror TTS)

- **Provider** `src/daemon/stt/http-stt.ts`: `makeHttpSTTProvider({ baseUrl, model, apiKey? }) -> STTProvider`. `transcribe(audio: Buffer, mime: string) -> Promise<{ text: string }>` POSTs `multipart/form-data` (`file` = the audio blob, `model` = the model id) to `baseUrl`; parses `{ text }` from the JSON response. `test()` (one-shot: transcribe a tiny silent/□ clip or just probe reachability) mirrors `TTSProvider.test()` for save-config validation. Error mapping mirrors http-tts (`401`→unauthorized, `404`→endpoint, `5xx`→service, `ECONNREFUSED`→cannot connect).
- **Types** `src/daemon/stt/types.ts`: `STTProvider { readonly name: 'http_stt'; transcribe(audio, mime); test() }`.
- **Config** `src/daemon/stt/stt-config.ts`: `STTConfig = { provider: 'http_stt', base_url, model, api_key?, saved_at }`, persisted at `<stateDir>/stt-config.json` (separate from `voice-config.json` — independent concern). `loadSTTConfig`/`saveSTTConfig`/`validate` mirror voice-config exactly.
- **Seam** in `src/daemon/ilink/voice.ts` (`makeVoice`): add `async transcribe(audio, mime) -> { text }` — loads STT config (throw `no_stt_config` if absent), builds the provider via a `sttProviderFromConfig(cfg)`, returns `{ text }`. Symmetric to `synthesizeSpeech`. Extend `WechatVoiceDep` with `transcribe`.
- **Routes** (`src/daemon/internal-api/routes.ts` + `route-tiers.ts` + `schema.ts`), mirroring the voice routes:
  - `POST /v1/companion/transcribe` (**admin**, like `/v1/companion/speak`): body `{ audio_b64: string, mime?: string }` → `{ ok: true, text }`; 400 on missing/invalid audio, 503 `voice_not_wired` if `deps.voice` absent, 422 `no_stt_config` if unconfigured, 500 on provider error. Enforce a max audio size (e.g. 25 MB, the OpenAI limit) → 413.
  - `POST /v1/stt/save_config` (**trusted**, like `/v1/voice/save_config`): validates via `provider.test()` before persisting.
  - `GET /v1/stt/status` (**trusted**): `{ configured: boolean, provider?, base_url?, model? }` (never returns the api_key).
- **main.ts wiring**: add `transcribe: (a, m) => ilink.voice.transcribe(a, m)` to the `voice:` deps block (next to `synthesizeSpeech`).

## 3. Non-goals (this layer)

The gateway whisper server (a VPS deploy — the daemon only points at its URL); the desktop app mic capture + the hear→converse→speak loop wiring; streaming/partial transcripts (v1 is one-shot: full clip → full text); voice-activity-detection; language selection (rely on whisper autodetect for v1); any change to the TTS stack.

## 4. Testing

- `makeHttpSTTProvider`: a fake `fetch` returning `{text:'你好'}` → `transcribe` returns `{text:'你好'}` and POSTs multipart with the `model` field; non-2xx → throws with mapped reason; `test()` ok/!ok paths.
- `stt-config`: save+load round-trip; `validate` rejects missing base_url/model; a non-object → null; api_key optional.
- seam: `transcribe` with no config → throws `no_stt_config`; with config → delegates to the provider.
- route: `POST /v1/companion/transcribe` with a valid `audio_b64` → 200 `{text}`; missing audio → 400; oversize → 413; `deps.voice` absent → 503; provider throws `no_stt_config` → 422. `GET /v1/stt/status` omits the api_key. Route-tier: transcribe=admin, save/status=trusted.
- Full daemon suite + e2e green (e2e harness has no stt-config ⇒ transcribe returns 422, inert).
