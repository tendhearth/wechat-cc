/**
 * wire-knowledge.ts — Knowledge Kernel(store / indexer / graph / facts / person)
 * 的接线。从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,spec
 * 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化:
 * deps.log/stateDir → ctx.log/stateDir,configuredAgent → ctx.configuredAgent,
 * loadedPlugins 是参数(wire-plugins 的产物)。经 ctx.sup.start('knowledge')。
 */
import { join } from 'node:path'
import { findOnPath } from '../../lib/util'
import { pluginDataDir } from '../plugins/paths'
import { openKnowledge } from '../../core/knowledge/store'
import { semanticSearch } from '../../core/knowledge/search'
import { runSourceAdapter } from '../../core/knowledge/source-adapter'
import { runIndexer } from '../../core/knowledge/indexer'
import { makeEmbedderService } from '../../core/knowledge/embedder-service'
import { makeJsEmbedder, withEmbedderFallback } from '../../core/knowledge/js-embedder'
import { rebuildGraphFromSource } from '../../core/knowledge/graph-build'
import { makeGraphQueryApi } from '../../core/knowledge/graph-query'
import { makeFactsApi } from '../../core/knowledge/facts'
import { makePersonApi } from '../../core/knowledge/person'
import { runKnowledgeCycle } from '../../core/knowledge/cycle'
import { gateRefreshOnFullDiskAccess, makeWxvaultRefresh } from '../../core/knowledge/wxvault-refresh'
import { FDA_MISSING_HINT, hasFullDiskAccess } from '../../lib/fs-access'
import type { Bootstrap, BootstrapCtx } from './types'
import type { PluginsSlice } from './wire-plugins'

// Knowledge Kernel T7' — provenance tag stamped alongside `knowledge_embed_model`
// on every semantic.db row this daemon writes (store.putSemantic(model_id,
// model_version, ...)). NOTE: the indexer's resume cursor is keyed on
// model_id ALONE (see indexer.ts's header comment) — bumping this constant
// does NOT by itself trigger a re-embed of already-indexed rows; it is
// purely the provenance label recorded on rows embedded from here on. A
// real re-embed after a pipeline change needs either a new model_id or a
// manual cursor reset (`indexer_cursor:<model_id>` in semantic.db's meta).
const KNOWLEDGE_EMBED_MODEL_VERSION = '1'

