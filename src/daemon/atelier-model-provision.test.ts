import { describe, it, expect, vi } from 'vitest'
import { provisionAtelierModel, type ProvisionDeps } from './atelier-model-provision'

const spec = { fileName: 'sd-turbo.safetensors', url: 'https://x/sd-turbo.safetensors', sha256: 'GOOD' }
const bytes = new Uint8Array([1, 2, 3])

function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    modelsDir: '/models', spec,
    fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch,
    hashFile: vi.fn(async () => 'GOOD'),
    writeResponseFile: vi.fn(async (_path, response, onProgress) => {
      const staged = new Uint8Array(await response.arrayBuffer())
      onProgress(staged.length)
    }),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    mkdir: async () => {},
    exists: () => false,
    ...over,
  }
}

describe('provisionAtelierModel', () => {
  it('downloads and writes when the model is absent', async () => {
    const d = deps()
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(true)
    expect(res.modelPath).toBe('/models/sd-turbo.safetensors')
    expect(d.writeResponseFile).toHaveBeenCalledWith(
      '/models/sd-turbo.safetensors.partial',
      expect.any(Response),
      expect.any(Function),
    )
    expect(d.rename).toHaveBeenCalledWith(
      '/models/sd-turbo.safetensors.partial',
      '/models/sd-turbo.safetensors',
    )
  })

  it('skips download when a valid model already exists', async () => {
    const d = deps({ exists: () => true, fetch: vi.fn() as unknown as typeof fetch })
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(false)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('re-downloads when the existing file fails checksum', async () => {
    let calls = 0
    const d = deps({ exists: () => true, hashFile: async () => (calls++ === 0 ? 'BAD' : 'GOOD') })
    const res = await provisionAtelierModel(d)
    expect(res.downloaded).toBe(true)
  })

  it('throws model_checksum_mismatch when the download is corrupt', async () => {
    const d = deps({ hashFile: async () => 'BAD' })
    await expect(provisionAtelierModel(d)).rejects.toThrow('model_checksum_mismatch')
    expect(d.rename).not.toHaveBeenCalled()
    expect(d.remove).toHaveBeenCalledWith('/models/sd-turbo.safetensors.partial')
  })

  it('streams progress while writing instead of buffering response.arrayBuffer in the provisioner', async () => {
    const progress: number[] = []
    const d = deps({
      writeResponseFile: vi.fn(async (_path, _response, onProgress) => {
        onProgress(1)
        onProgress(2)
        onProgress(3)
      }),
      onProgress: (received) => progress.push(received),
    })
    await provisionAtelierModel(d)
    expect(progress).toEqual([1, 2, 3])
  })

  it('retries transient download failures and reports lifecycle status', async () => {
    let calls = 0
    const states: string[] = []
    const d = deps({
      fetch: vi.fn(async () => {
        calls++
        if (calls < 2) throw new Error('network reset')
        return new Response(bytes)
      }) as unknown as typeof fetch,
      onStatus: (s) => states.push(s.state),
    })
    await provisionAtelierModel(d)
    expect(calls).toBe(2)
    expect(states).toEqual(['checking', 'downloading', 'downloading', 'ready'])
  })

  it('reports a terminal failure after exhausting retries', async () => {
    const states: string[] = []
    const d = deps({
      maxAttempts: 2,
      fetch: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch,
      onStatus: (s) => states.push(s.state),
    })
    await expect(provisionAtelierModel(d)).rejects.toThrow('offline')
    expect(states.at(-1)).toBe('failed')
  })
})
