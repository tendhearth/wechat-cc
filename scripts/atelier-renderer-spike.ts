/**
 * Phase-0 live smoke for the CC Atelier renderer.
 *
 * Usage:
 *   OPENAI_API_KEY=... bun scripts/atelier-renderer-spike.ts [output.png]
 *
 * This is a manual, paid, single-image smoke. It is not invoked by the daemon.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { makeOpenAiImageRenderer } from '../src/daemon/artwork-renderer'

const output = resolve(process.argv[2] ?? 'output/atelier-spike/sand-fish.png')
const apiKey = process.env.OPENAI_API_KEY ?? ''

if (!apiKey.trim()) {
  console.error('OPENAI_API_KEY is not set; live renderer smoke was not run.')
  process.exit(2)
}

const renderer = makeOpenAiImageRenderer({
  apiKey,
  ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
})

const prompt = [
  'A quiet, emotionally ambiguous physical artwork, not an emotion-label illustration.',
  'On wet beach sand at dusk, an unseen small companion used a water-softened twig to draw two simple fish that almost face each other but do not touch.',
  'A receding wave has erased half of one fish and softened repeated lines.',
  'Close intimate framing; damp grains, twig grooves, tiny pooled water and the act of erasing remain visible.',
  'Muted blue-hour light, restrained composition, generous quiet space.',
  'No words, labels, mascot, face, heart, sticker aesthetic, watermark, UI or person.',
].join(' ')

const result = await renderer.render({ prompt, quality: 'low', size: '1024x1024' })
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, result.bytes, { mode: 0o600 })
console.log(JSON.stringify({
  ok: true,
  output,
  renderer: result.rendererId,
  bytes: result.bytes.length,
  elapsed_ms: result.elapsedMs,
  request_id: result.requestId ?? null,
}))

