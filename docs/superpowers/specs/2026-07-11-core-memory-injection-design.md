# Design: 常驻 Core Memory 注入 (always-loaded core memory)

Date: 2026-07-11
Status: approved design → implementation
Origin: memory-system weak-layer diagnosis (2026-07-11) — on a live reply turn the agent gets ZERO injected memory; it must remember to `memory_list` + guess-by-filename which `.md` to read. So the CC "has to look you up" instead of "always knowing you." This is the Letta core-memory pattern, done with wechat-cc's .md philosophy, in-process, NO external framework (per [[architecture-direction-2026]]).

## 1. What

Inject a small, always-in-context **core memory** block into EVERY reply turn's system prompt, per chat — "who this person is" — so the CC always has the basics without a retrieval call. Deeper detail stays in the pull-based `memory_read` path (unchanged).

## 2. Locked decisions

- **Source = the chat's own `profile.md`** (`memory/<chatId>/profile.md` — the existing "这个人是谁：身份、当下在做什么、生活脉络" convention file). Per-chat: each conversation injects ITS person's profile (owner chat → owner; friend chat → that friend). v1 is profile.md only; `preferences.md` and a "当下线头/current-threads" digest are explicit v2 (noted, not built).
- **No new LLM step** — profile.md IS the distillation (agent writes it concise per convention; the gardener keeps it tight). We just inject it. Read FRESH per spawn (like persona/sticker thunks) so it's always current — zero staleness.
- **Size cap** — core memory is always-in-context = token cost every turn, so cap the INJECTED text at `CORE_MEMORY_MAX_CHARS = 1500`. If profile.md exceeds it, inject the first 1500 chars + a one-line note ("(核心记忆已截断;完整 profile 用 memory_read)") so the agent knows to pull the rest. (profile.md's own fs cap stays 100KB — this only bounds what's injected.)
- **Injection** — new `coreMemorySection(content)` in prompt-builder, gated `content && content.trim()` (byte-identical when profile.md absent/empty — new chats with no profile inject nothing). Placed right AFTER the persona section (persona = who CC is; core memory = who the user is — identity cluster, high in the prompt), before the capability/tool sections. Framing tells the agent: this is the always-loaded core of what you know about this person; more detail is in memory (memory_read).
- **Wiring** — mirrors `personaFor`/`stickerTagsFor` exactly: `BootstrapDeps.coreMemoryFor?: (chatId) => string` reads `memory/<chatId>/profile.md` (capped) fresh per call; buildInstructions passes `coreMemory`; absent dep / no file ⇒ section omitted. Single source, no new store.
- **Tier**: no tier gate — core memory is context, not a capability (reading who you're talking to is always fine; it's the agent's own memory of that chat).

## 3. Non-goals (v1)

Semantic/vector retrieval (weak-layer #1 long-tail — separate future work); preferences.md / current-threads in the core block (v2); a synthesized `core.md` distinct from profile.md (v2 if profile-as-core proves too coarse); staleness/temporal tracking; any change to the pull-based memory_read path or the gardener.

## 4. Testing

`coreMemorySection` content (mentions the person/核心记忆 framing + the injected profile text); cap (a >1500-char profile ⇒ injected ≤ ~1600 incl. the truncation note; the note present); gating byte-identical (`toBe`) when coreMemory absent AND ''/whitespace; placement after persona, no other section reordered. Wiring: `coreMemoryFor` returns content ⇒ instructions contain it; absent ⇒ byte-identical. main.ts reads the CHAT's own profile.md (not the owner's). Full daemon suite + e2e green (harness chats have no profile.md ⇒ inert).
