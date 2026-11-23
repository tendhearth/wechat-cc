type Field = { name: string; value: string }
type Change = { before: string; after: string }

export type PermissionDisplay = {
  note?: string
  body:
    | { kind: 'command'; command: string; cwd?: string }
    | { kind: 'edit'; path: string; changes: Change[]; replaceAll?: boolean }
    | { kind: 'write'; path: string; content: string }
    | { kind: 'patch'; files: Array<{ path: string; change: string; diff: string }> }
    | { kind: 'url'; url: string; prompt?: string }
    | { kind: 'query'; query: string }
    | { kind: 'fields'; fields: Field[] }
    | { kind: 'text'; text: string }
  extra?: Field[]
}

type Input = Record<string, unknown>
const object = (value: unknown): value is Input => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const fields = (input: Input, used: string[] = []): Field[] => Object.entries(input)
  .filter(([name]) => !used.includes(name))
  .map(([name, value]) => ({ name, value: string(value) ? value : JSON.stringify(value, null, 2) }))
const text = (value: string): PermissionDisplay => ({ body: { kind: 'text', text: value } })
const parseInput = (raw: string): unknown => JSON.parse(raw, (_key, value: unknown) => {
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('invalid_permission_number')
  return value
})
const commandTool = /^(?:bash|shell|exec_command|run_terminal_cmd|run_command)$/i

