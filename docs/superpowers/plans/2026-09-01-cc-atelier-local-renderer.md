# CC Atelier Local Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user's CC a free, local, provider-independent image "brush" that renders one PNG on the user's own Apple Silicon Mac by spawning a bundled `stable-diffusion.cpp` binary, with no network and no cost.

**Architecture:** Add a second `ArtworkRenderer` implementation (`makeSidecarRenderer`) that spawns `sd-cli` per render and reads the output PNG, reusing the existing PNG validators. A model provisioner downloads the weights on first enable; a resolver decides availability (Apple Silicon + binary + model present) and returns a renderer or `null`, which the existing `atelier-runtime` already treats as `skipped_no_renderer`. The `sd-cli` binary is bundled as a Tauri `externalBin` sidecar.

**Tech Stack:** TypeScript, Bun runtime, vitest, Node `child_process`, Tauri (`externalBin` sidecar), stable-diffusion.cpp (`sd-cli`, Metal backend).

**Spec:** `docs/superpowers/specs/2026-09-01-cc-atelier-local-renderer-design.md` (and its parent `2026-09-01-cc-atelier-design.md`)

## Global Constraints

- **No network and no cost** anywhere in the render path. Only the model provisioner (Task 5) may access the network, and only during explicit first-enable.
- **Errors never echo the visual prompt** or model bytes. Copy this from the existing renderer's behavior.
- **No retry loops.** A failed render consumes the attempt and returns a typed error; the caller (`atelier-runtime`) never retries.
- **Fail-closed availability:** unsupported hardware / missing binary / missing model ⇒ resolver returns `null` ⇒ `atelier-runtime` no-ops with zero cost. Phase 1 targets **Apple Silicon (`process.platform === 'darwin' && process.arch === 'arm64'`) only**; Windows/Linux is a planned follow-up and out of scope here.
- **Test runner:** `bun --bun vitest run <file>` (single file: `npx vitest run <file>` also works). **Typecheck:** `bun run typecheck`.
- **Model storage:** `join(stateDir, 'atelier', 'models')`, mirroring the store's `join(stateDir, 'atelier', 'works')`.
- Reuse existing types from `src/daemon/artwork-renderer.ts`: `ArtworkRenderer`, `ArtworkRenderRequest`, `RenderedArtwork`, `ArtworkRendererError`, `ArtworkRendererErrorCode`. Do not fork them.

---

### Task 1: Extract a shared PNG validator from `artwork-renderer.ts`

Both renderers must validate PNG bytes identically. Extract the existing private helpers into one exported function, with no behavior change to the OpenAI renderer.

**Files:**
- Modify: `src/daemon/artwork-renderer.ts` (the private `isPng` + `decodePngBase64`, ~lines 68-87, and the error-code union ~lines 39-46)
- Test: `src/daemon/artwork-renderer.test.ts` (existing — add cases)

**Interfaces:**
- Produces:
  - `validatePngBytes(bytes: Uint8Array, maxBytes: number): Uint8Array` — throws `ArtworkRendererError('renderer_bad_output', ...)` if empty / not PNG magic; throws `ArtworkRendererError('renderer_output_too_large', ...)` if over `maxBytes`; otherwise returns `bytes`.
  - Extends `ArtworkRendererErrorCode` union with `'renderer_exec_error'` (used by the sidecar renderer in Task 2).

- [ ] **Step 1: Write the failing test**

Add to `src/daemon/artwork-renderer.test.ts`:

```ts
import { validatePngBytes, ArtworkRendererError } from './artwork-renderer'

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('validatePngBytes', () => {
  it('returns the bytes for a valid PNG within the cap', () => {
    const bytes = new Uint8Array([...PNG_MAGIC, 1, 2, 3])
    expect(validatePngBytes(bytes, 1024)).toBe(bytes)
  })

  it('rejects non-PNG bytes', () => {
    expect(() => validatePngBytes(new Uint8Array([1, 2, 3]), 1024))
      .toThrow(ArtworkRendererError)
  })

  it('rejects empty bytes', () => {
    expect(() => validatePngBytes(new Uint8Array([]), 1024)).toThrow(ArtworkRendererError)
  })

  it('rejects bytes over the cap with renderer_output_too_large', () => {
    const bytes = new Uint8Array([...PNG_MAGIC, ...new Array(100).fill(0)])
    try {
      validatePngBytes(bytes, PNG_MAGIC.length + 10)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ArtworkRendererError).code).toBe('renderer_output_too_large')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/artwork-renderer.test.ts`
