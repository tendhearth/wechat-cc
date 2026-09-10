import { readFile, writeFile } from 'node:fs/promises'
import { prepareImage } from '../lib/image-prep'
import { resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { exec as execCb } from 'node:child_process'
import type { ToolSpec } from './openai-chat-model'

const exec = promisify(execCb)

export type ToolRisk = 'safe' | 'caution' | 'dangerous'

export interface BuiltinTool {
  spec: ToolSpec
  risk: ToolRisk
  execute(input: Record<string, unknown>): Promise<string>
  /**
   * 结果里带图的工具(view_image)。Chat Completions 的 tool 消息只能是文字,
   * 所以 provider 把 text 当工具结果、把 images 另起一条用户消息跟在后面送。
   */
  executeRich?(input: Record<string, unknown>): Promise<{ text: string; images: { data: Uint8Array; mediaType: string }[] }>
}

const abs = (cwd: string, p: string): string => (isAbsolute(p) ? p : resolve(cwd, p))
const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new Error(`missing/invalid "${field}"`)
  return v
}

export function builtinTools(cwd: string): BuiltinTool[] {
  return [
    {
      risk: 'safe',
      spec: {
        name: 'Read',
        description: 'Read a text file relative to the working directory. For images use view_image instead.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      async execute(input) {
        return await readFile(abs(cwd, str(input.path, 'path')), 'utf8')
      },
    },
    {
      risk: 'safe',
      spec: {
        name: 'view_image',
        description: 'View a local image file (png/jpg/gif/webp) when visual inspection is needed — e.g. an image the user sent ([image:path]) that you need to look at again, or a screenshot on disk. The image is shown to you in the next message.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      async execute(input) {
        return (await this.executeRich!(input)).text
      },
      async executeRich(input) {
        const p = abs(cwd, str(input.path, 'path'))
        const r = await prepareImage(p)
        if (!r.ok) return { text: `Could not load image ${p}: ${r.reason}`, images: [] }
        const dims = r.dims ? `${r.dims.w}x${r.dims.h}` : 'unknown size'
        const resized = r.resized ? ` (resized from ${r.resized.from.w}x${r.resized.from.h})` : ''
        return { text: `Loaded image ${p} (${dims}${resized}); it follows in the next message.`, images: [{ data: r.data, mediaType: r.mediaType }] }
      },
    },
    {
      risk: 'caution',
      spec: {
        name: 'Write',
        description: 'Write (overwrite) a text file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      async execute(input) {
        const p = abs(cwd, str(input.path, 'path'))
        await writeFile(p, str(input.content, 'content'), 'utf8')
        return `wrote ${p}`
      },
    },
    {
      risk: 'caution',
      spec: {
        name: 'Edit',
        description: 'Replace the first exact occurrence of "old" with "new" in a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
          required: ['path', 'old', 'new'],
        },
      },
      async execute(input) {
        const p = abs(cwd, str(input.path, 'path'))
        const old = str(input.old, 'old')
        const body = await readFile(p, 'utf8')
        if (!body.includes(old)) throw new Error(`"old" not found in ${p}`)
        await writeFile(p, body.replace(old, str(input.new, 'new')), 'utf8')
        return `edited ${p}`
      },
    },
    {
      risk: 'dangerous',
      spec: {
        name: 'Bash',
        description: 'Run a shell command in the working directory.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      async execute(input) {
        const { stdout, stderr } = await exec(str(input.command, 'command'), { cwd, timeout: 120_000 })
        return [stdout, stderr].filter(Boolean).join('\n') || '(no output)'
      },
    },
  ]
}
