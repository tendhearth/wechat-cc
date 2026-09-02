import { basename, join } from 'node:path'
import {
  type ArtworkRenderer,
  type RenderedArtwork,
  ArtworkRendererError,
  validatePngBytes,
} from './artwork-renderer'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export interface SdCliArgs {
  modelPath: string
  prompt: string
  outPath: string
  steps: number
  width: number
  height: number
}

/**
 * stable-diffusion.cpp `sd-cli` txt2img argv. Flags reflect the best-known
 * stable-diffusion.cpp interface; verify against the built binary during
 * packaging and adjust here (and the buildSdCliArgs test) if it differs.
 */
export function buildSdCliArgs(a: SdCliArgs): string[] {
  return [
    '-m', a.modelPath,
    '-p', a.prompt,
    '-o', a.outPath,
    '--steps', String(a.steps),
    '--width', String(a.width),
    '--height', String(a.height),
  ]
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { signal: AbortSignal },
) => {
  on(ev: 'exit', cb: (code: number | null) => void): void
  on(ev: 'error', cb: (err: Error) => void): void
}

export interface SidecarRendererDeps {
  sdCliPath: string
  modelPath: string
  workDir: string
  steps?: number
  width?: number
  height?: number
  timeoutMs?: number
  maxBytes?: number
  spawn: SpawnFn
  readFile: (p: string) => Promise<Uint8Array>
  mkdtemp: (prefix: string) => Promise<string>
  rm: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>
  now?: () => number
}

/**
 * Local, free, provider-independent renderer that spawns stable-diffusion.cpp
 * (`sd-cli`) once per render and reads the output PNG. No network, no cost, no
 * retry. Errors never echo the visual prompt or model bytes.
 */
export function makeSidecarRenderer(deps: SidecarRendererDeps): ArtworkRenderer {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const now = deps.now ?? Date.now
  const steps = deps.steps ?? 4
  const width = deps.width ?? 512
  const height = deps.height ?? 512
  const id = `local-sd:${basename(deps.modelPath)}`

  return {
    id,
    async render(request): Promise<RenderedArtwork> {
      const prompt = request.prompt.trim()
      if (!prompt) throw new ArtworkRendererError('renderer_bad_request', 'render prompt is empty')
      const startedAt = now()
      const dir = await deps.mkdtemp(join(deps.workDir, 'sd-'))
      const outPath = join(dir, 'out.png')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        await new Promise<void>((resolve, reject) => {
          // Enforce the timeout in the renderer, not via the injected spawn: on
          // abort we reject regardless of whether spawn wires abort → kill/error.
          controller.signal.addEventListener('abort', () =>
            reject(new ArtworkRendererError('renderer_timeout', `sd-cli timed out after ${timeoutMs}ms`)))
          const child = deps.spawn(
            deps.sdCliPath,
            buildSdCliArgs({ modelPath: deps.modelPath, prompt, outPath, steps, width, height }),
            { signal: controller.signal },
          )
          child.on('error', () => reject(
            controller.signal.aborted
              ? new ArtworkRendererError('renderer_timeout', `sd-cli timed out after ${timeoutMs}ms`)
              : new ArtworkRendererError('renderer_exec_error', 'sd-cli failed to start'),
          ))
          child.on('exit', (code) => {
            if (controller.signal.aborted) reject(new ArtworkRendererError('renderer_timeout', `sd-cli timed out after ${timeoutMs}ms`))
            else if (code === 0) resolve()
            else reject(new ArtworkRendererError('renderer_exec_error', `sd-cli exited with code ${code}`))
          })
        })
        const bytes = validatePngBytes(await deps.readFile(outPath), maxBytes)
        return { bytes, mime: 'image/png', rendererId: id, elapsedMs: Math.max(0, now() - startedAt) }
      } finally {
        clearTimeout(timer)
        await deps.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
