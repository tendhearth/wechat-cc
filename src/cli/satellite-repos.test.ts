/**
 * 卫星仓库的未推提交检查。
 *
 * 成因(2026-08-31 真实事故):`plugins/*` 是被 gitignore 的符号链接,指向
 * 工作区里另外的独立仓库。在主仓库里 `git status` 干净、`git push` 顺畅,
 * 【主仓库不会提醒隔壁仓库还有未推的提交】。wxvault 因此分叉六周:一条
 * 一行的本地提交没推,协作者从它之前的点继续往前做。
 *
 * 关键细节:plugins/ 下多个符号链接常常指向【同一个仓库】的不同子目录
 * (wxfacts/wxgraph/wxmedia/wxperson/wxsearch 全在 wechat-cc-plugins 里),
 * 所以必须按仓库根去重,否则同一个仓库要报五遍。
 */
import { describe, it, expect } from 'vitest'
import { scanSatelliteRepos, type SatelliteScanDeps } from './satellite-repos'

function deps(over: Partial<SatelliteScanDeps> = {}): SatelliteScanDeps {
  return {
    pluginsDir: '/repo/plugins',
    readdir: () => ['wxvault'],
    realpath: (p: string) => p.replace('/repo/plugins', '/ws'),
    git: (cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
      if (args[0] === 'rev-list') return '0'
      return null
    },
    ...over,
  }
}

describe('scanSatelliteRepos', () => {
  it('有未推提交的仓库被报出来,带分支名和条数', () => {
    const out = scanSatelliteRepos(deps({
      git: (cwd, args) => {
        if (args[1] === '--show-toplevel') return '/ws/wxvault'
        if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
        if (args[0] === 'rev-list') return '1'
        return null
      },
    }))
    expect(out).toEqual([{ name: 'wxvault', path: '/ws/wxvault', branch: 'main', ahead: 1 }])
  })

  it('已同步的仓库不出现(零噪音)', () => {
    expect(scanSatelliteRepos(deps())).toEqual([])
  })

  it('多个符号链接指向同一个仓库 → 只报一次(按仓库根去重)', () => {
    const out = scanSatelliteRepos(deps({
      readdir: () => ['wxfacts', 'wxgraph', 'wxsearch'],
      git: (_cwd, args) => {
        if (args[1] === '--show-toplevel') return '/ws/wechat-cc-plugins'   // 三个都在同一个仓库里
        if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
        if (args[0] === 'rev-list') return '2'
        return null
      },
    }))
    expect(out).toHaveLength(1)
    expect(out[0]!.path).toBe('/ws/wechat-cc-plugins')
  })

  it('不是 git 仓库 / git 调用失败 → 静默跳过,绝不抛', () => {
    expect(scanSatelliteRepos(deps({ git: () => null }))).toEqual([])
    expect(scanSatelliteRepos(deps({ git: () => { throw new Error('git 不在 PATH') } }))).toEqual([])
    expect(scanSatelliteRepos(deps({ readdir: () => { throw new Error('没有 plugins 目录') } }))).toEqual([])
  })

  it('没有配 upstream 的仓库跳过 —— 无从判断"推没推",报了只是噪音', () => {
    const out = scanSatelliteRepos(deps({
      git: (_cwd, args) => {
        if (args[1] === '--show-toplevel') return '/ws/scratch'
        if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
        if (args[0] === 'rev-list') return null   // @{upstream} 解析失败
        return null
      },
    }))
    expect(out).toEqual([])
  })

  it('符号链接解析不了 → 跳过该项,不影响其它项', () => {
    const out = scanSatelliteRepos(deps({
      readdir: () => ['broken', 'wxvault'],
      realpath: (p: string) => p.endsWith('broken') ? null : '/ws/wxvault',
      git: (_cwd, args) => {
        if (args[1] === '--show-toplevel') return '/ws/wxvault'
        if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
        if (args[0] === 'rev-list') return '3'
        return null
      },
    }))
    expect(out).toEqual([{ name: 'wxvault', path: '/ws/wxvault', branch: 'main', ahead: 3 }])
  })
})
