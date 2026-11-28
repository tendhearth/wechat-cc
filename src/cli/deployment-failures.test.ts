import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { deploymentFailures, matchesFailedTree } from './deployment-failures'
import { makeGit, nodeGitSpawnSync } from './self-change/git'

it('matches failed trees and Markdown-only variants from distinct clones, while changed code can ship', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-failed-tree-'))
  function repo(name: string) {
    const path = join(root, name)
    mkdirSync(path)
    const git = makeGit(nodeGitSpawnSync, path)
    function run(args: string[]) {
      const result = git.run(args)
      if (result.code !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    run(['init', '-q'])
    return {
      git,
      commit(code: string, docs: string, message: string) {
        writeFileSync(join(path, 'feature.ts'), code)
        writeFileSync(join(path, 'quoted-é.md'), docs)
        run(['add', '.'])
        run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message])
        return run(['rev-parse', 'HEAD'])
      },
    }
  }
  try {
    const a = repo('manual')
    const b = repo('automatic')
    const failed = a.commit('broken()', 'before', 'manual ship')
    const same = b.commit('broken()', 'before', 'CI covered another SHA')
    const markdown = b.commit('broken()', 'after', 'docs only')
    const fixed = b.commit('fixed()', 'after', 'fix the code')
    deploymentFailures(root).add(a.git, failed, 'selftest')
    const records = deploymentFailures(root).load()
    expect(records).toMatchObject([{ sha: failed, tree: expect.any(String), stage: 'selftest' }])
    expect(b.git.run(['cat-file', '-e', failed]).code).not.toBe(0)
    expect(matchesFailedTree(b.git, same, records)).toBe(true)
    expect(matchesFailedTree(b.git, markdown, records)).toBe(true)
    expect(matchesFailedTree(b.git, fixed, records)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
