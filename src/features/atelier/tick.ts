/**
 * 画室那一拍:反省那一拍(companion introspect)的最后一步调它(wiring/introspect-steps.ts 的 atelierStep)。
 * 以前写在 wiring/index.ts 里,搬进功能目录时原样挪过来,只把用到的 boot / opts 收成 `AtelierTickDeps`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import { makeObservationsStore } from '../../daemon/observations/store'
import { resolveIntrospectChatId } from '../../daemon/companion/introspect-runtime'
import { makeAtelierStore } from './store'
import { makeJsonAtelierPlanner, type JsonAtelierPlannerDeps } from './planner'
import { locateAtelierSdCli, resolveAtelierRenderer } from './renderer-resolve'
import { buildAtelierContext, runAtelierCycle } from './runtime'

export interface AtelierTickDeps {
  stateDir: string
  db: Db
  /** 便宜模型(registry.getCheapEval);没有 ⇒ 这一拍跳过。 */
  cheapEval: () => JsonAtelierPlannerDeps['evaluate'] | null
  log: (tag: string, line: string) => void
}

export function makeAtelierTick(opts: AtelierTickDeps): (o?: { nowIso?: string }) => Promise<void> {
  // Atelier is deliberately lazy and default-off. The callback is mounted
  // only when the persisted mode is enabled and both local sidecar/model
  // paths are explicitly available; missing assets remain a safe no-op.
  return async ({ nowIso }: { nowIso?: string } = {}): Promise<void> => {
    const cfg = (await import('../../daemon/companion/config')).loadCompanionConfig(opts.stateDir)
    if (cfg.atelier_mode === 'off') return
    const sdCliPath = locateAtelierSdCli({
      explicitPath: process.env.WECHAT_CC_ATELIER_SD_CLI,
      execPath: process.execPath,
      stateDir: opts.stateDir,
      existsSync,
    })
    const modelPath = process.env.WECHAT_CC_ATELIER_SD_MODEL ?? join(opts.stateDir, 'atelier', 'models', 'sd-turbo.safetensors')
    const renderer = resolveAtelierRenderer({ platform: process.platform, arch: process.arch, existsSync, sdCliPath, modelPath, workDir: join(opts.stateDir, 'atelier', 'tmp') })
    if (!renderer) { opts.log('ATELIER', 'skip — local renderer/model unavailable'); return }
    const sdkEval = opts.cheapEval()
    if (!sdkEval) { opts.log('ATELIER', 'skip — no cheap evaluator'); return }
    const store = makeAtelierStore(opts.stateDir)
    const planner = makeJsonAtelierPlanner({ evaluate: sdkEval })
    // Feed CC its own derived signals (recent observations + persona) so a real
    // creative impulse can form. Falls back to empty context when CC has no
    // anchor chat yet — that just means no impulse, never a crash.
    const chatId = resolveIntrospectChatId(opts.stateDir)
    const memoryRoot = join(opts.stateDir, 'memory')
    let observations: Awaited<ReturnType<ReturnType<typeof makeObservationsStore>['listActive']>> = []
    let persona: string | null = null
    if (chatId) {
      try {
        observations = await makeObservationsStore(opts.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') }).listActive()
      } catch (err) { opts.log('ATELIER', `observations unavailable: ${String(err)}`) }
      try { persona = readFileSync(join(memoryRoot, chatId, 'persona.md'), 'utf8') } catch { /* persona is optional */ }
    }
    const result = await runAtelierCycle({
      stateDir: opts.stateDir,
      mode: cfg.atelier_mode,
      planner,
      renderer,
      store,
      context: buildAtelierContext({
        observations,
        persona,
        recentWorks: store.list(6).map(w => ({ id: w.id, createdAt: w.createdAt, subject: w.impulse.subject, surface: w.impulse.surface, medium: w.impulse.medium })),
        nowLocal: nowIso ?? new Date().toISOString(),
      }),
      log: (tag, line) => opts.log(tag, line),
    })
    opts.log('ATELIER', result.status === 'created'
      ? `cycle created record=${result.recordId} shared=${result.shared}`
      : `cycle ${result.status}`)
  }
}
