/**
 * First-enable provisioning trigger for CC Atelier.
 *
 * When the owner turns the atelier on (companion.atelier_mode off → private|
 * share), CC quietly downloads its local "paint set" (the SD-Turbo weights) in
 * the background, records a UI-visible lifecycle status, and — because the
 * download is ~5GB — deduplicates concurrent kicks so it runs at most once.
 * Turning the atelier off downloads nothing. The SHA-256 is the integrity gate:
 * a wrong URL fails closed rather than installing bad bytes.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readJsonFile } from '../lib/read-json-file'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  provisionAtelierModel,
  type ModelProvisionStatus,
  type ModelSpec,
  type ProvisionDeps,
} from './atelier-model-provision'

/** Verified SD-Turbo weights fingerprint (see docs/spike/cc-atelier-renderer/README.md). */
export const ATELIER_MODEL_SHA256 = '3f067a1b943cf162f2b8f8588f6cf5824bd5b4c7d1d88d87164b9ca123616549'
export const ATELIER_MODEL_FILENAME = 'sd-turbo.safetensors'
const DEFAULT_SD_TURBO_URL = 'https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors'

/** Pinned model coordinates; URL is overridable for mirrors, SHA is not. */
export function atelierModelSpec(): ModelSpec {
  return {
    fileName: ATELIER_MODEL_FILENAME,
    url: process.env.WECHAT_CC_ATELIER_SD_MODEL_URL || DEFAULT_SD_TURBO_URL,
    sha256: ATELIER_MODEL_SHA256,
  }
}

/** Fire provisioning only on the off → enabled transition of the atelier switch. */
export function shouldProvisionOnConfigChange(key: string, previous: unknown, next: unknown): boolean {
  if (key !== 'companion.atelier_mode') return false
  const wasOff = previous === null || previous === undefined || previous === 'off'
  const nowOn = next === 'private' || next === 'share'
  return wasOff && nowOn
}

export function modelStatusPath(stateDir: string): string {
  return join(stateDir, 'atelier', 'model-status.json')
}

export function readModelStatus(stateDir: string): ModelProvisionStatus | null {
  try {
    return readJsonFile<ModelProvisionStatus>(modelStatusPath(stateDir))
  } catch {
    return null
  }
}

/**
 * One canonical rendering of the paint-set download status into a short human
 * label, shared in spirit by the phone settings page and the desktop atelier
 * gallery (both mirror this tiny logic in their own browser context).
 */
export function formatAtelierModelStatus(
  status: ModelProvisionStatus | null,
): { label: string; done: boolean; failed: boolean } {
  if (!status) return { label: '', done: false, failed: false }
  switch (status.state) {
    case 'checking':
      return { label: '正在检查画笔…', done: false, failed: false }
    case 'downloading': {
      if (status.total <= 0) return { label: '正在下载画笔…', done: false, failed: false }
      const pct = status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0
      return { label: `正在下载画笔… ${pct}%`, done: false, failed: false }
    }
    case 'ready':
      return { label: '画笔就绪 ✓', done: true, failed: false }
    case 'failed':
      return { label: '准备失败,点此重试', done: false, failed: true }
  }
}

function writeModelStatus(stateDir: string, status: ModelProvisionStatus): void {
  const file = modelStatusPath(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(status, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function writeResponseFile(
  path: string,
  response: Response,
  onProgress: (received: number) => void,
): Promise<void> {
  if (!response.body) throw new Error('model_download_empty_body')
  mkdirSync(dirname(path), { recursive: true })
  const reader = response.body.getReader()
  const file = await open(path, 'w', 0o600)
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, received)
        if (bytesWritten <= 0) throw new Error('model_download_write_stalled')
        offset += bytesWritten
        received += bytesWritten
      }
      onProgress(received)
    }
    await file.sync()
  } catch (error) {
    try { await reader.cancel() } catch {}
    throw error
  } finally {
    await file.close()
  }
}

export interface RunProvisionDeps {
  /** Injectable for tests; defaults to the real network+fs provisioner. */
  provision?: typeof provisionAtelierModel
  spec?: ModelSpec
  fetch?: ProvisionDeps['fetch']
}

/**
 * Awaitable core: download+verify the model, persisting lifecycle status the
 * desktop can read. Never rejects — failures are recorded as a 'failed' status
 * so the fire-and-forget kick below is safe.
 */
export async function runAtelierModelProvision(stateDir: string, deps: RunProvisionDeps = {}): Promise<void> {
  const provision = deps.provision ?? provisionAtelierModel
  let lastProgressWriteAt = 0
  let lastProgressPercent = -1
  try {
    await provision({
      modelsDir: join(stateDir, 'atelier', 'models'),
      spec: deps.spec ?? atelierModelSpec(),
      fetch: deps.fetch ?? fetch,
      mkdir: async (p) => { mkdirSync(p, { recursive: true }) },
      exists: (p) => existsSync(p),
      hashFile: hashFileSha256,
      writeResponseFile,
      rename,
      remove: async (p) => { await rm(p, { force: true }) },
      onStatus: (s) => {
        // A 5GB response can contain tens of thousands of chunks. Keep the UI
        // live without rewriting model-status.json for every network packet.
        if (s.state === 'downloading' && s.received > 0) {
          const now = Date.now()
          const percent = s.total > 0 ? Math.floor((s.received / s.total) * 100) : -1
          const complete = s.total > 0 && s.received >= s.total
          if (!complete && percent === lastProgressPercent && now - lastProgressWriteAt < 500) return
          lastProgressPercent = percent
          lastProgressWriteAt = now
        }
        try { writeModelStatus(stateDir, s) } catch { /* status is best-effort */ }
      },
    })
  } catch {
    // provisionAtelierModel already recorded a 'failed' status via onStatus.
  }
}

let inFlight: Promise<void> | null = null

export interface KickProvisionDeps {
  log?: (tag: string, line: string) => void
  /** Injectable for tests; defaults to runAtelierModelProvision. */
  run?: (stateDir: string) => Promise<void>
}

/**
 * Fire-and-forget provisioning on enable. Deduplicated: while one download is
 * in flight, further kicks return the same promise instead of starting a second
 * ~5GB transfer.
 */
export function kickAtelierModelProvision(stateDir: string, deps: KickProvisionDeps = {}): Promise<void> {
  if (inFlight) return inFlight
  const run = deps.run ?? runAtelierModelProvision
  inFlight = run(stateDir)
    .catch((err) => { deps.log?.('ATELIER', `model provision failed: ${err instanceof Error ? err.message : String(err)}`) })
    .finally(() => { inFlight = null })
  return inFlight
}
