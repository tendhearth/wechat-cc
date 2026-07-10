# Design: 冷启动懂你 — 新关系好奇 + 人设种子

Date: 2026-07-10
Status: approved design → implementation
Roadmap: onboarding piece of Phase 4b (independent of dogfood). Builds on the shipped liveness layer.

## 1. What

A fresh CC knows nothing — the first days decide retention. Two prompt-level
mechanisms (zero new tools/stores):

1. **新关系段 (`newRelationshipSection`)**: while a chat is YOUNG (few
   messages), the agent is told: you two just met — weave natural curiosity
   into replies (≤1 question per reply; what they do / care about / how they
   like to be talked to), write what you learn into memory; 别像查户口,
   有内容才问. Auto-retires as the relationship deepens (message count crosses
   the threshold). Applies to ALL chats whose tier can actually persist
   (`memory_write`) — guests get no impossible-write instructions (M1 lesson).
2. **人设种子 nudge**: while `persona.md` is still EMPTY, the owner-chat
   cultivation section gains one line: find an early natural moment to ask
   想要我什么风格/性格,有想对标的吗 — write the answer into persona.md.
   Disappears once persona.md has content.

## 2. Locked decisions

- Curiosity is woven into replies, never a standalone questionnaire and never
  proactive pushes (the care/calibration machinery is untouched).
- Freshness metric = **total message count in the chat** (`messages` table,
  cheap sync COUNT on the bun:sqlite handle) — threshold const
  `NEW_RELATIONSHIP_MSG_COUNT = 50` (≈ first days of chatting).
  buildInstructions is sync, so the count helper must be sync (standalone
  `countMessagesSync(db, chatId)` export in messages-store; the async store
  API is unchanged).
- Gates (both sections byte-identical-off): `newRelationship?: boolean` arg
  (thunk `newRelationshipFor?: (chatId) => boolean` on BootstrapDeps; main.ts
  wires count < threshold; tier AND `memory_write` applied in bootstrap like
  careEnabled). Persona nudge: `personaCultivationSection(opts?: { personaEmpty?: boolean })`
  — extra line only when empty; `personaFor` already returns content, so
  bootstrap derives `personaEmpty = !content?.trim()`.
- Existing deterministic onboarding (name/bot-name capture) untouched.

## 3. Non-goals

Scripted interview flows; proactive get-to-know pushes; per-chat freshness
config; import-local changes; desktop UI.

## 4. Testing

Section contents + gating byte-identity; countMessagesSync (0 / n / other
chats isolated); bootstrap threading (fresh chat + trusted ⇒ section, guest ⇒
no section, old chat ⇒ no section; empty persona ⇒ nudge line, non-empty ⇒
none); full + e2e green (harness chats are fresh + admin — the section WILL
appear there; verify no e2e asserts full prompt equality — they don't, they
assert dispatch/reply behavior).
