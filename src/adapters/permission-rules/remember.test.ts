import { describe, expect, it } from 'vitest'
import { rememberCommandPrefix } from './remember'
import { matchRule, parseRulesFile, serializeRulesFile } from './rules-file'
import { parseRulesFile as oldParseRulesFile } from './__fixtures__/rules-file-origin-dev'

import type { PermissionAsk, Rule } from '../../domain/permission-rules/types'

describe('literal approval prefixes', () => {
  it.each([
    ['bun test', 'bun test'],
    ['bun test src/foo.test.ts', 'bun test'],
    ['bun  test ./src/foo.test.ts src/bar.test.ts', 'bun test'],
    ['git status', 'git status'],
    ['ls', null],
    ['ls -l src', null],
    ['ls src/foo', null],
    ['pwd', 'pwd'],
    ['bun test | head', null],
    ['bun test && ls', null],
    ['bun test > result', null],
    ['bun test $(ls)', null],
    ['bun test `ls`', null],
    ['bun test;ls', null],
    ['bun test\nls', null],
    ['bun test\n', null],
    ['bun test\tsrc', null],
    ['bun test src/*.ts', null],
    ['bun test "../src"', null],
    ['bun test ../src', null],
    ['bun test /tmp/suite', null],
    ['bun test --preload script.ts', null],
    ['bun test x --preload y', null],
    ['bun test-other src', null],
    ['bun run test', null],
    ['./bun test', null],
    ['env bun test', null],
    ['sudo ls', null],
    ['rm -rf temp', null],
    ['git push --force', null],
    ['curl http://localhost', null],
    ['curl https://example.com', null],
    ['ls src -l', null],
    ['git status --porcelain', null],
    ['bun test ' + 'a'.repeat(1991), null],
  ] as const)('%j → %j', (command, prefix) => {
    expect(rememberCommandPrefix(command)).toBe(prefix)
  })

  it('round trips the exact project and applies the same grammar at match time', () => {
    const project = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
    const rule: Rule = { id: 'card-test', when: { projectExact: project, tool: 'Bash', commandPrefix: 'bun test' }, then: 'allow' }
    const { file, errors } = parseRulesFile(serializeRulesFile({ version: 1, enabled: true, review: 'off', rules: [rule] }))
    const ask: PermissionAsk = { project, cwd: project, surface: 'terminal', tool: 'Bash', provider: 'claude', tier: 'admin', scope: 's', isolatedWorktree: false, command: 'bun test src/b.test.ts' }
    expect(errors).toEqual([])
    expect(matchRule(file.rules, ask)).toEqual(rule)
    for (const changed of [{project: project + '/nested'}, { tool: 'shell' }, { surface: 'chat' }, { tier: 'trusted' }, { command: 'bun test --preload x' }] as const)
      expect(matchRule(file.rules, { ...ask, ...changed })).toBeNull()
  })
})

it('the origin/dev daemon and CLI reject serialized card rules', () => {
  const project = '/work/app'
  const rules: Rule[] = [
    { id: 'card-command', when: { projectExact: project, tool: 'Bash', commandPrefix: 'bun test' }, then: 'allow' },
    { id: 'card-file', when: { projectExact: project, tool: 'Write', pathExact: project + '/README.md' }, then: 'allow' },
  ]
  const raw = serializeRulesFile({ version: 1, enabled: true, review: 'off', rules })
  expect(parseRulesFile(raw).file.rules).toEqual(rules)
  const old = oldParseRulesFile(raw)
  expect(old.file.rules).toEqual([]) // No allow can match, even outside the original project.
  expect(old.errors).toHaveLength(2) // Old CLI refuses to rewrite any file with parse errors.
})

it('never matches a previously saved ls rule, including a relative directory operand', () => {
  const project = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
  const ask: PermissionAsk = { project, cwd: project, surface: 'terminal', tool: 'Bash', provider: 'claude',
    tier: 'admin', scope: 's', isolatedWorktree: false, command: 'ls linked-dir' }
  const rule: Rule = { id: 'card-ls', when: { projectExact: project, tool: 'Bash', commandPrefix: 'ls' }, then: 'allow' }
  expect(matchRule([rule], ask)).toBeNull()
})
