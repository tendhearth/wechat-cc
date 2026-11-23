import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { permissionDisplay } from '@wechat-cc/protocol'
import { summarizeToolInput } from '../../cli/hook'
import { acpPermissionDescription } from './acp/events'
import { claudeMcpPermissionDescription, claudeTaskPermissionDescription } from './claude/claude-agent-provider'
import { codexPermissionDescription } from './codex/codex-app-server'
import { codexMcpApproval } from './codex/codex-mcp-approval'
import { prepareApiFileTool } from './openai/api-files'

function exact<T>(actual: T, expected: T) {
  expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true)
}

const command = 'printf "示例"\r\nprintf "\\n"'
const path = 'C:\\Sample\\src\\gallery.ts'
const before = 'const a = "中文"\r\n\\n'
const after = 'const a = "完毕"\n\\n'
const edit = { file_path: path, old_string: before, new_string: after }

describe('permission display uses the executor descriptions', () => {
  it('reads the Claude task command, contextual edit and native MCP keys', () => {
    const shell = claudeTaskPermissionDescription('Bash', { command }, { title: '  Preview the gallery  ' })
    exact(shell, 'Preview the gallery\ncommand=' + command)
    exact(permissionDisplay('Bash', shell!), { body: { kind: 'command', command }, note: 'Preview the gallery' })

    const change = claudeTaskPermissionDescription('Edit', edit, { decisionReason: 'Review text' })
    exact(change, 'Review text\ninput=' + JSON.stringify(edit))
    exact(permissionDisplay('Edit', change!), { body: { kind: 'edit', path, changes: [{ before, after }] }, note: 'Review text' })
    const tool = 'mcp__sample__lookup'
    const raw = claudeMcpPermissionDescription(tool, { q: before })
    exact(raw, tool + '\n' + JSON.stringify({ q: before }))
    exact(permissionDisplay(tool, raw!).body, { kind: 'fields', fields: [{ name: 'q', value: before }] })
  })

  it('reads Codex command, working directory, reason and authority scope', () => {
    const cwd = 'C:\\Sample'
    const params = { command, cwd, reason: 'Preview only', additionalPermissions: { network: { enabled: true } } }
    const { description, scope } = codexPermissionDescription(false, params)
    exact(scope, 'Execution environment: local\nAdditional permissions for this command:\n' + JSON.stringify(params.additionalPermissions, null, 2))
    exact(description, [command, 'Working directory: ' + cwd, params.reason, scope].join('\n'))
    const display = permissionDisplay('commandExecution', description)
    exact(display.body, { kind: 'command', command, cwd })
    exact(display.note, params.reason)
    exact(display.extra?.[0]?.value, scope?.slice('Execution environment: '.length))
  })

  it('reads Codex multi-file patches, trailing line endings, rename destination and reason', () => {
    const items = [
      { path, kind: { type: 'update', move_path: 'C:\\Sample\\src\\renamed.ts' }, diff: '@@ -1 +1 @@\r\n-old\r\n+new\r\n' },
      { path: 'src/b.ts', kind: { type: 'add' }, diff: '+one\n+two\n' },
    ]
    const { description } = codexPermissionDescription(true, { reason: 'Review changes' }, { changes: items })
    const files = items.map(file => ({ path: file.path, change: JSON.stringify(file.kind), diff: file.diff }))
    exact(description, files.map(file => [file.path, file.change, file.diff].join('\n')).join('\n\n') + '\nReview changes\nExecution environment: local')
    const display = permissionDisplay('fileChange', description)
    exact(display.body, { kind: 'patch', files })
    exact(display.note, 'Review changes')
  })

  it('reads the arguments from Codex native MCP invocation approvals', () => {
    const args = { query: after }
    const raw = codexMcpApproval({ serverName: 'sample', mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'lookup', tool_params: args },
    }, [{ id: 'lookup', type: 'mcpToolCall', server: 'sample', tool: 'lookup', arguments: args }], new Set(), new Set(['sample']))
    expect(Boolean(raw)).toBe(true)
    exact(permissionDisplay(raw!.tool, raw!.description).body, { kind: 'fields', fields: [{ name: 'query', value: after }] })
  })

  it('reads a standalone ACP command and keeps unframed command notes and edit locations together', () => {
    const rawInput = { command: 'printf "示例"' }
    const options = [{ kind: 'allow_once', optionId: 'yes' }]
    const simple = acpPermissionDescription({ options, toolCall: { kind: 'execute', rawInput } })
    exact(simple, rawInput.command)
    exact(permissionDisplay('execute', simple!).body, { kind: 'command', command: rawInput.command })
    const title = `\`${rawInput.command}\``
    const allowlistNote = 'Not in allowlist: printf'
    const cursor = acpPermissionDescription({ options, toolCall: { kind: 'execute', title,
      content: [{ type: 'content', content: { type: 'text', text: allowlistNote } }], locations: [{ path }],
    } })
    exact(cursor, [title, allowlistNote, path].join('\n'))
    exact(permissionDisplay('execute', cursor!), { body: { kind: 'command', command: title }, note: allowlistNote, extra: [{ name: 'path', value: path }] })
    const content = [{ type: 'content', content: { type: 'text', text: 'Waiting for review' } }]
    const locations = [{ path }]
    const detailed = acpPermissionDescription({ options, toolCall: { kind: 'execute', rawInput: { command }, content, locations } })
    if (detailed === null) throw Error('expected ACP command description')
    exact(detailed, [command, content[0]!.content.text, path].join('\n'))
    exact(permissionDisplay('execute', detailed).body, { kind: 'text', text: detailed })
    const change = acpPermissionDescription({ options, toolCall: { kind: 'edit', title: 'Edit gallery', content, locations } })
    if (change === null) throw Error('expected ACP edit description')
    exact(change, ['Edit gallery', content[0]!.content.text, path].join('\n'))
    exact(permissionDisplay('edit', change).body, { kind: 'text', text: change })
  })

  it('reads the custom API file descriptions and artifact fingerprint', () => {
    const project = mkdtempSync(join(realpathSync(tmpdir()), 'approval-contract-'))
    try {
      const task = 'abcdef12'
      const read = prepareApiFileTool(project, task, 'ReadFile', { path: 'docs/sample.txt' })
      exact(read.description, 'ReadFile docs/sample.txt')
      exact(permissionDisplay('ReadFile', read.description).body, { kind: 'fields', fields: [{ name: 'path', value: 'docs/sample.txt' }] })
      const write = prepareApiFileTool(project, task, 'SaveArtifact', { name: 'sample.txt', content: '' })
      const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      exact(write.description, `SaveArtifact .cc-workbench/${task}/sample.txt (0 bytes; SHA256 ${digest})`)
      exact(permissionDisplay('SaveArtifact', write.description).body, { kind: 'fields', fields: [
        { name: 'path', value: `.cc-workbench/${task}/sample.txt` }, { name: 'bytes', value: '0' }, { name: 'SHA256', value: digest },
      ] })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('reads hook command and edits, with an exact fallback when the hook truncates JSON', () => {
    exact(permissionDisplay('Bash', summarizeToolInput({ command })).body, { kind: 'command', command })
    exact(permissionDisplay('shell', summarizeToolInput({ command: ['printf', 'demo'] })).body, { kind: 'command', command: 'printf demo' })
    exact(permissionDisplay('Edit', summarizeToolInput(edit)).body, { kind: 'edit', path, changes: [{ before, after }] })
    const truncated = summarizeToolInput({ ...edit, new_string: '长'.repeat(30_000) })
    expect(truncated.endsWith('…')).toBe(true)
    exact(permissionDisplay('Edit', truncated).body, { kind: 'text', text: truncated })
  })
})
