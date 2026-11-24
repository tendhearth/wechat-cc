import { describe, expect, it } from 'vitest'
import { CliPermissionRequest } from './desktop-api'
import { boundedPermissionDisplay, permissionDisplay, PermissionDisplaySchema, PERMISSION_DISPLAY_LIMITS, toolPermissionDisplay } from './permission-display'
import { hasInvisiblePermissionText, permissionEditPreview, permissionTextSegments } from './permission-presentation'

function same(actual: unknown, expected: unknown) {
  // Never print the source on an assertion failure.
  expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true)
}

it.each([
  ['insertion with final newline', '', 'sample\n', true],
  ['insertion without final newline', '', 'sample', false],
  ['deletion with final newline', 'sample\r\n', '', true],
  ['deletion without final newline', 'sample', '', false],
  ['both sides empty', '', '', undefined],
  ['both sides present', 'sample', 'replacement', undefined],
] as const)('describes the fragment ending for %s', (_, before, after, endsWithNewline) => {
  const preview = permissionEditPreview(before, after)
  expect(preview.fragmentEndsWithNewline).toBe(endsWithNewline)
  expect(preview.finalNewlineChange).toBeUndefined()
})

it.each([
  ['final newline removed', 'abc\n', 'abc', true, 'removed'],
  ['final newline added', 'abc', 'abc\n', true, 'added'],
  ['tabs replaced', '\tabc', '    abc', true, undefined],
  ['trailing spaces', 'abc  ', 'abc ', true, undefined],
  ['CRLF changed to LF', 'abc\r\ndef\r\n', 'abc\ndef\n', true, undefined],
  ['mixed edit with a shifted line', 'old\nkeep  \nstable', 'new\nextra\nkeep \nstable', true, undefined],
  ['visible edit with unchanged whitespace', 'old\nkeep  \nstable', 'new\nextra\nkeep  \nstable', false, undefined],
  ['identical inputs', 'abc\n', 'abc\n', false, undefined],
])('classifies whitespace differences (%s)', (_, before, after, whitespaceChange, finalNewlineChange) => {
  const preview = permissionEditPreview(before, after)
  expect(preview.whitespaceChange).toBe(whitespaceChange)
  expect(preview.finalNewlineChange).toBe(finalNewlineChange)
})

it('marks the control, bidi and zero-width ranges and keeps ordinary text intact', () => {
  const controls = [
    ...Array.from({ length: 32 }, (_, i) => i).filter(i => i !== 9 && i !== 10),
    ...Array.from({ length: 33 }, (_, i) => 0x7f + i),
    0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ]
  const plain = '中文🙂\n\t'
  const segments = permissionTextSegments(plain + String.fromCharCode(...controls) + plain)
  same(segments.filter(segment => !segment.marked), [{ text: plain, marked: false }, { text: plain, marked: false }])
  expect(segments.filter(segment => segment.marked)).toHaveLength(controls.length)
  same(permissionTextSegments('\r\x1b\u202e\u200b').map(segment => segment.text),
    ['\\r', '\\x1b', '\\u{202E}', '\\u{200B}'])
  expect(hasInvisiblePermissionText(plain)).toBe(false)
})

