import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeIlinkAdapter } from '../../daemon/ilink-glue'
import type { PermissionDisplay } from '@wechat-cc/protocol'
import { WORKBENCH_PERMISSION_TIMEOUT_MS } from '../../adapters/workbench/permissions'
import { formatWorkbenchPermission, makeWorkbenchPermissionPrompt, REQUEST_MAX } from './permission-prompt'

it('strict WeChat reason replies consume only a capable owner card; ordinary chat stays ordinary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-reason-format-')),db=openTestDb()
  const ilink=makeIlinkAdapter({stateDir:root,db,conversationStore:makeConversationStore(db),accounts:[]})
  const prompt=makeWorkbenchPermissionPrompt(ilink,()=> 'owner'),answer=vi.fn(()=>true)
  const closers:Array<()=>void>=[]
  try{
    for(let i=1;i<=10;i++)closers.push(prompt('task',{id:randomUUID(),taskId:'task',tool:'Bash',description:'x',createdAt:Date.now(),canDenyWithReason:i===10},answer,()=>Date.now()+10000))
    expect(ilink.handlePermissionReply('不行 10 分钟后再说','owner')).toBe(false)
    expect(ilink.listPendingPermissions()).toHaveLength(10)
    expect(ilink.handlePermissionReply('n 01 不要 SSH','owner')).toBe(false)
    expect(ilink.listPendingPermissions()).toHaveLength(10)
    expect(ilink.handlePermissionReply('n 10 不要 SSH','stranger')).toBe(false)
    expect(answer).not.toHaveBeenCalled()
    expect(ilink.handlePermissionReply('n 10 不要 SSH','owner')).toBe(true)
    expect(answer).toHaveBeenCalledExactlyOnceWith('deny','不要 SSH')
    expect(ilink.listPendingPermissions()).toHaveLength(9)
  }finally{for(const close of closers)close();await ilink.flush();db.close();rmSync(root,{recursive:true,force:true})}
})

it.each(['wechat', 'pet'] as const)('R2: %s waits for the server decision before acknowledging or consuming the card', async surface => {
  const root = mkdtempSync(join(tmpdir(), 'cc-permission-ack-')), db = openTestDb()
  const ilink = makeIlinkAdapter({ stateDir: root, db, conversationStore: makeConversationStore(db), accounts: [] })
  const prompt = makeWorkbenchPermissionPrompt(ilink, () => 'owner'), closes: Array<() => void> = []
  try {
    for (const accepted of [false, true]) {
      const id = randomUUID(), during: number[] = []
      const answer = vi.fn(() => { during.push(ilink.listPendingPermissions().filter(p => p.hash === id).length); return accepted })
      closes.push(prompt('task', { id, taskId: 'task', tool: 'Bash', description: 'python3 check.py', createdAt: Date.now() }, answer, () => Date.now() + 10_000))
      const reply = surface === 'wechat' ? ilink.handlePermissionReply(`y ${ilink.pendingPermissionCodeOf(id)}`, 'owner') : ilink.resolvePermission(id, 'allow')
      expect(reply).toBe(accepted)
      expect(answer).toHaveBeenCalledExactlyOnceWith('allow')
      expect(during).toEqual([1])
      expect(ilink.listPendingPermissions().some(p => p.hash === id)).toBe(!accepted)
      if (accepted) expect(ilink.resolvePermission(id, 'allow')).toBe(false)
    }
  } finally { for (const close of closes) close(); await ilink.flush(); db.close(); rmSync(root, { recursive: true, force: true }) }
})

const syntheticContext = { executor: 'claude', actor: 'Claude', projectPath: '/demo' }
const synthetic = { id: 'p', taskId: 'task', tool: 'Bash', description: 'legacy', createdAt: 1, cwd: '/demo' }
const title = '整理样例'
const format = (body: PermissionDisplay['body'], tool = 'Bash', extra?: PermissionDisplay['extra']) =>
  formatWorkbenchPermission(title, { ...synthetic, tool, display: { body, extra } }, syntheticContext)

it('formats a command and the verified directory with normalized line breaks', () => {
  expect(format({ kind: 'command', command: 'npm install sharp\r\nnpm test' })).toBe(
    '整理样例 · task\nClaude 想运行一条命令：\n$ npm install sharp\nnpm test\n在 /demo',
  )
})

