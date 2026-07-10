# Design: 白纸养成的人设 (persona.md)

Date: 2026-07-10
Status: approved design → implementation
Roadmap: Phase 4a. See `docs/design/companion-liveness-layer.md` §1④.

## 1. What

The bot's character is a **self-authored `persona.md`** it cultivates over
time (白纸养成), seeded conversationally by the owner ("对标 XXX 的风格" /
"说话再毒舌点"), injected into EVERY chat's system prompt — **one consistent
CC** (global, per positioning's don't-fragment rule).

## 2. Locked decisions

- **Global, owner-cultivated.** `persona.md` lives in the OWNER chat's memory
  dir (`memory/<default_chat_id>/persona.md`). Only the owner chat shapes it
  (existing `memory_write` — zero new tools; the owner can also edit the file
  directly: visible, correctable, not a black box). This boundary is now
  ENFORCED, not conventional: the memory routes are chat-scoped (this
  hardening) — a non-admin session token can only read/write/list/delete
  inside its OWN chat's memory subtree, so no other chat can inject into the
  owner's `persona.md` (which broadcasts into every chat's prompt). The owner
  chat (writing under its own subtree), the operator CLI (file-origin token),
  and admin sessions remain unrestricted. ALL chats get the same
  persona injected. Per-relationship tone (对朋友活泼/对同事正经) is the
  agent's judgment via per-chat memory, NOT config.
- **Emergence over template.** Cultivation guidance (owner chat only): keep a
  concise, bullet-y character file — speaking style, traits, the owner's
  调教 (对标/语气/雷区); evolve it SLOWLY (personality grows, not rewritten
  daily); when the owner steers ("对标 XXX"), update + confirm.
- **Injection**: `personaSection(content)` in prompt-builder, appended when
  content non-empty. Content capped at injection (~4000 chars, belt) and
  line-separator-sanitized is NOT needed (owner-authored, admin trust — same
  boundary as _overview) but the cap is (runaway file must not blow the
  prompt). Byte-identical prompt when absent/empty.
- **Two thunks, one dep**: `BootstrapDeps.personaFor?: (chatId) =>
  { content?: string; cultivate?: boolean }` — main.ts wires: `content` =
  fresh read of the owner persona.md per spawn (cheap file read, hot-editable);
  `cultivate` = `chatId === default_chat_id` (guidance section only for the
  owner chat). Absent dep ⇒ both sections omitted (tests/embedded unchanged).
- Proactive texts (care/gap/hunt) inherit the persona automatically (same
  per-spawn prompt).

## 3. Non-goals (v1)

Per-chat persona overlays; persona versioning/history (git-less file is fine);
desktop UI; automatic persona extraction from chat logs (the agent cultivates
in-flow); multi-persona switching.

## 4. Testing

personaSection content + cap; buildSystemPrompt gating byte-identical
(absent/empty) for BOTH sections; cultivation section only when cultivate;
bootstrap thunk threading; main wiring reads fresh + owner-only cultivate;
full + e2e green (no persona.md in harness ⇒ inert).