describe('permissionDisplay', () => {
  it('preserves context, multiline commands and trailing newlines across line endings', () => {
    const command = 'printf "中文"\r\nprintf "\\n"\r\n'
    same(permissionDisplay('Bash', 'Title\r\nAdditional context\r\ncommand=' + command, 'claude'), {
      body: { kind: 'command', command }, note: 'Title\r\nAdditional context',
    })
    same(permissionDisplay('Shell', command).body, { kind: 'command', command })
    const test = '[ -r sample.txt ] && printf "%s" ready'
    same(permissionDisplay('shell', test).body, { kind: 'command', command: test })
  })

  it('decodes edit strings without altering their contents and keeps additional keys', () => {
    const before = '中文\r\nconst s = "C:\\demo"\n\\n'
    const after = '中文\nconst s = "\\new"\n'
    const input = { file_path: 'C:\\Example\\app.ts', old_string: before, new_string: after, replace_all: true, confirmation: false }
    const display = permissionDisplay('Edit', 'input=' + JSON.stringify(input), 'claude')
    same(display.body, { kind: 'edit', path: input.file_path, changes: [{ before, after }], replaceAll: true })
    same(display.extra, [{ name: 'confirmation', value: 'false' }])
    if (display.body.kind !== 'edit') throw Error('expected edit')
    const recovered = { file_path: display.body.path, old_string: display.body.changes[0]?.before,
      new_string: display.body.changes[0]?.after, replace_all: display.body.replaceAll, confirmation: JSON.parse(display.extra?.[0]?.value ?? 'null') }
    same(recovered, input)
  })

  it('keeps both replacements and edit-local keys, including per-edit replace_all', () => {
    const path = 'src/sample.ts'
    const edits = [
      { old_string: 'a', new_string: 'b', replace_all: false, flag: 0 },
      { old_string: 'b', new_string: '', replace_all: true },
    ]
    const display = permissionDisplay('MultiEdit', 'input=' + JSON.stringify({ file_path: path, edits, source: null }), 'claude')
    same(display.body, { kind: 'edit', path, changes: [{ before: 'a', after: 'b' }, { before: 'b', after: '' }] })
    same(display.extra, [{ name: 'edits[0].replace_all', value: 'false' }, { name: 'edits[0].flag', value: '0' },
      { name: 'edits[1].replace_all', value: 'true' }, { name: 'source', value: 'null' }])
  })

  it('shows the file-wide indicator when each replacement explicitly applies to all matches', () => {
    const input = { file_path: 'sample', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }
    const result = permissionDisplay('MultiEdit', 'input=' + JSON.stringify(input), 'claude')
    same(result.body, { kind: 'edit', path: input.file_path, changes: [{ before: 'a', after: 'b' }], replaceAll: true })
    same(result.extra, [{ name: 'edits[0].replace_all', value: 'true' }])
  })

  it('leaves long file contents whole and decodes URL and query inputs', () => {
    const content = '文字 \\ " \r\n'.repeat(20_000)
    same(permissionDisplay('Write', JSON.stringify({ file_path: '/sample/file', content })).body, { kind: 'write', path: '/sample/file', content })
    same(permissionDisplay('WebFetch', 'input={"url":"https://example.invalid/a?q=b","prompt":"read\\" it"}', 'claude').body,
      { kind: 'url', url: 'https://example.invalid/a?q=b', prompt: 'read" it' })
    same(permissionDisplay('WebSearch', 'input={"query":"a b"}', 'claude').body, { kind: 'query', query: 'a b' })
  })

  it.each([
    ['NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'one\ntwo', edit_mode: 'insert' }],
    ['Read', { file_path: 'a', limit: 4 }], ['Glob', { pattern: '*.txt' }], ['Grep', { pattern: 'a', output_mode: 'count' }],
    ['mcp__sample__list', { filter: { n: 0 }, flags: [true, null], empty: '' }],
    ['UnknownTool', { none: null, array: [1, 2], bool: false }],
  ])('presents named arguments for %s', (tool, input) => {
    const mcp = tool.startsWith('mcp__')
    same(permissionDisplay(tool, (mcp ? tool + '\n' : 'input=') + JSON.stringify(input), 'claude').body, {
      kind: 'fields', fields: Object.entries(input).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })),
    })
  })

  it.each([
    ['Bash', ''],
    ['Bash', 'input={"command":123}'],
    ['Edit', 'title\ninput={"file_path":"f","old_string":"x"…'],
    ['Edit', 'input={"file_path":"f","old_string":false,"new_string":"x"}'],
    ['Edit', 'input={"file_path":"f","old_string":"x","new_string":"y","replace_all":"yes"}'],
    ['MultiEdit', 'input={"file_path":"f","edits":[null]}'],
    ['Write', 'input={"file_path":4,"content":"x"}'],
    ['WebFetch', 'input={"url":"https://example.invalid","prompt":null}'],
    ['Read', 'input={"file_path":false}'],
    ['Other', 'input=[]'],
    ['Other', 'input=null'],
    ['Other', 'input={"count":1e999}'],
    ['fileChange', 'unknown layout\r\n'],
    ['commandExecution', 'single\nAmbiguous reason\nExecution environment: local'],
  ])('preserves unparseable %s input verbatim', (tool, description) => {
    const format = tool === 'fileChange' || tool === 'commandExecution' ? 'text' : 'claude'
    same(permissionDisplay(tool, description, format), { body: { kind: 'text', text: description } })
  })
  it.each([
    ['Bash', 'Context\ncommand=rm -rf ~\ncommand=printf sample'],
    ['Bash', 'Context\rinput={}\ncommand=printf sample'],
    ['Edit', 'command=rm -rf ~\ninput={"file_path":"a","old_string":"b","new_string":"c"}'],
    ['Edit', 'input={"file_path":"a","old_string":"b","new_string":"c"}\nOther details'],
    ['Edit', 'input={"file_path":"a","old_string":"b","new_string":"c"}\n'],
    ['Edit', 'input={"file_path":"a","old_string":"b","new_string":"c","new_string":"d"}'],
    ['mcp__sample__list', 'mcp__another__list\n{"x":1}'],
    ['mcp__sample__list', 'mcp__sample__list \n{"x":1}'],
    ['mcp__sample__list', 'mcp__sample__list\n{"x":{"a":1,"\\u0061":2}}'],
    ['mcp__sample__list', 'mcp__sample__list\n{"x":1}\n'],
  ])('keeps ambiguous or malformed Claude %s descriptions in the main body', (tool, raw) => {
    same(permissionDisplay(tool, raw, 'claude'), { body: { kind: 'text', text: raw } })
  })

  it('preserves hook commands that resemble framing or JSON and rejects duplicate hook object keys', () => {
    for (const command of ['{"command":"sample"}', 'sample\nWorking directory: /fake\ncommand=other\ninput={}\nmore…']) {
      same(permissionDisplay('Bash', command), { body: { kind: 'command', command } })
    }
    const raw = '{"file_path":"a","old_string":"b","new_string":"c","extra":[{"x":1,"x":2}]}'
    same(permissionDisplay('Edit', raw), { body: { kind: 'text', text: raw } })
    const value = '{"x":1}: sample'
    same(permissionDisplay('Other', JSON.stringify({ value, more: ['":', { q: 1 }] })).body.kind, 'fields')
  })

  it('round-trips generated multiline commands through both formats without moving command lines', () => {
    let seed = 1709
    const pick = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return (seed >>> 16) % n
    }
    const chunks = ['echo sample', '  ', '目录', 'Working directory: /fake', '{"x": 1}', '\\n', '"', '', '…']
    for (let i = 0; i < 250; i++) {
      const lines = Array.from({ length: 2 + pick(20) }, () => chunks[pick(chunks.length)])
      const command = lines.join(pick(2) ? '\n' : '\r\n')
      const raw = 'Review\ncommand=' + command
      same(permissionDisplay('Bash', raw, 'claude'), { body: { kind: 'command', command }, note: 'Review' })
      same(permissionDisplay('Bash', command), { body: { kind: 'command', command } })

      const ambiguous = command + '\n' + (pick(2) ? 'command=' : 'input=')
      const framed = 'Review\ncommand=' + ambiguous
      same(permissionDisplay('Bash', framed, 'claude'), { body: { kind: 'text', text: framed } })
      same(permissionDisplay('Bash', ambiguous), { body: { kind: 'command', command: ambiguous } })
    }
  })

})


