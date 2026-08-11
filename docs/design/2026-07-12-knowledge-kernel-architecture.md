# Knowledge Kernel — Long-Term Architecture (Design Note)

> **Status: north-star architecture, exploratory.** Not an implementation plan.
> A phased path is sketched at the end; each phase gets its own spec → plan → SDD
> when actually built. Date: 2026-07-12.
> Related: `docs/design/agent-social-network.md` (the federation north star this
> serves), `docs/design/roadmap.md`.

## 0. One sentence

Make the owner's **local knowledge** a first-class, daemon-owned substrate that
capabilities *write into* and the agent + federation *read from* through a
versioned API — instead of a byproduct scattered across per-plugin SQLite files
glued together by `..` filesystem reaches.

---

## 1. Why (the problems this solves)

The current shape: a TS/Bun host (`wechat-cc`) + N Python MCP-subprocess plugins
(`wxvault` closed decryption; `wxmedia/wxsearch/wxgraph/wxfacts/wxperson` open),
mounted via symlinks, each owning a sidecar SQLite.

Three structural smells:

1. **The `${dataDir}/../wxvault` shared root.** The daemon isolates each plugin's
   dataDir, then consumer plugins climb *out* of that sandbox via `..` to read
   wxvault's decrypted root. It defeats the isolation, is fragile (depends on OS
   `..` traversal + requires `plugin-data/<name>/` to pre-exist — a chicken-and-egg
   with the healthcheck), and welds every plugin to one on-disk layout. It is a
   hack standing in for a missing first-class concept: *a shared, owned data source*.
2. **Plugins are "fake plugins" — coupled by filesystem paths and cross-imports.**
   `wxfacts` imports `wxgraph.source`; `wxperson` reads `wxsearch`'s private
   `index.sqlite` path; `_deps.py` resolves siblings via `parents[2]/<name>`. Two
   inconsistent coupling mechanisms coexist: **MCP** (clean) for the agent, but
   **filesystem/imports** (reaching into internals) between plugins. They are a
   tightly-coupled suite wearing a plugin costume.
3. **Granularity too fine.** `wxgraph / wxfacts / wxperson` are all "structured
   understanding," mutually dependent, individually useless (`wxperson` just
   aggregates the other two). Splitting them into 3 independent subprocesses buys
   the coupling cost of (2) with no isolation benefit, plus 6 Python subprocesses +
   multiple ML runtimes on a laptop.

Two honest secondary points: the "open-source" plugins can't run without the
closed `wxvault` + its proprietary output format (open in code, not in
standalone utility); and the distribution story (symlinks are dev-time; the
desktop-bundle path is deferred) is unproven.

## 2. The reframe — only two contracts deserve to be stable

The root cause is treating the wrong thing as the architectural skeleton:
"one MCP plugin per capability + plugins reading each other's files" got
elevated to load-bearing. For the long term (federation as the core product —
see `agent-social-network.md`), only **two** contracts should be stable, versioned,
and depended upon:

1. **The Knowledge substrate (internal spine).** The owner's sovereign local
   knowledge — decrypted messages + derived layers (transcripts, vectors, facts,
   graph, person profiles) — is *one daemon-owned, versioned layer*. Capabilities
   **write** it; the agent and federation **read** it.
2. **The Federation protocol (external edge).** A2A + intent/trust (`/a2a/*`).
   This is what makes it a *network*, and the north star.

Everything else — how capabilities are packaged, what language they use, which
process they run in — is **implementation, free to merge/move**, not skeleton.
(This borrows the "collapse" insight: the internal plugin-API is not sacred; MCP
is kept only where it earns its keep — heavy Python ML workers and the agent's
tool surface.)

Target shape:

```
        ┌──────────────── the owner's CC (single-owner runtime) ───────────────┐
        │                                                                       │
  capabilities (producers)       Knowledge Kernel (spine)        agent + federation (consumers)
  decrypt / ASR / embed  ──write──▶  unified sovereign store  ◀──read──  agent tools / A2A intent
  extract / graph                    (versioned Knowledge API)           /a2a/* federation (public edge)
  (any language; heavy ML out-of-proc)  daemon-owned, isolated, audited
```

---

## 3. The Knowledge Kernel (spine)

### 3.1 Source is immutable ground-truth; derived layers are rebuildable projections

```
source (ground-truth, write-once, immutable)     derived (projections, blow away & rebuild anytime)
  messages / contacts                             media_text · vectors · facts · graph · person
  ← only wxvault (decrypt) may write               ← capability workers write; all are f(source, model)
```

