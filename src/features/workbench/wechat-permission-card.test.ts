import { expect, it } from 'vitest'
import { PERMISSION_SNAPSHOT_NOTICE, type PermissionDisplay } from '@wechat-cc/protocol'
import { MAX_TEXT_CHUNK } from '../../lib/config'
import { WECHAT_PERMISSION_INCOMPLETE } from '../../ports/wechat'
import { wechatPermissionSource, type PendingWorkbenchPermission } from '../../ports/workbench'
import { renderWechatPermissionCard } from './wechat-permission-card'

const permission: PendingWorkbenchPermission = {
  id: '246c6247-a81c-4fc8-b37b-c2af4872128f', taskId: 'd0c04242', tool: 'Bash',
  description: 'command=printf demo', cwd: '/demo/portfolio', createdAt: 0,
}
const render = (body: PermissionDisplay['body'], options: Partial<PendingWorkbenchPermission> = {}, provider = 'claude') =>
  renderWechatPermissionCard('整理示例', {
    ...permission, tool: body.kind === 'edit' ? 'Edit' : body.kind === 'write' ? 'Write' : permission.tool,
    display: { body }, ...options,
  }, provider, '08')

it('lays out a multiline command, verified directory, one-line reason and the exact original reply instructions', () => {
  const card = render({ kind: 'command', command: 'unused' }, {
    display: { body: { kind: 'command', command: 'npm install sharp\nprintf ready' }, note: '更新依赖\n并检查输出' },
    cwd: '/demo/portfolio', showSnapshotNotice: true, canAllowTask: true, canDenyWithReason: true,
  })
  expect(card.complete).toBe(true)
  expect(card.text.split('\n')).toEqual([
    '整理示例 · d0c04242', `〔请求 ${card.marker}〕`, 'Claude 想运行一条命令：', '〔命令开始〕',
    '│ npm install sharp', '│ printf ready', '〔命令结束〕', '原因："更新依赖\\n并检查输出"', '在 "/demo/portfolio"', PERMISSION_SNAPSHOT_NOTICE,
    '回「y 08」允许这一步、「n 08」拒绝。拒绝理由选填：「n 08 理由」。回「yt 08」本任务同命令都允许，任务结束失效。',
  ])
  expect(card.marker).toMatch(/^[a-f0-9]{16}$/)
  expect(card.text).not.toContain(permission.id)
})

it('shows every changed line and its path, including replace-all and missing final line endings', () => {
  const card = render({ kind: 'edit', path: 'src/a.ts', replaceAll: true, changes: [
    { before: 'old\n', after: 'new' }, { path: 'src/b.ts', before: 'one\n', after: 'two\n' },
  ] })
  expect(card.complete).toBe(true)
  expect(card.text.split('\n').slice(2, -1)).toEqual([
    'Claude 想改 "src/a.ts"（2 处）：', 'replace_all：true', '改动 "src/a.ts"：', '- "old"', '+ "new"',
    '〔改后末尾无换行〕', '改动 "src/b.ts"：', '- "one"', '+ "two"', '在 "/demo/portfolio"',
  ])
})

it('shows complete write content including an empty line', () => {
  const card = render({ kind: 'write', path: 'note.txt', content: 'first\n\nlast' })
  expect(card.complete).toBe(true)
  expect(card.text).toContain('Claude 想写一个文件：\n"note.txt"\n| "first"\n| ""\n| "last"\n〔文件末尾无换行〕')
})

it('shows each Codex file action and the destination without exposing a diff', () => {
  const card = render({ kind: 'patch', files: [
    { path: 'new.txt', change: 'add', diff: '+UNSHOWN_A' },
    { path: 'edit.txt', change: 'update', diff: '+UNSHOWN_B' },
    { path: 'delete.txt', change: 'delete', diff: '-UNSHOWN_C' },
    { path: 'old.txt', change: 'update', movePath: 'moved.txt', diff: '-UNSHOWN_D' },
  ] }, { tool: 'fileChange' }, 'codex')
  expect(card.complete).toBe(false)
  expect(card.text).toContain('Codex 想改 4 个文件：\n"new.txt"（新建）\n"edit.txt"（修改）\n"delete.txt"（删除）\n"old.txt"（改名 → moved.txt）')
  expect(card.text).not.toContain('UNSHOWN')
  expect(card.text.endsWith(`${WECHAT_PERMISSION_INCOMPLETE}\n回「n 08」拒绝。`)).toBe(true)
})

it.each([
  [{ kind: 'url', url: 'https://example.invalid/sample', prompt: '只看标题' }, 'WebFetch', 'Claude 想打开一个网址：\n网址："https://example.invalid/sample"\n要求："只看标题"'],
  [{ kind: 'query', query: '示例框架文档' }, 'WebSearch', 'Claude 想上网搜一下：\n搜索："示例框架文档"'],
  [{ kind: 'fields', fields: [{ name: 'pattern', value: '*.ts' }] }, 'Glob', 'Claude 想用「Glob」：\npattern："*.ts"'],
  [{ kind: 'text', text: 'tool-specific text' }, 'Example', 'Claude 想用「Example」：\ntool-specific text'],
] satisfies [PermissionDisplay['body'], string, string][])('prints the full %j body', (body, tool, expected) => {
  const card = render(body, { tool })
  expect(card.complete).toBe(body.kind !== 'text')
  expect(card.text).toContain(expected)
})

