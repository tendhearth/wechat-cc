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
