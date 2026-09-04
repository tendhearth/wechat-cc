import { describe, it, expect } from 'vitest'
import { buildSdCliArgs, makeSidecarRenderer, type SpawnFn } from './sidecar-renderer'
import { ArtworkRendererError } from './artwork-renderer'

describe('buildSdCliArgs', () => {
  it('builds txt2img argv with model, prompt, output, steps and size', () => {
    const args = buildSdCliArgs({
      modelPath: '/m/sd-turbo.safetensors',
      prompt: 'wet sand fish',
      outPath: '/tmp/out.png',
      steps: 4,
      width: 512,
      height: 512,
      cfgScale: 1,
    })
    expect(args).toEqual([
      '-m', '/m/sd-turbo.safetensors',
      '-p', 'wet sand fish',
      '-o', '/tmp/out.png',
      '--steps', '4',
      '--width', '512',
      '--height', '512',
      '--cfg-scale', '1',
    ])
  })
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])

function fakeSpawn(behavior: 'exit0' | 'exit1' | 'hang' | 'error'): SpawnFn {
  return () => {
    const handlers: Record<string, (arg: unknown) => void> = {}
    queueMicrotask(() => {
      if (behavior === 'exit0') handlers.exit?.(0)
      else if (behavior === 'exit1') handlers.exit?.(1)
      else if (behavior === 'error') handlers.error?.(new Error('spawn ENOENT'))
      // 'hang' never fires exit/error
    })
    return { on(ev: string, cb: (arg: unknown) => void) { handlers[ev] = cb } } as ReturnType<SpawnFn>
  }
}

function deps(spawn: SpawnFn, readFile: (p: string) => Promise<Uint8Array> = async () => PNG) {
  return {
    sdCliPath: '/bin/sd-cli', modelPath: '/m/sd-turbo.safetensors', workDir: '/work',
    spawn, readFile, mkdir: async () => {}, mkdtemp: async (p: string) => `${p}abc`,
    rm: async () => {}, timeoutMs: 50,
  }
}

describe('makeSidecarRenderer', () => {
  it('returns validated PNG bytes on exit code 0', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0')))
    const out = await r.render({ prompt: 'x' })
    expect(out.mime).toBe('image/png')
    expect(out.bytes).toEqual(PNG)
    expect(out.rendererId).toBe('local-sd:sd-turbo.safetensors')
  })

  it('creates the work directory before rendering so a first run cannot ENOENT', async () => {
    const calls: string[] = []
    const d = { ...deps(fakeSpawn('exit0')), workDir: '/fresh/work', mkdir: async (p: string) => { calls.push(p) } }
    await makeSidecarRenderer(d).render({ prompt: 'x' })
    expect(calls).toContain('/fresh/work')
  })

  it('maps non-zero exit to renderer_exec_error', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit1')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_exec_error' })
  })

  it('maps spawn error to renderer_exec_error', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('error')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_exec_error' })
  })

  it('times out a hung process with renderer_timeout', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('hang')))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_timeout' })
  })

  it('rejects an empty prompt with renderer_bad_request', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0')))
    await expect(r.render({ prompt: '   ' })).rejects.toMatchObject({ code: 'renderer_bad_request' })
  })

  it('rejects non-PNG output with renderer_bad_output', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit0'), async () => new Uint8Array([1, 2, 3])))
    await expect(r.render({ prompt: 'x' })).rejects.toMatchObject({ code: 'renderer_bad_output' })
  })

  it('never includes the prompt in the error message', async () => {
    const r = makeSidecarRenderer(deps(fakeSpawn('exit1')))
    await r.render({ prompt: 'SECRET_PROMPT' }).catch((e: unknown) => {
      expect((e as ArtworkRendererError).message).not.toContain('SECRET_PROMPT')
    })
  })
})
