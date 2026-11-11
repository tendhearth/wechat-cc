import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
it('ships the same Blender bytes as desktop, with no independently drawn App expressions', () => {
  const root = resolve(__dirname, '../../../..')
  for (const [name, path] of Object.entries({ 'input-up': 'input-up/000', 'read-down': 'read-down/000', 'speaking-1': 'speaking/001', 'speaking-2': 'speaking/002' })) {
    expect(readFileSync(`${root}/apps/app/assets/cc/attention/${name}.png`).equals(readFileSync(`${root}/apps/desktop/src/assets/pet/cc-v1/attention/lit/${path}.png`))).toBe(true)
  }
})
