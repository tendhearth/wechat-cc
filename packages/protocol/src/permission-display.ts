import { array, boolean, discriminatedUnion, literal, strictObject, string as zString, type infer as Infer } from 'zod'

export const PERMISSION_DISPLAY_LIMITS = {
  string: 8192, changes: 16, files: 16, fields: 16, bytes: 32 * 1024,
} as const

const max = PERMISSION_DISPLAY_LIMITS
const value = zString().max(max.string)
const field = strictObject({ name: value, value })
const change = strictObject({ before: value, after: value, path: value.optional() })
const fieldList = array(field).max(max.fields)
const edit = strictObject({ kind: literal('edit'), path: value, changes: array(change).min(1).max(max.changes), replaceAll: boolean().optional() })

const displayShape = strictObject({
  note: value.optional(),
  body: discriminatedUnion('kind', [
    strictObject({ kind: literal('command'), command: value, cwd: value.optional() }),
    edit,
    strictObject({ kind: literal('write'), path: value, content: value }),
    strictObject({ kind: literal('patch'), files: array(strictObject({
      path: value, change: value, movePath: value.optional(), diff: value,
    })).min(1).max(max.files) }),
    strictObject({ kind: literal('url'), url: value, prompt: value.optional() }),
    strictObject({ kind: literal('query'), query: value }),
    strictObject({ kind: literal('fields'), fields: fieldList }),
    strictObject({ kind: literal('text'), text: value }),
  ]),
  extra: fieldList.optional(),
  truncated: boolean().optional(),
})

const wireBytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).length
export const PermissionDisplaySchema = displayShape.refine(data => wireBytes(data) <= max.bytes, { message: 'permission_display_too_large' })
export type PermissionDisplay = Infer<typeof PermissionDisplaySchema>
type Field = Infer<typeof field>
type Change = Infer<typeof change>

// A malformed optional preview must not invalidate an approval or its containing response.
export const permissionDisplayWire = PermissionDisplaySchema.optional().catch(undefined)
export const permissionCwdWire = zString().max(4096)
  .refine(path => /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) && !/[\u0000-\u001f]/.test(path))
  .optional().catch(undefined)

export function permissionCwd(input: unknown): string | undefined {
  return permissionCwdWire.safeParse(input).data
}

export function boundedPermissionDisplay(build: () => PermissionDisplay | undefined): PermissionDisplay | undefined {
  try {
    const source = build()
    if (!source) return
    let truncated = source.truncated === true
    const cap = (input: unknown, limit: number, key = ''): unknown => {
      if (typeof input === 'string' && key !== 'kind' && input.length > limit) {
        truncated = true
        // Keep the prefix byte-for-byte and avoid breaking a UTF-16 pair.
        const end = /[\uD800-\uDBFF]/.test(input.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(input.charAt(limit)) ? limit - 1 : limit
        return input.slice(0, end)
      }
      if (Array.isArray(input)) {
        const count = key === 'files' ? max.files : key === 'changes' ? max.changes : max.fields
        if (input.length > count) truncated = true
        return input.slice(0, count).map(item => cap(item, limit))
      }
      if (object(input)) return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, cap(item, limit, name)]))
      return input
    }
    const candidate = (limit: number) => {
      const data = cap(source, limit) as PermissionDisplay
      return truncated ? { ...data, truncated: true as const } : data
    }
    let data = candidate(max.string)
    // Find the largest shared string limit that fits the UTF-8 JSON budget.
    if (wireBytes(data) > max.bytes) {
      truncated = true
      let low = 0, high: number = max.string - 1
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (wireBytes(candidate(mid)) <= max.bytes) low = mid
        else high = mid - 1
      }
      data = candidate(low)
    }
    return PermissionDisplaySchema.safeParse(data).data
  } catch {
    return undefined
  }
}

export function toolPermissionDisplay(tool: string, input: unknown, note?: string): PermissionDisplay | undefined {
  return boundedPermissionDisplay(() => {
    const result = object(input) && isPermissionCommandTool(tool) && Array.isArray(input.command) && input.command.every(string)
      ? { body: { kind: 'fields' as const, fields: fields(input) } }
      : object(input) ? jsonDisplay(tool, input)
      : string(input) && isPermissionCommandTool(tool) ? { body: { kind: 'command' as const, command: input } } : undefined
    return result && (note ? { ...result, note } : result)
  })
}

type Input = Record<string, unknown>
const object = (value: unknown): value is Input => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const fields = (input: Input, used: string[] = []): Field[] => Object.entries(input)
  .filter(([name]) => !used.includes(name))
  .map(([name, value]) => ({ name, value: string(value) ? value : JSON.stringify(value, null, 2) }))
const text = (value: string): PermissionDisplay => ({ body: { kind: 'text', text: value } })
function parseInput(raw: string): Input | undefined {
  // JSON.parse erases duplicate members before its reviver runs. Count the
  // source keys (ignoring string contents) and compare with the decoded tree.
  if (!raw.startsWith('{') || !raw.endsWith('}')) return
  let decodedKeys = 0
  const result: unknown = JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('invalid_permission_number')
    if (object(value)) decodedKeys += Object.keys(value).length
    return value
  })
  if (!object(result)) return
  let sourceKeys = 0
  for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"\s*(:)?/g)) {
    if (token[1]) sourceKeys++
  }
  if (sourceKeys === decodedKeys) return result
}

const commandTools = new Set(['bash', 'shell', 'exec_command', 'run_terminal_cmd', 'run_command'])
export const isPermissionCommandTool = (tool: string): boolean => commandTools.has(tool.toLowerCase())

