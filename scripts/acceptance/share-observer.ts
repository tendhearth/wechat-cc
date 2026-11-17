/** Capture the real panel solely for an HTTP-status probe after tunnel revocation. */
import { readFileSync } from 'node:fs'
import type { SettingsPanel } from '../../src/features/phone/settings-panel'
let panel: SettingsPanel | undefined
export const sharePanel = () => panel
export function installShareObserver() {
  ;(globalThis as any).__acceptanceSharePanel = (value: SettingsPanel) => { panel = value }
  Bun.plugin({ name: 'acceptance-share-panel-observer', setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]features[\\/]phone[\\/]settings-panel\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8'), signature = 'export function makeSettingsPanel('
      if (source.split(signature).length !== 2) throw Error('share observer source shape changed')
      return { loader: 'ts', contents: source.replace(signature, 'function original_makeSettingsPanel(') + `
export function makeSettingsPanel(...args: Parameters<typeof original_makeSettingsPanel>): ReturnType<typeof original_makeSettingsPanel> {
 const panel = original_makeSettingsPanel(...args); (globalThis as any).__acceptanceSharePanel(panel); return panel
}
` }
    })
  } })
}
