import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildDesktopMarkdown, DESKTOP_MARKDOWN_OUT } from './build'

it.skipIf(!process.versions.bun)('keeps the browser ESM identical to the shared renderer (bun run build:markdown)', async () => {
  expect(readFileSync(DESKTOP_MARKDOWN_OUT, 'utf8')).toBe(await buildDesktopMarkdown())
})
