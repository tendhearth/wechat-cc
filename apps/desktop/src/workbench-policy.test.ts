import { describe, expect, it } from 'vitest'
import config from '../src-tauri/tauri.conf.json'

describe('packaged workbench preview policy', () => {
  it('allows the production PDF iframe to load its local blob snapshot', () => {
    const csp = config.app.security.csp
    const frameDirective = csp.split(';').map(part => part.trim()).find(part => part.startsWith('frame-src '))
    expect(frameDirective?.split(/\s+/)).toContain('blob:')
  })
})
