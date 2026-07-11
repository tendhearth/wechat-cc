# Design: Knowledge Orchestration (unified person model — phase 1)

Date: 2026-07-11
Status: approved design → implementation
Origin: unified-person-model diagnosis (2026-07-11) — the agent has ~31 knowledge tools with ZERO routing guidance and **ignores the plugins entirely** (the daemon's memory never composes with wxsearch/wxfacts/wxgraph; they're islands). Phase 1 = the cheapest, collision-free form of "core owns orchestration": a prompt section that teaches the agent its complete knowledge landscape + when to use which source + that they COMPOSE into understanding a person. Pure daemon-side (no plugin-repo change → no collision with active plugin dev). The `person_brief` assembly surface + flow-back are later phases. See [[architecture-direction-2026]].

## 1. What

A prompt section that names the CC's full "knowledge of a person" landscape and how the sources compose — so the agent stops treating the plugins as a random tool-bag and starts using the whole stack coherently. Adapts to WHICH knowledge plugins are actually loaded (only mentions available ones).

## 2. Locked decisions

- **Two kinds of knowledge, composed**: the CC's own **.md memory** (first-person take, may be biased) + the **extracted plugin sources** (computed from real data). The section frames: to understand someone, compose your take + relationship stats + structured facts — don't rely on one.
- **Name-centric identity**: people are resolved BY NAME (the plugins resolve name→wxid via the WeChat contact table; the CC's notes reference names). The section tells the agent to find people by name; accepts name ambiguity (as wxgraph already does). No chat_id↔wxid deterministic join in v1.
- **Adaptive to loaded plugins**: `BuildSystemPromptArgs.knowledgePlugins?: string[]` (loaded plugin names). `knowledgeOrchestrationSection(names)` renders a line only for each KNOWN knowledge plugin present. Known map (v1, the bundled suite's stable tool names):
  - `wxgraph` → 关系画像 (`contact_profile`/`top_contacts`): 量化关系(亲密度/最近/往来平衡).
  - `wxfacts` → 结构化事实 (`contact_facts`/`find_facts`): 事实/义务/关系(带出处).
  - `wxsearch` → 消息检索 (`search`): 语义找具体对话.
  - `wxmedia` → 语音/图片转出的文字(也在检索里).
  - (wxvault raw tools deliberately NOT routed to — the curated sources replace them; wxvault is hidden infra.)
- **Gating**: section omitted (byte-identical prompt) when NO known knowledge plugin is loaded — e.g. e2e harness / installs without the wx suite. A plugin name not in the known map is simply not mentioned (it still carries its own tool descriptions).
- **Placement**: right after `memorySection()` (memory + how-to-use-the-broader-knowledge belong together).
- **Wiring**: daemon threads the loaded knowledge-plugin names (from `loadPlugins()`/the LoadedPlugin list, filtered to enabled) into buildInstructions — mirror how other per-spawn context reaches the prompt. Reads the loaded set; no new store.

## 3. Non-goals (phase 1)

The `person_brief` assembly surface (a plugin that reads sibling sqlite + memory + returns one view — later, coordinated with the plugin repo); flow-back (wxfacts obligation→agenda; facts→.md); the chat_id↔wxid deterministic join; any plugin-repo change; changing tier gating or the plugins themselves.

## 4. Testing

`knowledgeOrchestrationSection`: content (the compose-your-take+stats+facts framing, name-resolution note); renders a line for each present known plugin and NOT for absent ones (e.g. names `['wxgraph','wxsearch']` ⇒ graph+search lines, no facts/media line); byte-identical `toBe` when names empty AND when only unknown names present; placement after memorySection, no other section reordered. Wiring: buildInstructions with knowledge plugins ⇒ section present; without ⇒ absent. Full daemon suite + e2e green (harness has no wx plugins ⇒ inert).