function jsonDisplay(tool: string, input: Input): PermissionDisplay | undefined {
  const withExtra = (body: PermissionDisplay['body'], used: string[], nested: Field[] = []) => {
    const extra = [...nested, ...fields(input, used)]
    return { body, ...(extra.length ? { extra } : {}) }
  }
  if (commandTool.test(tool)) {
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

// Recognize framing with either newline convention, and slice from the original
// string so a command, path or diff never inherits the parser's newline convention.
const newline = '\\r?\\n'
const patchKind = '(?:add|delete|update|move|rename|\\{[^\\r\\n]*"type"\\s*:\\s*"(?:add|delete|update|move|rename)"[^\\r\\n]*\\})'
const fileHeader = `([^\\r\\n]+)${newline}(${patchKind})${newline}`

function codexDisplay(tool: string, description: string): PermissionDisplay {
  const scopeMatches = [...description.matchAll(/\r?\nExecution environment: local(?=\r?\n|$)/g)]
  if (scopeMatches.length > 1) return text(description)
  const scopeAt = scopeMatches[0]?.index ?? description.length
  const payload = description.slice(0, scopeAt)
  const scope = description.slice(scopeAt).replace(/^\r?\n/, '')
  const extra = scope ? [{ name: 'Execution environment', value: scope.slice('Execution environment: '.length) }] : undefined
  const withNote = (body: PermissionDisplay['body'], note: string) => ({
    body, ...(note ? { note } : {}), ...(extra ? { extra } : {}),
  })
  if (tool === 'commandExecution') {
    const directories = [...payload.matchAll(/\r?\nWorking directory: ([^\r\n]+)(?:\r?\n|$)/g)]
    if (directories.length > 1) return text(description)
    const directory = directories[0]
    if (directory && directory.index > 0) return withNote(
      { kind: 'command', command: payload.slice(0, directory.index), cwd: directory[1]! },
      payload.slice(directory.index + directory[0].length))
    // With no directory delimiter, a multiline command and an appended reason
    // have the same wire shape. Keep both visible as supplied.
    return payload && (!scope || !/[\r\n]/.test(payload)) ? withNote({ kind: 'command', command: payload }, '') : text(description)
  }
  const first = new RegExp(`^${fileHeader}`).exec(payload)
  if (!first) return text(description)
  const subsequent = [...payload.matchAll(new RegExp(`${newline}${newline}${fileHeader}`, 'g'))]
  const headers = [first, ...subsequent]
  let note = ''
  const files = headers.map((header, index) => {
    let diff = payload.slice(header.index + header[0].length, headers[index + 1]?.index)
    if (index === headers.length - 1 && scope) {
      // Native unified diff lines have conventional prefixes. A trailing prose
      // reason can be shown separately when the diff has those prefixes.
      const reason = /\r?\n(?=[^ +\-@\\\r\n])/.exec(diff)
      if (reason && /^[ +\-@\\]/.test(diff)) {
        note = diff.slice(reason.index + reason[0].length)
        diff = diff.slice(0, reason.index)
      }
    }
    return { path: header[1]!, change: header[2]!, diff }
  })
  return withNote({ kind: 'patch', files }, note)
}

function acpCommand(description: string): PermissionDisplay {
  if (!/[\r\n]/.test(description)) return { body: { kind: 'command', command: description } }
  // Cursor's captured execute request has this reason after the command or
  // SDK title. ACP has no delimiter for arbitrary notes or locations.
  const marker = /\r?\nNot in allowlist: [^\r\n]+(?=\r?\n|$)/.exec(description)
  if (!marker || marker.index === 0) return text(description)
  const command = description.slice(0, marker.index)
  const [note, ...locations] = description.slice(marker.index + (marker[0].startsWith('\r') ? 2 : 1)).split(/\r?\n/)
  // An absolute location can follow the reason. Anything else might still
  // be part of a multiline command, so preserve that description as text.
  if (locations.some(line => !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(line))) return text(description)
  return { body: { kind: 'command', command }, note, ...(locations.length
    ? { extra: locations.map(value => ({ name: 'path', value })) } : {}) }
}

export function permissionDisplay(tool: string, description: string): PermissionDisplay {
  if (!description) return text(description)
  try {
    if (tool === 'commandExecution' || tool === 'fileChange') return codexDisplay(tool, description)
    const mcp = tool.startsWith('mcp__')
    if (mcp) {
      const codex = /^MCP server: ([^\r\n]+)\r?\nTool: ([^\r\n]+)\r?\nArguments:\r?\n([\s\S]+)\r?\n(Approve this invocation only\.)$/.exec(description)
      if (codex) {
        const input = parseInput(codex[3]!)
        return object(input) ? { body: { kind: 'fields', fields: fields(input) }, note: codex[4],
          extra: [{ name: 'MCP server', value: codex[1]! }, { name: 'Tool', value: codex[2]! }] } : text(description)
      }
    }
    const prefix = /(?:^|\r?\n)(command=|input=)/.exec(description)
    const note = prefix ? description.slice(0, prefix.index) : ''
    const inputText = prefix ? description.slice(prefix.index + prefix[0].length)
      : mcp && description.startsWith(`${tool}\n`) ? description.slice(tool.length + 1)
      : mcp && description.startsWith(`${tool}\r\n`) ? description.slice(tool.length + 2)
      : description
    if (prefix?.[1] === 'command=') return { body: { kind: 'command', command: inputText }, ...(note ? { note } : {}) }
    const looksJson = commandTool.test(tool) ? /^\s*\{\s*(?:["}]|$)/.test(inputText) : /^\s*[\[{]/.test(inputText)
    if (prefix || looksJson) {
      const input = parseInput(inputText)
      const result = object(input) ? jsonDisplay(tool, input) : undefined
      return result ? { ...result, ...(note ? { note } : {}) } : text(description)
    }
    if (commandTool.test(tool)) return { body: { kind: 'command', command: description } }
    if (tool === 'execute') return acpCommand(description)
    const artifact = tool === 'SaveArtifact' && /^SaveArtifact (.+) \((\d+) bytes; SHA256 ([a-f0-9]{64})\)$/.exec(description)
    if (artifact) return { body: { kind: 'fields', fields: [
      { name: 'path', value: artifact[1]! }, { name: 'bytes', value: artifact[2]! }, { name: 'SHA256', value: artifact[3]! },
    ] } }
    if ((tool === 'ReadFile' || tool === 'ListFiles') && description.startsWith(`${tool} `)) {
      return { body: { kind: 'fields', fields: [{ name: 'path', value: description.slice(tool.length + 1) }] } }
    }
    return text(description)
  } catch {
    return text(description)
  }
}
