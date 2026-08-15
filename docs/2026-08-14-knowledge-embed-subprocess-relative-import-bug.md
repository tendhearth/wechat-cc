# Bug — Knowledge Kernel semantic indexer never runs (embed subprocess: relative-import vs bare-script spawn)

**Found**: 2026-08-14, while enabling `knowledge_enabled` on a real daemon (dev branch `c7271e8`) to wire wechat as a hearth federated source.
**Status**: FIXED 2026-08-14 — see "Resolution" at the bottom.
**Severity (as found)**: High — **wechat semantic search has never actually worked in a real run**, including in the released 1.3.8. The graph face works; the *semantic* index is never built.
**Area**: `src/core/knowledge/embed-runner.ts` ↔ `packages/wxsearch/wxsearch/embed_subprocess.py` (wechat-cc-plugins).

## Symptom

With `knowledge_enabled: true`, boot log shows the kernel wiring but the indexer failing every tick:

```
[BOOT] knowledge: enabled — store + source adapter wired
[KNOWLEDGE] graph rebuild: 102 contact(s), 613 edge(s)          ← graph face OK
[KNOWLEDGE] indexer run failed (will retry next tick): undefined is not an object (evaluating 'parsed.vectors.length')
```

Every indexing tick fails, so **no embeddings are ever written** → `POST /v1/knowledge/search` (semanticSearch) has no index to search and no `embedQuery` result → returns 503/400 → any consumer of semantic search (e.g. hearth's `federated_query`, the agent's `knowledge_search`) gets nothing.

## Root cause

`embed-runner.ts` spawns the embed subprocess as a **bare script**:

```ts
// src/core/knowledge/embed-runner.ts:106
const child = spawnFn([opts.pythonBin, opts.scriptPath, '--model-id', opts.model_id], { env })
//                     e.g.  <pluginDir>/.venv/bin/python  <pluginDir>/wxsearch/embed_subprocess.py --model-id bge-small-zh-v1.5
```

But `embed_subprocess.py` uses **package-relative imports** (inside `_default_embed_fn`, lazy):

```python
# packages/wxsearch/wxsearch/embed_subprocess.py  (~lines 70-73)
from ._deps import ensure_model_manager
from .embed import OnnxEmbedRunner
```

When Python runs a file **as a script** (`python path/to/embed_subprocess.py`), the module's `__package__` is empty, so `from ._deps ...` raises:

```
{"error": "attempted relative import with no known parent package"}
```

The subprocess emits that `{"error": ...}` line on stdout; `embed-runner` reads it, finds no `.vectors`, and the indexer throws `parsed.vectors.length` undefined. (Confirmed by piping a request straight into the subprocess:
`echo '{"texts":["你好"]}' | .venv/bin/python wxsearch/embed_subprocess.py --model-id bge-small-zh-v1.5` → the relative-import error above.)

The error triggers at import time, so it fails **before** the model even loads — every tick, fast.

## Why it was masked

- The **graph face** (`rebuildGraphFromSource`) doesn't use the embed subprocess, so it works — the kernel *looks* alive.
- `embed-runner`'s own tests inject a **fake `spawnFn`/child** (see `EmbedRunnerChild` seam), so they never exercise the real `python <script>` invocation — the relative-import failure is invisible to unit tests.
- Verified via `python -m wxsearch.embed_subprocess ...` (module form) — that invocation **does** resolve the relative imports and proceeds to load the model. So the code is fine as a *module*, broken as a *script*.

## Fix

The subprocess's own docstring says it's meant to be run as a script (`python3 embed_subprocess.py --model-id <id>`), so make it actually work as one. **Recommended (Option B — self-contained script, change stays inside wxsearch):**

In `packages/wxsearch/wxsearch/embed_subprocess.py`, make it runnable as a bare file — add a sys.path bootstrap near the top and switch the two relative imports to absolute:

```python
import os, sys
# Allow running as a bare script (embed-runner spawns `python embed_subprocess.py`),
# not only as `python -m wxsearch.embed_subprocess`: put the package parent on sys.path
# and import absolutely.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
...
from wxsearch._deps import ensure_model_manager   # was: from ._deps import ...
from wxsearch.embed import OnnxEmbedRunner         # was: from .embed import ...
```