Expected: FAIL — `validatePngBytes` is not exported.

- [ ] **Step 3: Refactor `artwork-renderer.ts`**

Add `'renderer_exec_error'` to the `ArtworkRendererErrorCode` union. Replace the private `isPng`/`decodePngBase64` internals with a shared exported validator, and have `decodePngBase64` call it:

```ts
export type ArtworkRendererErrorCode =
  | 'renderer_auth_missing'
  | 'renderer_bad_request'
  | 'renderer_http_error'
  | 'renderer_bad_output'
  | 'renderer_output_too_large'
  | 'renderer_timeout'
  | 'renderer_exec_error'

function isPng(bytes: Uint8Array): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value)
}

/** Shared by every renderer: reject non-PNG or oversized output. */
export function validatePngBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length === 0 || !isPng(bytes)) {
    throw new ArtworkRendererError('renderer_bad_output', 'image response was not a PNG')
  }
  if (bytes.length > maxBytes) {
    throw new ArtworkRendererError('renderer_output_too_large', `image exceeded ${maxBytes} bytes`)
  }
  return bytes
}

function decodePngBase64(value: string, maxBytes: number): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(value, 'base64'))
  } catch {
    throw new ArtworkRendererError('renderer_bad_output', 'image response was not valid base64')
  }
  return validatePngBytes(bytes, maxBytes)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/artwork-renderer.test.ts`
Expected: PASS (new `validatePngBytes` cases + all 5 original OpenAI renderer cases still green).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/daemon/artwork-renderer.ts src/daemon/artwork-renderer.test.ts
git commit -m "refactor(atelier): extract shared validatePngBytes + add renderer_exec_error code"
```

---

### Task 2: `buildSdCliArgs` — pure argv builder for `sd-cli`

Isolate the command-line construction so it is unit-testable without a real binary. Exact flags are the best-known `stable-diffusion.cpp` flags; verify against the built binary in Task 6 and adjust here if needed.

**Files:**
- Create: `src/daemon/sidecar-renderer.ts`
- Test: `src/daemon/sidecar-renderer.test.ts`

**Interfaces:**
- Produces:
  - `interface SdCliArgs { modelPath: string; prompt: string; outPath: string; steps: number; width: number; height: number }`
  - `buildSdCliArgs(a: SdCliArgs): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/sidecar-renderer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSdCliArgs } from './sidecar-renderer'