it('shows at most six signed lines in each edit with a per-change remainder', () => {
  const message = format({ kind: 'edit', path: '/demo/src/a.ts', changes: [
    { before: 'a\rb\rc\rd', after: 'e\r\nf\r\ng' }, { before: 'old', after: 'new' },
  ] }, 'MultiEdit')
  expect(message).toBe('整理样例 · task\nClaude 想改 src/a.ts（2 处）：\n- a\n- b\n- c\n- d\n+ e\n+ f\n…（还有 1 行，到电脑或手机上看全部）\n- old\n+ new\n在 /demo')
})

it('describes each patch file without its diff and formats a write', () => {
  const patch = format({ kind: 'patch', files: [
    { path: '/demo/a', change: 'add', diff: '+omitted' },
    { path: '/demo/b', change: 'update', diff: '+omitted' },
    { path: '/demo/c', change: 'delete', diff: '-omitted' },
    { path: '/demo/d', change: 'update', movePath: '/demo/e', diff: '+omitted' },
  ] }, 'apply_patch')
  expect(patch).toBe('整理样例 · task\nClaude 想改 4 个文件：\na（新建）\nb（修改）\nc（删除）\nd（改名 → e）\n在 /demo')
  expect(format({ kind: 'write', path: '/demo/a', content: 'a\r\nb' }, 'Write')).toBe('整理样例 · task\nClaude 想写 a：\n+ a\n+ b\n在 /demo')
})

it.each([
  [{ kind: 'url', url: 'https://example.test/page', prompt: '标题' }, 'WebFetch', '想打开一个网址：\nhttps://example.test/page\n标题'],
  [{ kind: 'query', query: '周末天气' }, 'WebSearch', '想上网搜一下：\n“周末天气”'],
  [{ kind: 'fields', fields: [{ name: 'limit', value: '10' }] }, 'mcp__catalog__list', '想用 catalog 的「list」：\nlimit：10'],
  [{ kind: 'text', text: 'opaque\r\ntext' }, 'Other', '想用「Other」：\nopaque\ntext'],
] satisfies Array<[PermissionDisplay['body'], string, string]>)('formats %j as WeChat text', (body, tool, expected) => {
  expect(format(body, tool, [{ name: 'mode', value: 'read' }])).toBe(`整理样例 · task\nClaude ${expected}\nmode：read\n在 /demo`)
})

it('falls back to the known source format, keeps opaque Codex text, and caps the total', () => {
  const description = 'command=npm test'
  const invalid = { ...synthetic, description, display: { body: { kind: 'command', command: 1 } } as unknown as PermissionDisplay }
  expect(formatWorkbenchPermission(title, invalid, syntheticContext)).toContain('\n$ npm test\n')
  expect(formatWorkbenchPermission(title, { ...synthetic, description }, syntheticContext)).toContain('\n$ npm test\n')
  expect(formatWorkbenchPermission(title, invalid, { executor: 'codex', actor: 'Codex' })).toContain('\ncommand=npm test\n')
  const bare = format({ kind: 'text', text: '' })!
  expect(format({ kind: 'text', text: 'x'.repeat(REQUEST_MAX - bare.length) })?.length).toBe(REQUEST_MAX)
  expect(format({ kind: 'text', text: 'x'.repeat(REQUEST_MAX - bare.length + 1) })).toBeUndefined()
  expect(format({ kind: 'fields', fields: [{ name: 'a', value: 'x'.repeat(REQUEST_MAX) }] })).toBeUndefined()
})

it('uses the long-content notice and keeps the exact code reply line and deadline', () => {
  const registry = { registerPendingPermission: vi.fn(async () => 'deny' as const), resolvePermission: vi.fn(() => true), pendingPermissionCodeOf: vi.fn(() => '07') }
  const answer = vi.fn(() => true), deadline = () => 123
  const close = makeWorkbenchPermissionPrompt(registry, () => 'owner')(title, {
    ...synthetic, description: 'x'.repeat(REQUEST_MAX + 1), canAllowTask: true, canDenyWithReason: true,
  }, answer, deadline, syntheticContext)
  expect(registry.registerPendingPermission).toHaveBeenCalledWith(synthetic.id, WORKBENCH_PERMISSION_TIMEOUT_MS,
    expect.objectContaining({ prompt: '整理样例 · task\n权限内容较长，请在桌面工作台完整查看。' }), expect.objectContaining({ deadline }))
  expect(close.replyLine).toBe('回「y 07」允许这一步、「n 07」拒绝。拒绝理由选填：「n 07 理由」。回「yt 07」本任务同命令都允许，任务结束失效。')
  close()
})
