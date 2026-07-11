# Design: App Conversation Channel (voice arc — Stage 0)

Date: 2026-07-10
Status: approved design → (pending spec review) → implementation
Origin: "app = the surface where the CC transcends WeChat's limits" (voice/video
funnel vision). This is Stage 0 of a 4-stage arc: **0 app text-conversation
foundation** → 1 CC voice-out → 2 push-to-talk voice-in → 3 streaming polish.
Stage 0 is the load-bearing foundation every later stage wraps.

## 1. What

Let the owner **hold a real, memory-ful text conversation with their CC inside
the desktop app** — not the read-only transcript viewer that exists today. The
app becomes a second *channel* into the **same session** as the owner's WeChat
chat: continuous memory, same persona, one consistent CC. Replies come back to
the app, not to WeChat.

## 2. The core abstraction: session ≠ channel

Today `chat_id` conflates two things: WHO the CC is talking to (the session /
memory) and HOW the reply is delivered (WeChat via `ilink.sendReply`). The
`reply` MCP tool → `POST /v1/wechat/reply` is hardwired to ilink.

Stage 0 separates them:
- **Session** = the owner's `default_chat_id` — memory, persona, agenda, all
  shared. An app turn runs IN this session (so what you say in the app, the CC
  remembers in WeChat, and vice-versa).
- **Channel** = the delivery target for THIS turn's reply. WeChat turns deliver
  via ilink; **app turns capture the reply and return it to the app caller**.
  The agent's `reply` tool routes to the turn's active channel, not
  unconditionally to ilink.

Owner = one session, reachable via N channels (WeChat, app). This is the
abstraction voice/video (later stages) also need — they're just the app channel
with audio wrapped around text.

## 3. Locked decisions

- **Same session as the WeChat owner chat** (decision A). App turns use
  `default_chat_id`'s session — shared memory/persona/agenda. NOT a separate
  "app chat".
- **Reply routing**: an app-driven turn carries a per-turn **reply sink** (a
  delivery override). Default sink = ilink (unchanged for WeChat). App sink =
  capture into the app response. The coordinator/reply path becomes
  channel-aware via this sink; WeChat behavior is byte-unchanged when the sink
  is absent.
- **Endpoint**: new internal-api route `POST /v1/companion/converse` { text }
  → { reply, chunks? }. Admin-tier only (the owner using their own app;
  route-tiers = 'admin'). Runs one real turn through the coordinator on the
  owner session with the app reply-sink, returns the captured reply.
- **App ↔ daemon**: the webview calls a new Tauri command `agent_converse(text)`
  that `reqwest`s the internal-api route with the on-disk bearer token (mirrors
  the existing `wechat_health_ping` pattern — NOT the one-shot CLI sidecar).
  Persistent-connection/streaming is Stage 3; Stage 0 is request/response.
- **App UI**: the existing read-only "对话" pane (or a new "跟 CC 说" pane) gains
  a compose box + a live message list for the app conversation. Sending calls
  `agent_converse`, renders the reply. Minimal, matches the vanilla-JS module
  style (`apps/desktop/src/modules/`).
- **No double-delivery**: an app turn does NOT also post to WeChat. Memory is
  shared (same session); delivery is app-only.
- **Concurrency/at-most-once**: reuse the session's existing in-flight guard —
  if a WeChat turn is mid-flight for the owner session, the app turn queues or
  is rejected with a clear "busy" (same guard the tick/inbound already use), so
  two channels can't corrupt one session.

## 4. Licensing note (owner decision, flagged not decided)

Engine (`src/`) is MIT. If the app is to be the paid/commercial layer
(open-core), NEW `apps/desktop` companion code should carry the owner's chosen
license header from first commit (MIT-released code stays MIT forever). This
spec does NOT pick the license — it flags that the Stage-0 app files are the
first where the choice matters. Default action absent a decision: keep parity
with the repo (MIT) — but confirm before shipping if commercial protection is
wanted. Orthogonal to the code architecture.

## 5. Non-goals (Stage 0)

Voice/audio (Stages 1-3); streaming replies (Stage 3 — Stage 0 is
request/response); multi-user / non-owner app chat; persistent WS; mobile;
the app driving non-owner WeChat chats. Reply splitting/pacing (a WeChat
活人感 concern) does NOT apply to the app channel — the app shows the whole
reply at once (it's a chat UI, not paced bubbles).

## 6. Testing

- **Channel seam (unit)**: a turn with an app reply-sink captures the `reply`
  tool output instead of calling ilink; absent sink ⇒ ilink path byte-identical
  (WeChat unaffected). Owner session memory is written by an app turn and
  readable by a subsequent WeChat turn (shared-session continuity).
- **Route**: `POST /v1/companion/converse` admin-tier gate (guest/trusted ⇒
  403); missing text ⇒ 400; happy ⇒ {reply}; in-flight owner session ⇒ busy.
- **App**: `agent_converse` Tauri command proxies with bearer; compose→reply
  round-trip renders (frontend test at the module boundary if the app has one,
  else manual-verify note).
- Full daemon suite + e2e green (the new route is inert unless called; WeChat
  pipeline untouched).

## Known residuals (Stage 0)

(1) The `companionConverse` in-flight guard (`src/daemon/wiring/pipeline-deps.ts`,
the `isInFlight` check near the `companionConverse` closure) is
**one-directional**: it refuses an app turn while a WeChat turn is in flight,
but NOT the reverse. If the owner sends a WeChat message while an app
`/converse` turn is already running, that WeChat turn races the same owner
session and its reply-tool output could be captured into the open app
replySinks sink and lost from WeChat instead of being ilink-sent. Bounded/
low-risk for a sole owner; must be closed (session-level serialization of
turns on one chat, not just an app-side pre-check) before Stage 1 introduces
concurrent/automated owner turns or any non-owner exposure.

(2) Only `POST /v1/wechat/reply` is sink-captured — `reply_voice`,
`send_sticker`, `send_file`, `broadcast` during a converse turn still go to
WeChat (text-only Stage 0).

(3) Converse turns are not persisted to the messages-store, so they don't
appear in the read-only 对话 pane.