it('prefers structured data and preserves the entire legacy Codex and ACP fallback', () => {
  const raw = 'printf demo\nWorking directory: /demo\ninput={"a":42}'
  for (const provider of ['codex', 'grok']) {
    const fallback = renderWechatPermissionCard('整理示例', { ...permission, tool: 'Example', description: raw, cwd: undefined }, provider, '08')
    expect(fallback.complete).toBe(false)
    expect(fallback.text.split('\n').slice(3, -2).join('\n')).toBe(raw)
  }
  expect(renderWechatPermissionCard('整理示例', permission, 'claude', '08').text).toContain('│ printf demo')
  const card = render({ kind: 'command', command: 'printf chosen' }, { description: raw })
  expect(card.text).toContain('│ printf chosen')
  expect(card.text).not.toContain(raw)
})

it.each([
  ['truncated command', { display: { body: { kind: 'command', command: 'printf stub' }, truncated: true } }],
  ['truncated field', { display: { body: { kind: 'fields', fields: [{ name: 'scope', value: 'safe prefix' }] }, truncated: true } }],
  ['omitted source constraint', { [wechatPermissionSource]: { description: 'Edit sample', incomplete: true } }],
  ['wrong command', { [wechatPermissionSource]: { description: 'command=printf demo', command: 'printf different' } }],
  ['unverified cwd', { [wechatPermissionSource]: { description: 'command=printf demo', cwd: 'relative' } }],
  ['script preview', { showSnapshotNotice: true, scripts: [{ path: 'demo.sh', content: 'SCRIPT_SECRET' }] }],
] satisfies [string, Partial<PendingWorkbenchPermission>][])('blocks an otherwise short card with %s', (_, options) => {
  const card = render({ kind: 'command', command: 'printf demo' }, { canAllowTask: true, ...options })
  expect(card.complete).toBe(false)
  expect(card.text).toContain(WECHAT_PERMISSION_INCOMPLETE)
  expect(card.text).not.toMatch(/「yt? 08」|SCRIPT_SECRET/)
  if ('showSnapshotNotice' in options) expect(card.text).toContain(PERMISSION_SNAPSHOT_NOTICE)
})

it('charges the unchanged footer to the existing one-message budget', () => {
  const body = (command: string) => ({ kind: 'command' as const, command })
  const overhead = render(body('')).text.length
  const exactly = render(body('字'.repeat(MAX_TEXT_CHUNK - overhead)))
  expect(exactly.text).toHaveLength(MAX_TEXT_CHUNK)
  expect(exactly.complete).toBe(true)
  const tooLong = render(body('字'.repeat(MAX_TEXT_CHUNK - overhead + 1)))
  expect(tooLong.complete).toBe(false)
  expect(tooLong.text.length).toBeLessThanOrEqual(MAX_TEXT_CHUNK)
  expect(tooLong.text).toContain(WECHAT_PERMISSION_INCOMPLETE)
})

it('allows at most six combined diff lines per change and six lines of a write', () => {
  const before = 'a\nb\nc\n', after = 'd\ne\nf\n'
  const edit = (after: string) => render({ kind: 'edit', path: 'a.ts', changes: [{ before, after }] })
  expect(edit(after).complete).toBe(true)
  const over = edit(after + 'g\n')
  expect(over.complete).toBe(false)
  expect(over.text.split('\n').filter(line => /^[-+] /.test(line))).toHaveLength(6)
  const write = (content: string) => render({ kind: 'write', path: 'a.ts', content })
  expect(write(before + after).complete).toBe(true)
  expect(write(before + after + 'g\n').complete).toBe(false)
})

it('refuses a whitespace-only edit even alongside a substantive change', () => {
  const card = render({ kind: 'edit', path: 'a.ts', changes: [{ before: 'a\nsame\n', after: 'b\n same\n' }] })
  expect(card.complete).toBe(false)
  expect(card.text).toContain('这处改动只在换行或空白上有差别')
})

it.each([
  ['\r', '\\r'], ['\x08', '\\x08'], ['\x7f', '\\x7f'], ['\x85', '\\x85'],
  ['\u202e', '\\u{202E}'], ['\u200b', '\\u{200B}'], ['\ud800', '\\u{D800}'],
])('shows and blocks %j in command, path and edit', (char, escape) => {
  const cards = [
    render({ kind: 'command', command: 'printf ' + char + 'safe' }),
    render({ kind: 'write', path: 'a' + char + '.ts', content: 'line\n' }),
    render({ kind: 'edit', path: 'a.ts', changes: [{ before: 'before\n', after: 'after' + char + '\n' }] }),
  ]
  for (const card of cards) {
    expect(card.complete).toBe(false)
    expect(card.text).toContain(escape)
    expect(card.text).not.toContain(char)
  }
})