describe('buildSdCliArgs', () => {
  it('builds txt2img argv with model, prompt, output, steps and size', () => {
    const args = buildSdCliArgs({
      modelPath: '/m/sd-turbo.safetensors',
      prompt: 'wet sand fish',
      outPath: '/tmp/out.png',
      steps: 4,
      width: 512,
      height: 512,
    })
    expect(args).toEqual([
      '-m', '/m/sd-turbo.safetensors',
      '-p', 'wet sand fish',
      '-o', '/tmp/out.png',
      '--steps', '4',
      '--width', '512',
      '--height', '512',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/sidecar-renderer.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement `buildSdCliArgs`**

Create `src/daemon/sidecar-renderer.ts`:

```ts
export interface SdCliArgs {
  modelPath: string
  prompt: string
  outPath: string
  steps: number
  width: number
  height: number
}

/**
 * stable-diffusion.cpp `sd-cli` txt2img argv. Flags verified against the
 * built binary in the packaging task; adjust here if the binary differs.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/sidecar-renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sidecar-renderer.ts src/daemon/sidecar-renderer.test.ts
git commit -m "feat(atelier): sd-cli argv builder"
```

---

### Task 3: `makeSidecarRenderer` — spawn `sd-cli`, read + validate the PNG

The renderer spawns `sd-cli` into a private temp dir, waits with a timeout watchdog, then reads and validates the output PNG. The spawn function, filesystem reads, temp-dir creation, and clock are injected so tests never touch a real binary.

**Files:**
- Modify: `src/daemon/sidecar-renderer.ts`
- Test: `src/daemon/sidecar-renderer.test.ts`

**Interfaces:**
- Consumes: `buildSdCliArgs` (Task 2); `ArtworkRenderer`, `ArtworkRenderRequest`, `RenderedArtwork`, `ArtworkRendererError`, `validatePngBytes` (Task 1).
- Produces:
  - `type SpawnFn = (cmd: string, args: string[], opts: { signal: AbortSignal }) => { on(ev: 'exit', cb: (code: number | null) => void): void; on(ev: 'error', cb: (err: Error) => void): void }`
  - `interface SidecarRendererDeps { sdCliPath: string; modelPath: string; workDir: string; steps?: number; width?: number; height?: number; timeoutMs?: number; maxBytes?: number; spawn: SpawnFn; readFile: (p: string) => Promise<Uint8Array>; mkdtemp: (prefix: string) => Promise<string>; rm: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>; now?: () => number }`
  - `makeSidecarRenderer(deps: SidecarRendererDeps): ArtworkRenderer` — `id` is `local-sd:${basename(modelPath)}`.

- [ ] **Step 1: Write the failing tests**

Add to `src/daemon/sidecar-renderer.test.ts`:

```ts
import { makeSidecarRenderer, type SpawnFn } from './sidecar-renderer'
import { ArtworkRendererError } from './artwork-renderer'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])

function fakeSpawn(behavior: 'exit0' | 'exit1' | 'hang' | 'error'): SpawnFn {
  return () => {
    const handlers: Record<string, (arg: unknown) => void> = {}
    queueMicrotask(() => {
      if (behavior === 'exit0') handlers.exit?.(0)
      else if (behavior === 'exit1') handlers.exit?.(1)
      else if (behavior === 'error') handlers.error?.(new Error('spawn ENOENT'))
      // 'hang' never fires exit/error
    })
    return { on(ev: string, cb: (arg: unknown) => void) { handlers[ev] = cb } }
  }
}

function deps(spawn: SpawnFn, readFile = async () => PNG) {
  return {
    sdCliPath: '/bin/sd-cli', modelPath: '/m/sd-turbo.safetensors', workDir: '/work',
    spawn, readFile, mkdtemp: async (p: string) => `${p}abc`,
    rm: async () => {}, timeoutMs: 50,
  }
}

describe('makeSidecarRenderer', () => {
  it('returns validated PNG bytes on exit code 0', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0')))
    const out = await r.render({ prompt: 'x' })
    expect(out.mime).toBe('image/png')
    expect(out.bytes).toEqual(PNG)
    expect(out.rendererId).toBe('local-sd:sd-turbo.safetensors')
  })

  it('maps non-zero exit to renderer_exec_error', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit1')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_exec_error' })
  })

  it('maps spawn error to renderer_exec_error', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('error')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_exec_error' })
  })

  it('times out a hung process with renderer_timeout', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('hang')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_timeout' })
  })

  it('rejects an empty prompt with renderer_bad_request', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0')))
    await expect(r.render({ prompt: '   ' })).rejects.toMatchObject({ code: 'renderer_bad_request' })
  })

  it('rejects non-PNG output with renderer_bad_output', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0'), async () => new Uint8Array([1, 2, 3])))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_bad_output' })
  })

  it('never includes the prompt in the error message', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit1')))
    await r.render({ prompt: 'SECRET_PROMPT' }).catch((e: Error) => {
      expect(e.message).not.toContain('SECRET_PROMPT')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/daemon/sidecar-renderer.test.ts`
Expected: FAIL — `makeSidecarRenderer` not defined.

- [ ] **Step 3: Implement `makeSidecarRenderer`**

Append to `src/daemon/sidecar-renderer.ts`:

```ts
import { basename, join } from 'node:path'
import {
  type ArtworkRenderer,
  type RenderedArtwork,
  ArtworkRendererError,
  validatePngBytes,
} from './artwork-renderer'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/sidecar-renderer.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/daemon/sidecar-renderer.ts src/daemon/sidecar-renderer.test.ts
git commit -m "feat(atelier): local sd-cli sidecar renderer with timeout + validation"
```

---

### Task 4: `resolveAtelierRenderer` — the availability gate

Decide whether a local renderer is available on this machine and return it, or `null`. `null` flows into `atelier-runtime` as `skipped_no_renderer` (already implemented). Phase 1 gate: Apple Silicon + `sd-cli` present + model file present.

**Files:**
- Create: `src/daemon/atelier-renderer-resolve.ts`
- Test: `src/daemon/atelier-renderer-resolve.test.ts`

**Interfaces:**
- Consumes: `makeSidecarRenderer`, `SidecarRendererDeps` (Task 3); `ArtworkRenderer` (Task 1).
- Produces:
  - `interface ResolveDeps { platform: string; arch: string; existsSync: (p: string) => boolean; sdCliPath: string; modelPath: string; workDir: string; makeRenderer?: (d: SidecarRendererDeps) => ArtworkRenderer }`
  - `resolveAtelierRenderer(deps: ResolveDeps): ArtworkRenderer | null`

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/atelier-renderer-resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveAtelierRenderer } from './atelier-renderer-resolve'

const base = {
  sdCliPath: '/bin/sd-cli', modelPath: '/m/sd-turbo.safetensors', workDir: '/work',
  makeRenderer: () => ({ id: 'stub', render: async () => { throw new Error('unused') } }),
}
const present = () => true

describe('resolveAtelierRenderer', () => {
  it('returns a renderer on Apple Silicon with binary and model present', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: present })).not.toBeNull()
  })
  it('returns null on Intel mac', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'x64', existsSync: present })).toBeNull()
  })
  it('returns null on windows/linux (Phase 1)', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'win32', arch: 'x64', existsSync: present })).toBeNull()
  })
  it('returns null when the sd-cli binary is missing', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: (p) => p !== base.sdCliPath })).toBeNull()
  })
  it('returns null when the model file is missing', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: (p) => p !== base.modelPath })).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/daemon/atelier-renderer-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolveAtelierRenderer`**

Create `src/daemon/atelier-renderer-resolve.ts`:

```ts
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

