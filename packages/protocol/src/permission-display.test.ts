import { describe, expect, it } from 'vitest'
import { permissionDisplay } from './permission-display'

function same(actual: unknown, expected: unknown) {
  // Never print the source on an assertion failure.
  expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true)
}

describe('permissionDisplay', () => {
  it('preserves context, multiline commands and trailing newlines across line endings', () => {
    const command = 'printf "中文"\r\nprintf "\\n"\r\n'
    same(permissionDisplay('Bash', 'Title\r\nAdditional context\r\ncommand=' + command), {
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
    const display = permissionDisplay('Edit', 'input=' + JSON.stringify(input))
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
    const display = permissionDisplay('MultiEdit', 'input=' + JSON.stringify({ file_path: path, edits, source: null }))
    same(display.body, { kind: 'edit', path, changes: [{ before: 'a', after: 'b' }, { before: 'b', after: '' }] })
    same(display.extra, [{ name: 'edits[0].replace_all', value: 'false' }, { name: 'edits[0].flag', value: '0' },
      { name: 'edits[1].replace_all', value: 'true' }, { name: 'source', value: 'null' }])
  })

  it('shows the file-wide indicator when each replacement explicitly applies to all matches', () => {
    const input = { file_path: 'sample', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }
    const result = permissionDisplay('MultiEdit', 'input=' + JSON.stringify(input))
    same(result.body, { kind: 'edit', path: input.file_path, changes: [{ before: 'a', after: 'b' }], replaceAll: true })
    same(result.extra, [{ name: 'edits[0].replace_all', value: 'true' }])
  })

  it('leaves long file contents whole and decodes URL and query inputs', () => {
    const content = '文字 \\ " \r\n'.repeat(20_000)
    same(permissionDisplay('Write', JSON.stringify({ file_path: '/sample/file', content })).body, { kind: 'write', path: '/sample/file', content })
    same(permissionDisplay('WebFetch', 'input={"url":"https://example.invalid/a?q=b","prompt":"read\\" it"}').body,
      { kind: 'url', url: 'https://example.invalid/a?q=b', prompt: 'read" it' })
    same(permissionDisplay('WebSearch', 'input={"query":"a b"}').body, { kind: 'query', query: 'a b' })
  })

  it.each([
    ['NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'one\ntwo', edit_mode: 'insert' }],
    ['Read', { file_path: 'a', limit: 4 }], ['Glob', { pattern: '*.txt' }], ['Grep', { pattern: 'a', output_mode: 'count' }],
    ['mcp__sample__list', { filter: { n: 0 }, flags: [true, null], empty: '' }],
    ['UnknownTool', { none: null, array: [1, 2], bool: false }],
  ])('presents named arguments for %s', (tool, input) => {
    same(permissionDisplay(tool, 'input=' + JSON.stringify(input)).body, {
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
    same(permissionDisplay(tool, description).body, { kind: 'text', text: description })
  })
})
