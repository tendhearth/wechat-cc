import { promises as fsp } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { ArtworkRenderer } from './artwork-renderer'
import { makeSidecarRenderer, type SidecarRendererDeps, type SpawnFn } from './sidecar-renderer'

export interface ResolveDeps {
  platform: string
  arch: string
  existsSync: (p: string) => boolean
  sdCliPath: string
  modelPath: string
  workDir: string
  makeRenderer?: (d: SidecarRendererDeps) => ArtworkRenderer
}

/**
 * Phase 1 availability gate: return a local renderer only on Apple Silicon
 * with the bundled sd-cli and a provisioned model present; otherwise null.
 * A null renderer flows into atelier-runtime as `skipped_no_renderer` — no
 * drawing, no error, no cost. Windows/Linux support is a planned follow-up.
 */
export function resolveAtelierRenderer(deps: ResolveDeps): ArtworkRenderer | null {
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64') return null
  if (!deps.existsSync(deps.sdCliPath)) return null
  if (!deps.existsSync(deps.modelPath)) return null
  const make = deps.makeRenderer ?? makeSidecarRenderer
  const spawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, args, { signal: opts.signal })
  return make({
    sdCliPath: deps.sdCliPath,
    modelPath: deps.modelPath,
    workDir: deps.workDir || tmpdir(),
    spawn,
    readFile: (p) => fsp.readFile(p),
    mkdtemp: (prefix) => fsp.mkdtemp(prefix),
    rm: (p, o) => fsp.rm(p, o),
  })
}
