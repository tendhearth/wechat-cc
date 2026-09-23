import { join } from 'node:path'

export interface ModelSpec { fileName: string; url: string; sha256: string }

export interface ProvisionDeps {
  modelsDir: string
  spec: ModelSpec
  fetch: typeof fetch
  mkdir: (p: string) => Promise<void>
  exists: (p: string) => boolean
  /** Hash a file incrementally; model files are several GB and must not be buffered. */
  hashFile: (p: string) => Promise<string>
  /** Stream a response into a staging file and report cumulative bytes written. */
  writeResponseFile: (p: string, response: Response, onProgress: (received: number) => void) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (p: string) => Promise<void>
  onProgress?: (received: number, total: number) => void
  /** Persist UI-visible lifecycle state; failures here must not mask the real error. */
  onStatus?: (status: ModelProvisionStatus) => void
  maxAttempts?: number
}

export interface ProvisionResult { modelPath: string; downloaded: boolean }
export type ModelProvisionStatus =
  | { state: 'checking' }
  | { state: 'ready'; modelPath: string; downloaded: boolean }
  | { state: 'downloading'; attempt: number; received: number; total: number }
  | { state: 'failed'; error: string }

/**
 * First-enable model provisioning: download the weights to
 * `join(modelsDir, spec.fileName)` and verify SHA-256. Skips the download when
 * a valid file already exists; re-downloads when the existing file is corrupt.
 * Network is used only here, only during explicit first enable.
 */
export async function provisionAtelierModel(deps: ProvisionDeps): Promise<ProvisionResult> {
  const modelPath = join(deps.modelsDir, deps.spec.fileName)
  const partialPath = `${modelPath}.partial`
  const status = (s: ModelProvisionStatus) => { try { deps.onStatus?.(s) } catch {} }
  status({ state: 'checking' })

  try {
    if (deps.exists(modelPath)) {
      if (await deps.hashFile(modelPath) === deps.spec.sha256) {
        const result = { modelPath, downloaded: false }
        status({ state: 'ready', ...result })
        return result
      }
    }

    await deps.mkdir(deps.modelsDir)
    const attempts = Math.max(1, deps.maxAttempts ?? 3)
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await deps.remove(partialPath)
        const response = await deps.fetch(deps.spec.url)
        if (!response.ok) throw new Error(`model_download_failed_${response.status}`)
        const total = Number(response.headers.get('content-length') ?? 0)
        status({ state: 'downloading', attempt, received: 0, total })
        let received = 0
        await deps.writeResponseFile(partialPath, response, (nextReceived) => {
          received = nextReceived
          deps.onProgress?.(received, total || received)
          status({ state: 'downloading', attempt, received, total })
        })
        if (await deps.hashFile(partialPath) !== deps.spec.sha256) {
          throw new Error('model_checksum_mismatch')
        }
        // Commit only a complete, verified model. A crash or failed retry
        // leaves the last known-good target untouched.
        await deps.rename(partialPath, modelPath)
        const result = { modelPath, downloaded: true }
        status({ state: 'ready', ...result })
        return result
      } catch (error) {
        try { await deps.remove(partialPath) } catch {}
        lastError = error
        if (attempt < attempts) continue
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  } catch (error) {
    status({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
