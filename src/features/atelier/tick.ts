/**
 * 画室那一拍:反省那一拍(companion introspect)的最后一步调它(wiring/introspect-steps.ts 的 atelierStep)。
 * 以前写在 wiring/index.ts 里,搬进功能目录时原样挪过来,只把用到的 boot / opts 收成 `AtelierTickDeps`。
 */
import { ccActsFor } from '../../adapters/store/cc-acts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import { makeObservationsStore } from '../../daemon/observations/store'
import { loadCompanionConfig } from '../../lib/companion-config'
import { makeAtelierStore } from './store'
import { makeJsonAtelierPlanner, type JsonAtelierPlannerDeps } from './planner'
import { locateAtelierSdCli, resolveAtelierRenderer } from './renderer-resolve'
import { appendAtelierSuccess, buildAtelierContext, runAtelierCycle } from './runtime'

export interface AtelierTickDeps {
  stateDir: string
  db: Db
  /** 便宜模型(registry.getCheapEval);没有 ⇒ 这一拍跳过。 */
  cheapEval: () => JsonAtelierPlannerDeps['evaluate'] | null
  log: (tag: string, line: string) => void
}

const ATELIER_RAN = new Set<string>(['created', 'render_failed', 'save_failed'])

export function makeAtelierTick(opts: AtelierTickDeps): (o?: { nowIso?: string }) => Promise<void> {
  // Atelier is deliberately lazy and default-off. The callback is mounted
  // only when the persisted mode is enabled and both local sidecar/model
  // paths are explicitly available; missing assets remain a safe no-op.
  return async ({ nowIso }: { nowIso?: string } = {}): Promise<void> => {
    const cfg = (await import('../../lib/companion-config')).loadCompanionConfig(opts.stateDir)
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
    // 主人那条对话(同反省那一拍的 resolveIntrospectChatId:companion 配置的 default_chat_id);画室不为这一行去引陪伴功能。
    const chatId = loadCompanionConfig(opts.stateDir).default_chat_id ?? null
    const memoryRoot = join(opts.stateDir, 'memory')
    let observations: Awaited<ReturnType<ReturnType<typeof makeObservationsStore>['listActive']>> = []
    let persona: string | null = null
    if (chatId) {
      try {
        observations = await makeObservationsStore(opts.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') }).listActive()
      } catch (err) { opts.log('ATELIER', `observations unavailable: ${String(err)}`) }
      try { persona = readFileSync(join(memoryRoot, chatId, 'persona.md'), 'utf8') } catch { /* persona is optional */ }
    }
    const startedAt = Date.now()
    // 「画室」那件事(M5b);M5d 起「画成了的那几次」也从它的轮推(和旧标记 successfulAt 合起来算),不再另记
    const acts = opts.db ? ccActsFor(opts.db, opts.log) : null
    const result = await runAtelierCycle({
      stateDir: opts.stateDir,
      // 节奏的时刻 = 这一轮的 startedAt:轮里推出来的「画成的那一刻」和以前记进 successfulAt 的是同一个值
      now: () => new Date(startedAt),
      ...(acts ? { successes: () => acts.runs('atelier', { status: 'completed', steps: false }).map(t => new Date(t.startedAt).toISOString()) } : {}),
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
    // 「画室」那件事的一轮(M5b):真动了笔才记(画成了 / 渲染或保存失败);没冲动、节奏没到、隐私拦下的不记
    if (acts && ATELIER_RAN.has(result.status)) {
      let recorded = false
      try {
        const t = acts.begin('atelier', { startedAt })
        if (result.status === 'created') { t.step('artifact', { work: result.recordId, shared: result.shared }); recorded = t.finish('completed') === true }
        else t.finish('failed', { errorCode: result.status })
      } catch { /* 只少一轮记录 */ }
      // 画成了、这一轮却没收成 completed(库写不进):记进旧标记,别让节奏漏掉这一次
      if (result.status === 'created' && !recorded) { try { appendAtelierSuccess(opts.stateDir, new Date(startedAt).toISOString()) } catch { /* 下一次节奏门只靠 lastEvaluatedAt */ } }
    }
    opts.log('ATELIER', result.status === 'created'
      ? `cycle created record=${result.recordId} shared=${result.shared}`
      : `cycle ${result.status}`)
  }
}