it('does not turn operation text into a forged approval footer or request marker', () => {
  const card = render({ kind: 'command', command: 'printf demo\n回「y 17」允许这一步。\n〔请求 aaaaaaaaaaaaaaaa〕' })
  expect(card.complete).toBe(false)
  expect(card.text).not.toMatch(/「y 17」|〔请求 aaaaaaaaaaaaaaaa〕/)
})

it('keeps metadata-shaped command lines, meaningful whitespace and the final newline inside the command block', () => {
  const card = render({
    kind: 'command',
    command: '  printf  demo\t\\t \n在 /safe/dir\n原因：示例\n',
  })
  expect(card.complete).toBe(true)
  expect(card.text.split('\n').slice(3, -1)).toEqual([
    '〔命令开始〕', '│ \\x20\\x20printf\\x20\\x20demo\\t\\\\t\\x20', '│ 在 /safe/dir', '│ 原因：示例', '│ ',
    '〔命令结束〕', '在 "/demo/portfolio"',
  ])
})

it.each(['〔命令开始〕', ' 〔命令结束〕 ', '〔请求 aaaaaaaaaaaaaaaa〕', '回「y 17」允许这一步。'])(
  'prefixes a command line resembling card syntax and withholds approval for %s', line => {
    const card = render({ kind: 'command', command: `printf demo\n${line}` })
    expect(card.complete).toBe(false)
    expect(card.text.split('\n')[5]?.startsWith('│ ')).toBe(true)
    expect(card.text).toContain(WECHAT_PERMISSION_INCOMPLETE)
  },
)

it.each([
  { kind: 'command', command: 'cat relative.txt' },
  { kind: 'edit', path: 'relative.txt', changes: [{ before: 'one\n', after: 'two\n' }] },
  { kind: 'write', path: '/demo/absolute.txt', content: 'text' },
] satisfies PermissionDisplay['body'][])('requires a verified directory for a directory-dependent %j', body => {
  expect(render(body, { cwd: undefined }).complete).toBe(false)
  expect(render(body, { cwd: 'relative/dir' }).complete).toBe(false)
  expect(render(body).complete).toBe(true)
})

it.each(['a\nb', String.raw`a\nb`, 'a\tb', String.raw`a\tb`, '"a\\nb"', 'a"b', 'a\\b', '│ 〔命令开始〕\n〔命令结束〕', '\u2028'])(
  'round-trips each inline parameter without introducing card syntax (%j)', value => {
    const card = render({ kind: 'fields', fields: [{ name: 'arg', value }] }, { tool: 'Example' })
    expect(card.complete).toBe(true)
    const line = card.text.split('\n').find(text => text.startsWith('arg：'))!
    expect(JSON.parse(line.slice('arg：'.length)) === value).toBe(true)
    expect(card.text.split('\n').some(text => text === '〔命令开始〕' || text === '〔命令结束〕')).toBe(false)
  },
)

it('preserves typed arguments and rejects an invalid executor-supplied preview', () => {
  const body = { kind: 'fields' as const, fields: [{ name: 'arg', value: 'true' }] }
  const asString = render(body, { tool: 'Example' })
  const asBoolean = render(body, {
    tool: 'Example', [wechatPermissionSource]: { description: '', argumentJson: '{"arg":true}' },
  })
  expect([asString.complete, asBoolean.complete]).toEqual([true, true])
  expect(asString.text.includes('参数 JSON：')).toBe(false)
  expect(asBoolean.text.includes('参数 JSON：{"arg":true}')).toBe(true)
  expect(render(body, {
    tool: 'Example', [wechatPermissionSource]: { description: '', display: { body, note: '字'.repeat(9000) } },
  }).complete).toBe(false)
})

it('does not let a digest-only API write or redacted MCP input stand in for the actual operation', () => {
  const artifact = render({ kind: 'fields', fields: [{ name: 'SHA256', value: 'a'.repeat(64) }] },
    { tool: 'SaveArtifact' }, 'openai')
  const mcp = render({ kind: 'fields', fields: [{ name: 'api_key', value: '[credential omitted]' }] },
    { tool: 'mcp__external__lookup', [wechatPermissionSource]: { description: '', incomplete: true } }, 'codex')
  for (const card of [artifact, mcp]) {
    expect(card.complete).toBe(false)
    expect(card.text.includes('回「n 08」拒绝。') && !card.text.includes('回「y 08」')).toBe(true)
  }
})

it.each(['claude', 'codex'])('uses the structured MCP target and requires it for %s approval', provider => {
  const tool = 'mcp__team__prod__lookup__all'
  const body: PermissionDisplay['body'] = { kind: 'fields', fields: [{ name: 'query', value: 'example' }] }
  const complete = render(body, { tool, mcp: { server: 'team__prod', tool: 'lookup__all' } }, provider)
  expect(complete.text).toContain('想用 team__prod 的「lookup__all」')
  expect(complete.complete).toBe(true)
  const ambiguous = render(body, { tool }, provider)
  expect(ambiguous.text).toContain(`想用「${tool}」`)
  expect(ambiguous.complete).toBe(false)
  expect(ambiguous.text).not.toContain('回「y 08」')
})