This line is the crux of long-term evolvability: **derived data is a cache of
`source × models`.** Schemas may change, models may be swapped, reindex/re-extract
may run at will — *without losing anything irreplaceable*. The only true asset is
`source` (the decrypted messages). Today's pain is precisely that derived data was
treated as each plugin's private asset, and reached into by others.

### 3.2 Six concepts unchanged — now namespaces in one owned layer, not six sidecar DBs

| Layer | Producer | Content |
|---|---|---|
| `source` | wxvault (decrypt, **closed**) | messages / contacts — **read-only ground truth** |
| `media` | ASR worker | msg_key → transcript |
| `semantic` | embed worker | chunks + vectors + FTS |
| `facts` | extract (agent-driven) | claims (with provenance / status) |
| `graph` | graph worker | contact profiles + edges |
| `person` | — (**not stored; projected at query time**) | facts + graph + recent, assembled on read |

The conceptual decomposition (the SDD-built work) is fully preserved; only the
**coupling mechanism** changes — no `..`, no cross-imports. `person` stops being a
storage layer at all; it becomes one Query-face assembly, directly killing the
"wxperson reads wxsearch's private path" class of coupling.

### 3.3 Two API faces + built-in provenance

The daemon owns the knowledge layer and exposes exactly two faces; **everyone goes
through them**:

- **Ingest face (producers write):** `upsert_facts / add_vectors / put_transcript /
  put_edges …`, idempotent, every row **carrying provenance**:
  `source_msg_key + producing_model@version + source_watermark`.
- **Query face (consumers read):** `search / get_facts / get_graph / person_brief /
  list_messages / rank_contacts …`.

Built-in provenance gives, as first-class, three things done ad-hoc today:
**incremental rebuild** (compare watermarks to know what to re-run), **audit**
(which derived row, which model produced it), and **model-swap safety** (vectors
isolated by `model@version` — no more mixed-dimension `np.stack` crashes).

### 3.4 Producers become daemon-scheduled workers, not peers

`decrypt / ASR / embed / extract / graph` become **jobs** the daemon schedules
(backfill + incremental): read `source` (+ maybe lower derived) via the Query
face → write their own layer via the Ingest face; **never touch each other's
storage**. Merge/split them freely (they are just producers); language is free
(heavy ML → Python subprocess, pure-SQL logic → in-process TS).

### 3.5 Ownership / audit / portability (sovereignty)

The knowledge root is **one** daemon-owned thing: only an authorized worker may
write its own layer; writes are audit-logged; the whole root can be
encrypted-at-rest and **backed up / migrated / exported as one unit**. This both
replaces the `dataDir + ..` escape and directly realizes "local-first, owns their
own data."

---

## 4. Migration — keep the algorithms, swap only the plumbing

### 4.1 Where the store + API live

A **knowledge root** directory the daemon (`wechat-cc`) owns, holding a small
number of SQLite files split by *write-owner + access pattern* (`source`
read-only-immutable; `derived`; `vectors`) — but presented behind **one Knowledge
API** so consumers neither know nor care about the file layout (changing it breaks
no one). Two API forms: an **internal RPC** (extend the existing internal-api
loopback so Python workers and TS both call it) + a set of **thin agent MCP
tools** that merely wrap the Query face (provided in-process by the daemon, no
longer six separate MCP subprocesses).

### 4.2 The "don't throw it away" principle

Every transform the SDD built is preserved — embed, extract, graph-closeness,
match-judging algorithms are untouched. Only the two plugs change:
- **read:** `..`-climb `out/decrypted` → **call the Query face**.
- **write:** own sidecar SQLite → **call the Ingest face** (provenance mandatory).
Move one producer at a time; keep the old path until each is cut over; runnable
throughout.

### 4.3 wxvault stays closed — promoted to the privileged `source` producer

wxvault's decryption IP stays private. Only its output's destination changes:
instead of writing `out/decrypted` for others to `..`-scrape, it writes decrypted
results into the `source` layer via the Ingest face (initially a thin adapter can
ingest its existing `out/decrypted`, minimizing changes to the closed component).
**The legal boundary is unchanged** (only the `source` layer is exposed, never the
decryption logic); the `..` coupling vanishes.

### 4.4 Language / process — two relays, choose how far to go

A real trade-off, left open:
- **Relay 1 — re-plumbing (cheap, cures the disease):** all six producers move to
  the Knowledge API but **keep their current language/process** (Python
  subprocess). The coupling disease is cured immediately (all talk to the kernel;
  no `..`, no cross-import) with almost no rewrite — just swapped plugs.
