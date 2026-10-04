import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

export const DESKTOP_MARKDOWN_OUT = new URL('../../apps/desktop/src/vendor/markdown.js', import.meta.url)

export async function buildDesktopMarkdown(): Promise<string> {
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))], format: 'esm', minify: true })
  if (!built.success) throw new Error(`buildDesktopMarkdown: ${built.logs.map(log => log.message).join('; ')}`)
  return built.outputs[0]!.text()
}

if (import.meta.main) writeFileSync(DESKTOP_MARKDOWN_OUT, await buildDesktopMarkdown())
