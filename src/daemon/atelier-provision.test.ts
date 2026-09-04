import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatAtelierModelStatus,
  kickAtelierModelProvision,
  readModelStatus,
  runAtelierModelProvision,
  shouldProvisionOnConfigChange,
} from './atelier-provision'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'wcc-atelier-provision-'))
}

describe('atelier model provisioning trigger', () => {
  it('provisions only when the atelier turns from off to an enabled mode', () => {
    expect(shouldProvisionOnConfigChange('companion.atelier_mode', 'off', 'private')).toBe(true)
    expect(shouldProvisionOnConfigChange('companion.atelier_mode', null, 'share')).toBe(true)
    expect(shouldProvisionOnConfigChange('companion.atelier_mode', 'private', 'share')).toBe(false)
    expect(shouldProvisionOnConfigChange('companion.atelier_mode', 'private', 'off')).toBe(false)
    expect(shouldProvisionOnConfigChange('social_enabled', 'off', 'private')).toBe(false)
  })

  it('records a ready status the desktop can read after a successful download', async () => {
    const dir = tmp()
    await runAtelierModelProvision(dir, {
      provision: async (d) => {
        d.onStatus?.({ state: 'ready', modelPath: '/m/sd-turbo.safetensors', downloaded: true })
        return { modelPath: '/m/sd-turbo.safetensors', downloaded: true }
      },
    })
    expect(readModelStatus(dir)).toMatchObject({ state: 'ready', downloaded: true })
  })

  it('records a failed status and never rejects when the download throws', async () => {
    const dir = tmp()
    await expect(runAtelierModelProvision(dir, {
      provision: async (d) => {
        d.onStatus?.({ state: 'failed', error: 'model_download_failed_503' })
        throw new Error('model_download_failed_503')
      },
    })).resolves.toBeUndefined()
    expect(readModelStatus(dir)).toMatchObject({ state: 'failed', error: 'model_download_failed_503' })
  })

  it('streams a response into a verified model file using bounded-memory production adapters', async () => {
    const dir = tmp()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2))
        controller.enqueue(bytes.slice(2))
        controller.close()
      },
    })
    await runAtelierModelProvision(dir, {
      spec: { fileName: 'model.bin', url: 'https://example.test/model.bin', sha256 },
      fetch: vi.fn(async () => new Response(body, { headers: { 'content-length': String(bytes.length) } })) as unknown as typeof fetch,
    })

    const target = join(dir, 'atelier', 'models', 'model.bin')
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes)
    expect(existsSync(`${target}.partial`)).toBe(false)
    expect(readModelStatus(dir)).toMatchObject({ state: 'ready', modelPath: target, downloaded: true })
  })

  it('turns raw lifecycle status into a human label both surfaces can show', () => {
    expect(formatAtelierModelStatus(null)).toEqual({ label: '', done: false, failed: false })
    expect(formatAtelierModelStatus({ state: 'checking' }).label).toBe('正在检查画笔…')
    expect(formatAtelierModelStatus({ state: 'downloading', attempt: 1, received: 34, total: 100 }).label).toBe('正在下载画笔… 34%')
    expect(formatAtelierModelStatus({ state: 'downloading', attempt: 1, received: 5, total: 0 }).label).toBe('正在下载画笔…')
    expect(formatAtelierModelStatus({ state: 'ready', modelPath: '/m', downloaded: true })).toMatchObject({ done: true })
    expect(formatAtelierModelStatus({ state: 'failed', error: 'boom' })).toMatchObject({ failed: true })
  })

  it('deduplicates concurrent kicks so the 5GB download starts only once', async () => {
    const dir = tmp()
    const run = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
    const first = kickAtelierModelProvision(dir, { run })
    const second = kickAtelierModelProvision(dir, { run })
    expect(run).toHaveBeenCalledTimes(1)
    await Promise.all([first, second])
  })
})
