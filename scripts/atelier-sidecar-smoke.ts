/**
 * Manual, local, cost-free smoke for the CC Atelier local renderer.
 *
 * Spawns the real bundled `sd-cli` against a provisioned model and writes one
 * PNG locally. Never invoked by the daemon or CI. Refuses to run (exit 2) if
 * the binary or model is missing.
 *
 * Usage:
 *   SD_CLI=/path/to/sd-cli SD_MODEL=/path/to/sd_turbo.safetensors \
 *     bun scripts/atelier-sidecar-smoke.ts [output.png]
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { makeSidecarRenderer, type SpawnFn } from '../src/daemon/sidecar-renderer'

const sdCliPath = process.env.SD_CLI ?? ''
const modelPath = process.env.SD_MODEL ?? ''
const output = resolve(process.argv[2] ?? 'output/atelier-sidecar/first-image.png')

if (!sdCliPath || !existsSync(sdCliPath)) {
  console.error(`sd-cli not found (set SD_CLI). Got: ${sdCliPath || '<unset>'}`)
  process.exit(2)
}
if (!modelPath || !existsSync(modelPath)) {
  console.error(`model not found (set SD_MODEL). Got: ${modelPath || '<unset>'}`)
  process.exit(2)
}

const nodeSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, { signal: opts.signal, stdio: 'inherit' })

const renderer = makeSidecarRenderer({
  sdCliPath,
  modelPath,
  workDir: tmpdir(),
  // SD-Turbo: few steps, low CFG, euler — set via extraArgs is not modeled here;
  // the smoke uses the renderer defaults (steps 4, 512x512).
  spawn: nodeSpawn,
  readFile: (p) => fsp.readFile(p),
  mkdir: (p) => fsp.mkdir(p, { recursive: true }).then(() => {}),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  rm: (p, o) => fsp.rm(p, o),
})

const prompt = [
  'A quiet, emotionally ambiguous physical artwork, not an emotion-label illustration.',
  'On wet beach sand at dusk, an unseen small companion used a water-softened twig to draw two simple fish that almost face each other but do not touch.',
  'A receding wave has erased half of one fish and softened repeated lines.',
  'Close intimate framing; damp grains, twig grooves, tiny pooled water and the act of erasing remain visible.',
  'Muted blue-hour light, restrained composition, generous quiet space.',
  'No words, labels, mascot, face, heart, sticker aesthetic, watermark, UI or person.',
].join(' ')

const result = await renderer.render({ prompt })
await fsp.mkdir(dirname(output), { recursive: true })
await fsp.writeFile(output, result.bytes, { mode: 0o600 })
console.log(JSON.stringify({
  ok: true,
  output,
  renderer: result.rendererId,
  bytes: result.bytes.length,
  elapsed_ms: result.elapsedMs,
}))
