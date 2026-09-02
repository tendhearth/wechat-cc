import { join } from 'node:path'

export interface ModelSpec { fileName: string; url: string; sha256: string }

export interface ProvisionDeps {
  modelsDir: string
  spec: ModelSpec
  fetch: typeof fetch
  readFile: (p: string) => Promise<Uint8Array>
  writeFile: (p: string, b: Uint8Array) => Promise<void>
  mkdir: (p: string) => Promise<void>
  exists: (p: string) => boolean
  sha256: (b: Uint8Array) => string
  onProgress?: (received: number, total: number) => void
}

export interface ProvisionResult { modelPath: string; downloaded: boolean }

/**
 * First-enable model provisioning: download the weights to
 * `join(modelsDir, spec.fileName)` and verify SHA-256. Skips the download when
 * a valid file already exists; re-downloads when the existing file is corrupt.
 * Network is used only here, only during explicit first enable.
 */
export async function provisionAtelierModel(deps: ProvisionDeps): Promise<ProvisionResult> {
  const modelPath = join(deps.modelsDir, deps.spec.fileName)

  if (deps.exists(modelPath)) {
    const existing = await deps.readFile(modelPath)
    if (deps.sha256(existing) === deps.spec.sha256) return { modelPath, downloaded: false }
  }

  await deps.mkdir(deps.modelsDir)
  const response = await deps.fetch(deps.spec.url)
  if (!response.ok) throw new Error(`model_download_failed_${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  deps.onProgress?.(bytes.length, bytes.length)
  if (deps.sha256(bytes) !== deps.spec.sha256) throw new Error('model_checksum_mismatch')
  await deps.writeFile(modelPath, bytes)
  return { modelPath, downloaded: true }
}