export function wireKnowledge(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'stateDir' | 'configuredAgent'>,
  loadedPlugins: PluginsSlice['loadedPlugins'],
): Promise<Bootstrap['knowledge']> {
  // Knowledge Kernel Phase 01 (T5) — daemon-owned KnowledgeStore + the
  // Query-face `semanticSearch`, gated behind `knowledge_enabled` (default
  // off — opt-in during the walking-skeleton slice; T1-T4 built the store/
  // search/source-adapter, this task only wires them into the daemon).
  // When on: open the store, run one backfill pass over wxvault's decrypted
  // output off the synchronous boot path (setTimeout(0) — buildBootstrap
  // must not block startup on a directory scan), then keep it fresh via a
  // periodic incremental pass. `runSourceAdapter` is cheap to re-run when
  // there's nothing new (its cursor is per Msg_* table via source_meta —
  // see source-adapter.ts's header comment), so a short daemon-lifetime
  // interval is safe — mirrors idleSweepTimer's unref()'d setInterval a
  // little further down in this function (a background job outside the
  // companion tick graph in wiring/tick-bodies.ts, not competing with it).
  return ctx.sup.start('knowledge', async () => {
    if (!ctx.configuredAgent.knowledge_enabled) {
      ctx.log('BOOT', 'knowledge: disabled (knowledge_enabled not set)')
      return undefined
    }
    const knowledgeStore = openKnowledge(join(ctx.stateDir, 'knowledge'))
    try {
      const decryptedDir = ctx.configuredAgent.knowledge_source_dir
        ?? join(ctx.stateDir, 'plugin-data', 'wxvault', 'out', 'decrypted')

      // T7' — the in-process indexer's embed subprocess. Rather than invent a
      // new discovery path, this reuses `loadedPlugins` (built just above, at
      // ~line 327, for the plugin-MCP lane) to find wxsearch's resolved plugin
      // dir — bundled or user, whichever the registry's normal shadowing rule
      // picked — and derives the script/interpreter paths the SAME way
      // wxsearch's own manifest spawns itself (`${pluginDir}/wxsearch/
      // embed_subprocess.py` via `${pluginDir}/.venv/bin/python`, see
      // packages/wxsearch/wechat-cc.plugin.json's `spawn`). This works whether
      // or not wxsearch is enabled/ready as an MCP server — the indexer runs
      // the script directly, in-process orchestration only, never through MCP.
      // `knowledge_embed_script` is an escape hatch for a non-standard install
      // (e.g. wxsearch vendored somewhere else); when set without a resolvable
      // wxsearch plugin dir, the interpreter falls back to `python3` on PATH
      // (the override is for advanced/manual setups, not the common path).
      const wxsearchPlugin = loadedPlugins.find(p => p.name === 'wxsearch')
      const knowledgeEmbedModelId = ctx.configuredAgent.knowledge_embed_model ?? 'bge-small-zh-v1.5'
      const embedScriptPath = ctx.configuredAgent.knowledge_embed_script
        ?? (wxsearchPlugin ? join(wxsearchPlugin.dir, 'wxsearch', 'embed_subprocess.py') : undefined)
      const embedPythonBin = wxsearchPlugin
        ? join(wxsearchPlugin.dir, '.venv', 'bin', 'python')
        : (findOnPath('python3') ?? 'python3')

      // T7' review Finding 1 — the embed subprocess must see the SAME
      // WXVAULT_STATE_DIR wxvault/wxsearch itself uses
      // (`<stateDir>/plugin-data/wxvault`, exactly what the plugin registry's
      // manifest templating resolves `${dataDir}/../wxvault` to for wxsearch's
      // own spawn — see packages/wxsearch/wechat-cc.plugin.json). Without this,
      // Bun.spawn's child inherits the daemon's bare process.env, and
      // embed_subprocess.py's ModelManager falls back to a state dir relative
      // to its own (read-only, in a packaged app) script path — re-downloading
      // the model every run and writing config the indexer never reads.
      const embedEnv = { ...process.env, WXVAULT_STATE_DIR: pluginDataDir(ctx.stateDir, 'wxvault') }

      // Agent-facing Search (Task 2) — ONE shared, long-lived embedder
      // service instead of a fresh embed subprocess per cycle. Built once
      // here (not per cycle) and reused by both the indexer (below) and the
      // query path (deps.knowledge.embedQuery, wired further down) so index
      // and query embed in the SAME model space via the SAME model_id.
      // Undefined when no embed script resolved (no wxsearch plugin dir and
      // no `knowledge_embed_script` override) — the indexer stays disabled
      // in that case, same gating as before this task. NOT closed between
      // cycles — only on daemon shutdown (main.ts reaches it via
      // boot.knowledge.embedder).
      // Runtime selection. 'js' runs transformers.js in-process — no venv, no
      // subprocess, and a model that warm() can load directly. It is not the
      // default: the packaged desktop sidecar is a compiled single file and
      // cannot dlopen onnxruntime's native binding, so a selection that cannot
      // load must degrade to the Python path rather than take the daemon's
      // whole knowledge face down with it. Vectors are equivalent either way
      // (cosine > 0.9999 — see js-embedder.e2e.test.ts), so switching runtimes
      // never invalidates an existing semantic.db.
      const embedRuntime = ctx.configuredAgent.knowledge_embed_runtime ?? 'python'
      const pythonEmbedder = embedScriptPath
        ? makeEmbedderService({
            pythonBin: embedPythonBin,
            scriptPath: embedScriptPath,
            model_id: knowledgeEmbedModelId,
            env: embedEnv,
          })
        : undefined
      // 实际在用的那条路(2026-10-06,「CC 现在怎么样」要分清「正常」和「退回 Python」)。
      let embedActive: 'js' | 'python' | 'js_fell_back' | 'none' = embedRuntime === 'js' ? 'js' : pythonEmbedder ? 'python' : 'none'
      const embedder = embedRuntime === 'js'
        ? withEmbedderFallback(
            makeJsEmbedder({ model_id: knowledgeEmbedModelId }),
            pythonEmbedder,
            err => (embedActive = 'js_fell_back', ctx.log('KNOWLEDGE',
              `embed runtime 'js' unavailable (${err instanceof Error ? err.message : String(err)}) — `
              + `falling back to the python subprocess for the rest of this run`)),
          )
        : pythonEmbedder

      // Extracted (T7' review Finding 2 + Finding 4) into
      // core/knowledge/cycle.ts's runKnowledgeCycle — adapter-then-indexer
      // ordering, error-swallowing, and the "still running" concurrency guard
      // now live there with direct unit coverage (cycle.test.ts) instead of
      // only being reachable through this closure.
      // The adapter reads wxvault's decrypted files directly, bypassing
      // wxvault's query-time refresh — so refresh them first each cycle
      // (incremental; no-op when WeChat wrote nothing). Only when the source
      // IS wxvault's own output dir and the wxvault plugin resolved; a
      // `knowledge_source_dir` override is someone else's snapshot to manage.
      // Interpreter + state dir come from wxvault's own resolved spawn spec
      // (absolute python, launchd-safe), so the refresh runs exactly as
      // wxvault's MCP server does.
      const wxvaultPlugin = loadedPlugins.find(p => p.name === 'wxvault' && p.enabled && p.ready)
      // 无人值守:没有「完全磁盘访问」就不去碰微信的容器(否则每次 daemon 重启
      // 都会弹「想访问其他 App 的数据」,见 gateRefreshOnFullDiskAccess)。
      const refreshSource = wxvaultPlugin && !ctx.configuredAgent.knowledge_source_dir
        ? gateRefreshOnFullDiskAccess(makeWxvaultRefresh({
            pythonBin: wxvaultPlugin.spec.command,
            pluginDir: wxvaultPlugin.dir,
            stateDir: wxvaultPlugin.spec.env?.WXVAULT_STATE_DIR ?? pluginDataDir(ctx.stateDir, 'wxvault'),
          }), { hasFda: () => hasFullDiskAccess(), log: ctx.log, hint: FDA_MISSING_HINT })
        : undefined
      const runKnowledgeAdapter = (onBoot: boolean) => runKnowledgeCycle(
        {
          refreshSource,
          runAdapter: () => Promise.resolve(runSourceAdapter({ decryptedDir, store: knowledgeStore })),
          // Uses the shared `embedder` above (no per-cycle spawn/close —
          // Task 2). `embedder.model_id` (not the outer
          // `knowledgeEmbedModelId`) flows into both the embed call AND
          // putSemantic's provenance tag, so index and query are always
          // stamped with whatever model the shared service is actually
          // running.
          runIndex: embedder
            ? async () => runIndexer({
                store: knowledgeStore,
                embed: embedder.embed,
                model_id: embedder.model_id,
                model_version: KNOWLEDGE_EMBED_MODEL_VERSION,
              })
            : undefined,
          // Knowledge Graph inproc Task 4 — rebuilds graph.db (contacts/edges)
          // from whatever's in source.db right now. `now` is read fresh on
          // EVERY cycle (not captured once at boot) — graph-profiles.ts's
          // recency scoring needs the actual wall-clock time of each rebuild,
          // same posture as the rest of this file never caching `Date.now()`.
          // Owner resolution: `knowledge_owner` config wins outright; falls
          // back to `WXGRAPH_OWNER` (mirrors wxgraph's own env-var escape
          // hatch for accounts detectOwner's 1:1-vote heuristic can't infer);
          // absent both, rebuildGraphFromSource's detectOwner call decides.
          runGraphRebuild: () => Promise.resolve(rebuildGraphFromSource({
            store: knowledgeStore,
            now: Math.floor(Date.now() / 1000),
            ownerOverride: ctx.configuredAgent.knowledge_owner ?? process.env.WXGRAPH_OWNER,
          })),
          log: ctx.log,
        },
        { onBoot },
      )
      // Backfill — deferred one tick so it never delays buildBootstrap's return.
      setTimeout(() => { void runKnowledgeAdapter(true) }, 0)
      // Warm the model on the same deferred tick, AFTER the backfill is
      // scheduled. The backfill often finds nothing new (`0 chunk(s) embedded`)
      // and then never calls embed, so without this the model stays unloaded
      // until a user query arrives — and hearth's federated client gives a
      // source 5s, which a 90MB ONNX load does not fit into. Measured on the
      // live daemon: first federated query after a restart took 5801ms, timed
      // out, and reported 0 hits; the second took 396ms and returned 20.
      // Fire-and-forget and non-rejecting by contract (see warm()'s doc), so it
      // can only cost time, never a boot.
      if (embedder) setTimeout(() => { void embedder.warm() }, 0)
      const knowledgeAdapterTimer = setInterval(() => { void runKnowledgeAdapter(false) }, 5 * 60_000)
      knowledgeAdapterTimer.unref()
      return {
        store: knowledgeStore,
        search: semanticSearch,
        ...(embedder ? { embedder, embedQuery: (t: string) => embedder.embed([t]).then(v => v[0]!) } : {}),
        embedStatus: () => embedActive,
        // Knowledge Graph inproc (Task 5) — unconditional (unlike embedder
        // above): graph rebuild (graph-build.ts's rebuildGraphFromSource, run
        // every cycle above) needs no embed script, so the query accessor is
        // wired whenever knowledge_enabled is on at all.
        graph: makeGraphQueryApi(knowledgeStore),
        // Facts + Person (Knowledge Facts/Person inproc, Task 5) —
        // unconditional (like graph above): facts.db extraction/query needs
        // no embed script, so both accessors are wired whenever
        // knowledge_enabled is on at all.
        facts: makeFactsApi(knowledgeStore),
        person: makePersonApi(knowledgeStore),
      }
    } catch (err) {
      // Partial-construction cleanup: the store is already open, so a
      // failure past this point must close it before rethrowing, or the
      // sqlite handle leaks past the daemon's lifecycle (main.ts's shutdown
      // only closes boot.knowledge, which is undefined on a degraded boot).
      // The embedder needs NO equivalent cleanup here: makeEmbedderService
      // (embedder-service.ts) is a lazy, respawn-on-death singleton — it
      // spawns no subprocess until the first embed() call, so at
      // construction time (this try block) it holds no process handle to
      // leak; only knowledgeStore's already-open sqlite handle needs closing.
      try { knowledgeStore.close() } catch { /* best-effort */ }
      throw err
    }
  })
}