/** Phase 1: Apple Silicon + bundled sd-cli + provisioned model, else null. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/atelier-renderer-resolve.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/daemon/atelier-renderer-resolve.ts src/daemon/atelier-renderer-resolve.test.ts
git commit -m "feat(atelier): renderer availability resolver (Apple Silicon Phase 1 gate)"
```

---

### Task 5: `provisionAtelierModel` — first-enable model download

Download the model to `join(stateDir, 'atelier', 'models')`, verify SHA-256, and skip re-download if already present and valid. `fetch` and filesystem are injected for tests; no real network in tests.

**Files:**
- Create: `src/daemon/atelier-model-provision.ts`
- Test: `src/daemon/atelier-model-provision.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelSpec { fileName: string; url: string; sha256: string }`
  - `interface ProvisionDeps { modelsDir: string; spec: ModelSpec; fetch: typeof fetch; readFile: (p: string) => Promise<Uint8Array>; writeFile: (p: string, b: Uint8Array) => Promise<void>; mkdir: (p: string) => Promise<void>; exists: (p: string) => boolean; sha256: (b: Uint8Array) => string; onProgress?: (received: number, total: number) => void }`
  - `interface ProvisionResult { modelPath: string; downloaded: boolean }`
  - `provisionAtelierModel(deps: ProvisionDeps): Promise<ProvisionResult>` — throws `Error('model_checksum_mismatch')` if the downloaded bytes fail SHA-256.

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/atelier-model-provision.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { provisionAtelierModel, type ProvisionDeps } from './atelier-model-provision'

const spec = { fileName: 'sd-turbo.safetensors', url: 'https://x/sd-turbo.safetensors', sha256: 'GOOD' }
const bytes = new Uint8Array([1, 2, 3])

function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    modelsDir: '/models', spec,
    fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch,
    readFile: async () => bytes,
    writeFile: vi.fn(async () => {}),
    mkdir: async () => {},
    exists: () => false,
    sha256: () => 'GOOD',
    ...over,
  }
}

describe('provisionAtelierModel', () => {
  it('downloads and writes when the model is absent', async () => {
    const d = deps()
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(true)
    expect(res.modelPath).toBe('/models/sd-turbo.safetensors')
    expect(d.writeFile).toHaveBeenCalled()
  })

  it('skips download when a valid model already exists', async () => {
    const d = deps({ exists: () => true, fetch: vi.fn() as unknown as typeof fetch })
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(false)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('re-downloads when the existing file fails checksum', async () => {
    let calls = 0
    const d = deps({ exists: () => true, sha256: () => (calls++ === 0 ? 'BAD' : 'GOOD') })
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(true)
  })

  it('throws model_checksum_mismatch when the download is corrupt', async () => {
    const d = deps({ sha256: () => 'BAD' })
    await expect(provisionAtelierModel(d)).rejects.toThrow('model_checksum_mismatch')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/daemon/atelier-model-provision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `provisionAtelierModel`**

Create `src/daemon/atelier-model-provision.ts`:

```ts
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/atelier-model-provision.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Typecheck and commit**

Follow-up UX hardening: provisioning now retries transient fetch errors (bounded
to three attempts by default), reports `checking/downloading/ready/failed`
status events, and remains checksum-gated before writing the model.

```bash
bun run typecheck
git add src/daemon/atelier-model-provision.ts src/daemon/atelier-model-provision.test.ts
git commit -m "feat(atelier): first-enable model provisioner with checksum verification"
```

---

### Task 6: Bundle `sd-cli` as a Tauri sidecar + manual real-spawn smoke

This task needs the **actual built `sd-cli` binary** and a **real model URL + SHA-256**, which the spec (§9) defers to implementation time. It is packaging + a manual smoke, not unit-tested logic.

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (`externalBin` array)
- Modify: `apps/desktop/scripts/build-sidecar.ts`
- Create: `scripts/atelier-sidecar-smoke.ts`

**Interfaces:**
- Consumes: `makeSidecarRenderer` (Task 3), `provisionAtelierModel` (Task 5).

- [x] **Step 1: Acquire the binary and model coordinates**

Build `stable-diffusion.cpp` for `aarch64-apple-darwin` with the Metal backend (per its README), producing a single `sd-cli`. Choose the default model (SD-Turbo single-file `safetensors`/`gguf`), record its download URL and `sha256`. Before pinning it, render a small comparison set covering at least watercolor/gouache, pencil or pen sketch, and oil/oil-pastel; reject a model/prompt combination that collapses them into photography or one generic house style. Fill the chosen coordinates into the `ModelSpec` used by provisioning and into the smoke script below. Verify the exact `sd-cli` flags match `buildSdCliArgs` (Task 2); if they differ, update Task 2's builder and its test.

- [x] **Step 2: Register the sidecar binary**

In `apps/desktop/src-tauri/tauri.conf.json`, add the sidecar to `externalBin` (Tauri requires the target-triple suffix on the on-disk file, e.g. `sd-cli-aarch64-apple-darwin`):

```json
"externalBin": [
  "binaries/wechat-cc-cli",
  "binaries/sd-cli"
]
```

- [x] **Step 3: Extend `build-sidecar.ts`**

In `apps/desktop/scripts/build-sidecar.ts`, add a step that places the built `sd-cli` at `apps/desktop/src-tauri/binaries/sd-cli-<target-triple>` (build-from-source or fetch a pinned release for the target arch), following the existing `wechat-cc-cli` handling in that file.

- [x] **Step 4: Write the manual smoke script**

Create `scripts/atelier-sidecar-smoke.ts` (mirrors `scripts/atelier-renderer-spike.ts`): resolve the bundled `sd-cli` and provisioned model paths, build a real `makeSidecarRenderer` (real `child_process.spawn`, real fs), render the selected smoke prompt, write the PNG locally, and print `{ ok, output, renderer, bytes, elapsed_ms }`. During model qualification, run the same path with contrasting watercolor/gouache, pencil/pen sketch, and oil/oil-pastel briefs so material fidelity—not one preferred house style—is the quality gate. It must refuse to run if the binary or model is missing (exit 2) and must never be invoked by the daemon or CI.

Add to root `package.json` scripts:

```json
"smoke:atelier-sidecar": "bun scripts/atelier-sidecar-smoke.ts"
```

- [x] **Step 5: Run the smoke on an Apple Silicon Mac**

Run: `bun run smoke:atelier-sidecar`
Expected: exits 2 with a clear message if the binary/model are absent; on a provisioned machine, writes one valid PNG and prints latency + byte size. Record the result.

- [ ] **Step 6: Commit**

Implementation follow-up (kept uncommitted with the current worktree):
`CompanionConfig.atelier_mode` is now a persistent `off | private | share`
setting exposed through `config_set`; `wireMain` mounts a throw-safe Atelier
cycle after introspection only when the mode is enabled and local sidecar/model
assets are present. Missing assets never trigger a download or renderer call.

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/scripts/build-sidecar.ts scripts/atelier-sidecar-smoke.ts package.json
git commit -m "feat(atelier): bundle sd-cli sidecar + manual real-spawn smoke"
```

---

### Task 7: Full-suite regression + docs

Confirm nothing regressed and the renderer/provisioner/resolver integrate with the existing Atelier suites.

**Files:**
- Modify: `docs/spike/cc-atelier-renderer/README.md` (append a "local renderer implemented" note)

- [x] **Step 1: Run the Atelier suites**

Run:
```bash
npx vitest run \
  src/daemon/artwork-renderer.test.ts \
  src/daemon/sidecar-renderer.test.ts \
  src/daemon/atelier-renderer-resolve.test.ts \
  src/daemon/atelier-model-provision.test.ts \
  src/daemon/art-impulse.test.ts \
  src/daemon/atelier-planner.test.ts \
  src/daemon/atelier-runtime.test.ts \
  src/daemon/atelier-store.test.ts
```
Expected: all green (the prior 25 + the new renderer/resolver/provisioner cases).

- [x] **Step 2: Full typecheck + suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: typecheck clean; full suite green (existing sticker/search/feedback tests unaffected).

- [x] **Step 3: Update the spike README**

Append to `docs/spike/cc-atelier-renderer/README.md` a short note: the local `sd-cli` sidecar renderer, availability resolver, and model provisioner are implemented and unit-tested; a real-spawn smoke exists behind `bun run smoke:atelier-sidecar`; it is still not wired into the daemon tick.

- [ ] **Step 4: Commit**

Integration note (2026-09-01): targeted Atelier/config/desktop tests and
typecheck pass. The full daemon Vitest run is not a valid gate in this
restricted environment: unrelated suites fail on random-port binding,
read-only `~/.claude/projects` fixtures, and Bun/Vitest mock-runner mismatch.

```bash
git add docs/spike/cc-atelier-renderer/README.md
git commit -m "docs(atelier): record local renderer implementation status"
```

---

## Self-Review

**Spec coverage:**
- §2 engine / spawn-per-render → Tasks 2, 3, 6. ✓
- §3.1 `makeSidecarRenderer` reusing validators → Tasks 1, 3. ✓
- §3.2 sidecar packaging → Task 6. ✓
- §3.3 model provisioning (first-enable, SHA-256, skip-if-present) → Task 5. ✓
- §4 failure isolation (timeout/kill, non-zero exit, bad output, no retry, prompt never echoed) → Task 3. ✓
- §5 Apple-Silicon Phase-1 gate + null → no-op → Task 4. ✓
- §6 tests incl. manual real-spawn smoke → Tasks 3, 5, 6. ✓
- §8 acceptance criteria 1-6 → Tasks 3-7. ✓
- §9 open items (flags, model URL/SHA, build mechanism) → Task 6 Step 1 explicitly resolves them. ✓

**Placeholder scan:** Task 6 is intentionally an external-artifact acquisition + manual smoke; its "fill in the real URL/SHA/flags" steps are genuine acquisition, not code placeholders. All code tasks (1-5) contain complete test + implementation code.

**Type consistency:** `SpawnFn`, `SidecarRendererDeps`, `makeSidecarRenderer`, `buildSdCliArgs`/`SdCliArgs`, `ResolveDeps`/`resolveAtelierRenderer`, `ModelSpec`/`ProvisionDeps`/`ProvisionResult`/`provisionAtelierModel`, `validatePngBytes`, and the `renderer_exec_error` code are used consistently across tasks. `resolveAtelierRenderer` returns `ArtworkRenderer | null`, matching `AtelierRuntimeDeps.renderer`.