- **Relay 2 — in-process collapse (nicer, costs a rewrite):** move the pure
  SQL/logic layers (`graph / facts / person`) **in-process into the TS daemon**
  (no ML; `person` is already a projection). Payoff: 3 fewer Python subprocesses,
  sibling-imports gone entirely, one language for non-ML layers; cost: rewrite that
  proven Python logic in TS.
- **Kept out-of-process either way:** heavy ML (`ASR / embed`, on the
  fastembed/whisper ecosystem) stays a Python subprocess worker the daemon spawns
  on demand.

**Recommendation: do Relay 1 first** (fast decoupling + the kernel, low risk);
**Relay 2 is an optional later cleanup** (do it when you want fewer
processes / one language — don't let it block Relay 1). The process map shrinks
from "6 resident Python subprocesses" to "wxvault (closed source) + 1–2 on-demand
ML workers + the rest in-process."

### 4.5 Repo structure simplifies

Closed `wxvault` (source) unchanged; the knowledge layer + agent tool surface live
in the host; `wechat-cc-plugins` becomes "a set of API-speaking workers" after
Relay 1, and thins further to "just the ML workers" after Relay 2. Cross-repo
coordination tax drops.

---

## 5. Impact on agent-social — the layer above gets *cleaner*

The just-built agent-social M1 not only survives the kernel; the kernel removes
two of its hacky bits — validating that the right spine makes the layer above
cleaner:

| agent-social today (hack) | with the Query face |
|---|---|
| **judge** spawns a one-shot agent with pluginMcp to read facts; only works when `provider=openai`, needs a dedicated tier profile, one agent turn per inbound intent (slow) | **judge = a direct Query-face call** (`person_brief(owner)` / `get_facts`) feeding `cheapEval` → **provider-agnostic, no tier hack, no spawn, fast**. The `social_judge` profile, the pluginMcp spawn, and the whole "judge can't reach tools" bug class **all delete** |
| **discover** = all paired peers capped 5 (wxgraph ranking deferred) | **discover = Query-face** `rank_contacts(topic)` then filter to paired → the deferred ranking **comes for free** |
| gate / broker / dual-confirm logic | **unchanged** (well-designed, reviewed) — only judge/discover's data access changes |

This fits the invariants natively: **federation reads knowledge, never writes it**
(it exchanges derived intent, not raw data) — the Query face is exactly the
interface agent-social needs.

---

## 6. Phased rollout (front-load the cure, defer the rewrite)

- **Phase 0 · Knowledge API skeleton** — define the Query + Ingest faces, the
  source/derived/vectors layout, the provenance schema. Pure spine, no behavior
  change.
- **Phase 1 · Re-plumb producers (Relay 1)** ⭐ — move all six producers onto the
  API; ingest wxvault into `source` via adapter. The `..` hack gone, cross-plugin
  coupling gone, all data flows through the kernel. Biggest structural cure, lowest
  risk.
- **Phase 2 · Point agent-social at the Query face** — judge → direct query +
  cheapEval; discover → `rank_contacts`. Removes the `provider=openai` limit + the
  tier hack. Small, high value.
- **Phase 3 · In-process collapse (Relay 2, optional)** — graph/facts/person →
  in-process TS. Fewer subprocesses; costs the rewrite.
- **Phase 4 · Sovereignty polish (optional)** — encrypt-at-rest, export/backup
  command, audit-log surfacing.

Phases 0–2 are the committed core (cure + agent-social cleanup); 3–4 optional.

## 7. Non-goals / what this is not

- Not a rewrite of the extraction/embedding/graph algorithms (they are preserved).
- Not opening the decryption IP (wxvault stays closed; only `source` is exposed).
- Not (yet) the third-party-extensible public plugin platform (axis (i) — deferred;
  the stable public contract that matters now is the **federation protocol**, not
  the internal capability API).
- Not the stranger/pseudonym federation layer (that's the agent-social-network
  doc's v1+).

## 8. Open questions (for the Phase 0/1 spec)

- Knowledge root physical split: one SQLite vs `source.db` / `derived.db` /
  `vectors.db` — decide behind the API in Phase 0.
- Internal RPC shape: extend internal-api HTTP, or a dedicated local socket for
  bulk ingest throughput? Personal scale suggests HTTP loopback is fine to start.
- Scheduling: how the daemon sequences backfill vs incremental workers (a job
  queue vs the existing tick loop).
- Whether `wxvault` writes `source` directly (touch the closed component) or an
  adapter ingests its `out/decrypted` (initial, less disruptive).