Add a test that spawns the **real** script (not the fake child) end-to-end for one text and asserts a `{"vectors":[[...]]}` line back — this is exactly the gap the fake-`spawnFn` unit tests leave open.

**Alternative (Option A — invoke as a module, change stays in wechat-cc core):** in `embed-runner.ts` (or where the spawn cmd/env is assembled in `bootstrap/index.ts`), spawn `[pythonBin, '-m', '<pkg>.embed_subprocess', '--model-id', id]` with `env.PYTHONPATH` prepended with the plugin dir (`dirname(dirname(scriptPath))`), so `<pkg>` (= `wxsearch`) is importable. Downside: couples the generic runner to the module-name/layout; Option B keeps the runner's "spawn a script file" contract simple.

## Verification (after the fix)

1. `echo '{"texts":["你好世界"]}' | <pluginDir>/.venv/bin/python <pluginDir>/wxsearch/embed_subprocess.py --model-id bge-small-zh-v1.5` → prints `{"vectors":[[...384 floats...]]}` (bge-small = 512-dim; whatever the model emits), no error. (First run loads the bge model — slow / may fetch from `HF_ENDPOINT`, the code sets the hf-mirror; the model is cached at `~/.cache/...` after.)
2. Restart the daemon with `knowledge_enabled: true`: boot log shows the indexer completing (not "indexer run failed"); `GET /v1/knowledge/semantic/status` shows a growing indexed count.
3. `POST /v1/knowledge/search {"query":"..."}` returns real `results` (not 503/400).
4. End-to-end (the reason this was found): with hearth's `wechat` federated source registered, an owner federated query returns wechat semantic hits merged with the `files` source.

## Context / prereqs confirmed present on this machine (so the fix is the only blocker)

- Decrypted messages: `~/.claude/channels/wechat/plugin-data/wxvault/out/decrypted/*.sqlite` (present, actively updated).
- wxsearch resolves to `~/Documents/wechat-cc-plugins/packages/wxsearch` (via the `plugins/wxsearch` symlink) — has `.venv/bin/python` (3.12) + `wxsearch/embed_subprocess.py`.
- bge model cached at `~/.cache/wxsearch-verify/bge-small-zh-v1.5/`.
- Kernel enabled via `~/.claude/channels/wechat/agent-config.json` `knowledge_enabled: true` (backup at `agent-config.json.bak-preknowledge`).

---

## Resolution (2026-08-14)

**Fixed in `wechat-cc-plugins` `cce9bc0`** — the script, not the runner. `knowledge_embed_script` is a user-configurable path, so the runner cannot assume the script it is handed sits in a package named after its parent directory; running correctly as a bare script is the script's side of that contract. A guarded `sys.path` + `__package__` bootstrap at the top of `embed_subprocess.py` makes the relative imports resolve exactly as they do under a normal package import, and is a no-op when imported normally.

A regression test spawns the script exactly the way `embed-runner.ts` does and asserts it gets past its own imports. The existing suite could not catch this: every other test imports it *as part of the package*, a path production never takes.

**Verified on the live daemon, without a restart** (the runner re-spawns the script every tick):

```
03:27:25 [KNOWLEDGE] indexer run failed (will retry next tick): undefined is not an object ...
03:33:25 [KNOWLEDGE] indexer run: 14451 chunk(s) embedded
```

`semantic.db` went from empty to 64MB. Also confirmed by hand under the daemon's exact environment (its venv python + `WXVAULT_STATE_DIR`): real vectors returned.

**Second bug, fixed alongside in wechat-cc:** `embed-runner.ts` read `parsed.vectors.length` unconditionally, so a `{"error": "..."}` response became `undefined is not an object (evaluating 'parsed.vectors.length')`. The subprocess's real message — `attempted relative import with no known parent package` — was in the pipe the whole time and never printed. That is half the reason this survived into a release. The runner now surfaces the subprocess's error verbatim, and rejects an unrecognised response shape by naming what it got.