function jsonDisplay(tool: string, input: Input): PermissionDisplay | undefined {
  const withExtra = (body: PermissionDisplay['body'], used: string[], nested: Field[] = []) => {
    const extra = [...nested, ...fields(input, used)]
    return { body, ...(extra.length ? { extra } : {}) }
  }
  if (isPermissionCommandTool(tool)) {
    if (!string(input.command) || (input.cwd !== undefined && !string(input.cwd))) return
    return withExtra({ kind: 'command', command: input.command, ...(string(input.cwd) ? { cwd: input.cwd } : {}) }, ['command', 'cwd'])
  }
  switch (tool.toLowerCase()) {
    case 'edit':
    case 'multiedit': {
      const multiple = tool.toLowerCase() === 'multiedit'
      const edits = multiple ? input.edits : [input]
      if (!string(input.file_path) || !Array.isArray(edits) || !edits.length ||
          (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')) return
      const changes: Change[] = []
      const nested: Field[] = []
      for (const [i, edit] of edits.entries()) {
        if (!object(edit) || !string(edit.old_string) || !string(edit.new_string) ||
            (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean')) return
        changes.push({ before: edit.old_string, after: edit.new_string })
        if (multiple) nested.push(...fields(edit, ['old_string', 'new_string']).map(field => ({
          ...field, name: `edits[${i}].${field.name}`,
        })))
      }
      const replaceAll = input.replace_all ?? (multiple && edits.every(edit => edit.replace_all === true) ? true : undefined)
      const body: PermissionDisplay['body'] = { kind: 'edit', path: input.file_path, changes,
        ...(typeof replaceAll === 'boolean' ? { replaceAll } : {}) }
      return withExtra(body, multiple ? ['file_path', 'edits', 'replace_all'] : ['file_path', 'old_string', 'new_string', 'replace_all'], nested)
    }
    case 'write':
      if (string(input.file_path) && string(input.content)) return withExtra(
        { kind: 'write', path: input.file_path, content: input.content }, ['file_path', 'content'])
      return
    case 'webfetch':
      if (string(input.url) && (input.prompt === undefined || string(input.prompt))) return withExtra(
        { kind: 'url', url: input.url, ...(string(input.prompt) ? { prompt: input.prompt } : {}) }, ['url', 'prompt'])
      return
    case 'websearch':
      if (string(input.query)) return withExtra({ kind: 'query', query: input.query }, ['query'])
      return
    default: {
      // These tools use named arguments, including NotebookEdit's cell ID, mode and source.
      const required: Record<string, string> = { notebookedit: 'notebook_path', read: 'file_path', glob: 'pattern', grep: 'pattern' }
      const key = Object.hasOwn(required, tool.toLowerCase()) ? required[tool.toLowerCase()] : undefined
      if (key && !string(input[key])) return
      return { body: { kind: 'fields', fields: fields(input) } }
    }
  }
}

type DescriptionFormat = 'hook' | 'claude' | 'api' | 'text'

function claudeDisplay(tool: string, description: string): PermissionDisplay | undefined {
  if (tool.startsWith('mcp__')) {
    const header = /^([^\r\n]*)\r?\n/.exec(description)
    if (header?.[1] !== tool) return
    const input = parseInput(description.slice(header[0].length))
    if (input) return { body: { kind: 'fields', fields: fields(input) } }
    return
  }
  // More than one marker could mean a forged context line or a command line.
  const markers = [...description.matchAll(/(?:^|\r\n?|\n)(command=|input=)/g)]
  if (markers.length !== 1) return
  const marker = markers[0]!
  const note = description.slice(0, marker.index)
  const payload = description.slice(marker.index + marker[0].length)
  if (marker[1] === 'command=') return { body: { kind: 'command', command: payload }, ...(note ? { note } : {}) }
  const input = parseInput(payload)
  const display = input && jsonDisplay(tool, input)
  if (display) return { ...display, ...(note ? { note } : {}) }
}

function apiDisplay(tool: string, description: string): PermissionDisplay | undefined {
  if (tool === 'ReadFile' || tool === 'ListFiles') {
    const prefix = tool + ' '
    const path = description.slice(prefix.length)
    if (description.startsWith(prefix) && path && !/[\u0000-\u001f\u007f]/.test(path)) {
      return { body: { kind: 'fields', fields: [{ name: 'path', value: path }] } }
    }
  }
  if (tool === 'SaveArtifact') {
    // Only the fixed, terminal byte count and digest are metadata. The entire
    // preceding filename remains the path, even if it contains a lookalike.
    const match = /^SaveArtifact (\.cc-workbench\/[a-f0-9]{8}\/[^/\\\u0000-\u001f\u007f]+) \((\d+) bytes; SHA256 ([a-f0-9]{64})\)$/.exec(description)
    if (match?.[0] === description) return { body: { kind: 'fields', fields: [
      { name: 'path', value: match[1]! }, { name: 'bytes', value: match[2]! }, { name: 'SHA256', value: match[3]! },
    ] } }
  }
}

export function permissionDisplay(tool: string, description: string, format: DescriptionFormat = 'hook'): PermissionDisplay {
  if (!description) return text(description)
  try {
    switch (format) {
      case 'claude': return claudeDisplay(tool, description) ?? text(description)
      case 'api': return apiDisplay(tool, description) ?? text(description)
      case 'text': return text(description)
      case 'hook': {
        if (isPermissionCommandTool(tool)) return { body: { kind: 'command', command: description } }
        const input = parseInput(description)
        return (input && jsonDisplay(tool, input)) ?? text(description)
      }
    }
  } catch {
    return text(description)
  }
}
