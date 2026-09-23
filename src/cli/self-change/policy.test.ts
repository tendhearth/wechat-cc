import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import { FORBIDDEN_EXCEPTIONS, FORBIDDEN_GLOBS, SELF_CHANGE_DEFAULTS, defaultWorkdir, forbiddenPaths } from './policy'

describe('forbiddenPaths', () => {
  it('只挑出禁改文件,别的原样放行', () => {
    expect(forbiddenPaths(['src/cli/self-change/policy.ts', 'src/x.ts'])).toEqual(['src/cli/self-change/policy.ts'])
  })

  it('scripts/publish-update*.ts 通配到带后缀的发版脚本', () => {
    expect(forbiddenPaths(['scripts/publish-update.platforms.ts'])).toEqual(['scripts/publish-update.platforms.ts'])
    expect(forbiddenPaths(['scripts/publish-update.ts'])).toEqual(['scripts/publish-update.ts'])
  })

  it('文档不命中', () => {
    expect(forbiddenPaths(['docs/x.md'])).toEqual([])
  })

  it('通配的 * 不跨目录(scripts/foo/publish-update.ts 不算)', () => {
    expect(forbiddenPaths(['scripts/foo/publish-update.ts'])).toEqual([])
  })

  it('回滚配方与发版工作流都在清单里', () => {
    expect(FORBIDDEN_GLOBS).toContain('src/cli/self-deploy.ts')
    expect(FORBIDDEN_GLOBS).toContain('src/cli/self-change/policy.ts')
    expect(forbiddenPaths([
      '.github/workflows/publish-update.yml',
      '.github/workflows/mirror-desktop-tag.yml',
      '.github/workflows/desktop.yml',
      'scripts/update-hosting.json',
      'apps/desktop/src-tauri/tauri.conf.json',
      'src/cli/self-deploy.ts',
    ])).toHaveLength(6)
  })

  // 按确切路径列工作流,新加一个 publish-update-2.yml 就在网外面 —— 所以是整个目录。
  it('整个 .github/workflows 都在网里(新加的工作流不用再补清单)', () => {
    expect(forbiddenPaths([
      '.github/workflows/publish-update.yml',
      '.github/workflows/publish-update-2.yml',
      '.github/workflows/desktop.yml',
      '.github/workflows/nested/x.yml',
    ])).toHaveLength(4)
  })

  // tests 那道闸门跑的就是 package.json scripts 里的四条 —— 改得动它等于
  // 能把闸门换成橡皮图章。
  it('package.json 在网里(它是 tests 闸门自己的定义)', () => {
    expect(forbiddenPaths(['package.json'])).toEqual(['package.json'])
    // 只认仓库根那一份:子包的 package.json 不在发版 / 闸门链路上。
    expect(forbiddenPaths(['apps/desktop/package.json'])).toEqual([])
  })

  it('ci.yml 是白名单里挖掉的那个洞(自改要改得了自己的测试矩阵)', () => {
    expect(FORBIDDEN_EXCEPTIONS).toEqual(['.github/workflows/ci.yml'])
    expect(forbiddenPaths(['.github/workflows/ci.yml'])).toEqual([])
    expect(forbiddenPaths(['./.github/workflows/ci.yml'])).toEqual([])
    // 例外是**确切路径**:蹭名字的不算。
    expect(forbiddenPaths(['.github/workflows/ci.yml.bak'])).toEqual(['.github/workflows/ci.yml.bak'])
    expect(forbiddenPaths(['.github/workflows/ci2.yml'])).toEqual(['.github/workflows/ci2.yml'])
  })

  it('不受 ./ 前缀与反斜杠影响(Windows 上的 git 输出)', () => {
    expect(forbiddenPaths(['./src/cli/self-deploy.ts'])).toEqual(['./src/cli/self-deploy.ts'])
    expect(forbiddenPaths(['src\\cli\\self-deploy.ts'])).toEqual(['src\\cli\\self-deploy.ts'])
  })
})

describe('SELF_CHANGE_DEFAULTS', () => {
  it('是 spec 里那一组值', () => {
    expect(SELF_CHANGE_DEFAULTS).toEqual({
      branch: 'dev',
      implement_budget_usd: 20,
      review_budget_usd: 5,
      max_turns: 300,
      max_per_day: 5,
      approval_timeout_h: 24,
      selftest_executor: 'claude',
      selftest_provider: 'claude',
      max_fix_rounds: 2,
      tests_timeout_ms: 20 * 60_000,
      halt_after_fail_streak: 2,
    })
  })
})

describe('defaultWorkdir', () => {
  it('darwin 放 ~/Library/Caches', () => {
    expect(defaultWorkdir('/Users/a', 'darwin')).toBe(join('/Users/a', 'Library', 'Caches', 'wechat-cc', 'self-change'))
  })

  it('其他平台放 ~/.cache', () => {
    expect(defaultWorkdir('/home/a', 'linux')).toBe(join('/home/a', '.cache', 'wechat-cc', 'self-change'))
    expect(defaultWorkdir('C:\\Users\\a', 'win32')).toBe(join('C:\\Users\\a', '.cache', 'wechat-cc', 'self-change'))
  })

  it('不落在 STATE_DIR 里(执行者在 skip-permissions 下跑,不能离钥匙一个 ..)', () => {
    expect(defaultWorkdir('/Users/a', 'darwin')).not.toContain('.wechat-cc')
  })
})