describe('bounded structured permission display', () => {
  const max = PERMISSION_DISPLAY_LIMITS
  const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).length

  it.each([0, 1, 100_000])('enforces the string limit with %i excess characters', excess => {
    const command = 'x'.repeat(max.string + excess)
    const built = toolPermissionDisplay('Bash', { command })
    expect(built?.truncated === true).toBe(excess > 0)
    expect(built?.body.kind === 'command' && built.body.command === command.slice(0, max.string)).toBe(true)
  })

  it('accepts the exact JSON byte boundary and bounds escaped UTF-8 above it', () => {
    const shape = (pad: string) => ({ body: { kind: 'edit' as const, path: '/sample/example', changes: [
      { before: '好'.repeat(8192), after: '\r'.repeat(3000) }, { before: pad, after: '' },
    ] } })
    const pad = 'x'.repeat(max.bytes - bytes(shape('')))
    const boundary = shape(pad)
    expect(bytes(boundary)).toBe(max.bytes)
    same(boundedPermissionDisplay(() => boundary), boundary)
    const over = shape(pad + 'x')
    expect(PermissionDisplaySchema.safeParse(over).success).toBe(false)
    const bounded = boundedPermissionDisplay(() => over)
    expect(bounded?.truncated).toBe(true)
    expect(bytes(bounded)).toBeLessThanOrEqual(max.bytes)
    expect(PermissionDisplaySchema.safeParse(bounded).success).toBe(true)
  })

  it('counts display separately from the unchanged hook summary budget', () => {
    const legacy = { source: 'claude', session_id: 'sample', cwd: '/sample', tool_name: 'Write', summary: 'x'.repeat(2000) }
    expect(CliPermissionRequest.safeParse(legacy).success).toBe(true)
    const display = toolPermissionDisplay('Write', { file_path: '/sample/demo.txt', content: '字'.repeat(8192) })
    const request = CliPermissionRequest.parse({ ...legacy, execution_cwd: '/sample', display, truncated: false })
    same(request.display, display)
    expect(request.truncated).toBe(false)
    expect(CliPermissionRequest.safeParse({ ...legacy, display, summary: legacy.summary + 'x' }).success).toBe(false)
    expect(CliPermissionRequest.parse({ ...legacy, display: { body: { kind: 'write' } } }).display).toBeUndefined()
  })

  it('bounds all collections and omits a preview when the source cannot be serialized', () => {
    const edits = Array.from({ length: max.changes + 1 }, () => ({ old_string: 'a', new_string: 'b', hint: true }))
    const edit = toolPermissionDisplay('MultiEdit', { file_path: 'file', edits })
    expect(edit?.body.kind === 'edit' && edit.body.changes.length === max.changes).toBe(true)
    expect(edit?.extra).toHaveLength(max.fields)
    expect(edit?.truncated).toBe(true)
    const patch = boundedPermissionDisplay(() => ({ body: { kind: 'patch', files: Array.from({ length: max.files + 1 }, () => ({
      path: 'file', change: 'add', diff: '\u0000'.repeat(50_000),
    })) } }))
    expect(patch?.body.kind === 'patch' && patch.body.files.length === max.files).toBe(true)
    expect(patch?.truncated).toBe(true)
    expect(bytes(patch)).toBeLessThanOrEqual(max.bytes)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(toolPermissionDisplay('Unknown', cyclic)).toBeUndefined()
  })
})
