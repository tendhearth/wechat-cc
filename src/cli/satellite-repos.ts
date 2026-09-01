/**
 * satellite-repos — "隔壁仓库有没有忘了推的提交".
 *
 * WHY (2026-08-31, 真实事故):`plugins/*` 是被 gitignore 的符号链接,指向
 * 工作区里另外的独立仓库。你在主仓库里干活,`git status` 干净、`git push`
 * 顺畅 —— 主仓库【永远不会】告诉你隔壁那个仓库还有未推的提交。wxvault
 * 因此分叉了六周:一条一行的本地提交没推出去,协作者从它之前的那个点继续
 * 往前做,两边各自长出一段,谁都不完整。工作区里现在有四个仓库,只有一个
 * 会出现在日常视野里。
 *
 * 刻意【不 fetch】:doctor 必须快且能离线跑,网络调用会让它挂在别人的
 * 网络问题上。因此这里只和【本地已知的远端指针】比 —— 它抓的是"我提了
 * 没推"(就是上面那个事故),抓不到"别人推了我还没 fetch"。这个取舍是
 * 有意的:前者只有你自己能发现,后者下次 fetch 自然就看见了。
 */

export interface SatelliteRepo {
  /** plugins/ 下的条目名,用来在提示里指认是哪个插件带出来的仓库。 */
  name: string
  /** 仓库根(去重键)。 */
  path: string
  branch: string
  ahead: number
}

export interface SatelliteScanDeps {
  pluginsDir: string
  readdir: (dir: string) => string[]
  /** 解析符号链接;解析不了返回 null。 */
  realpath: (p: string) => string | null
  /** 跑一条 git 命令,返回 trim 过的 stdout;非零退出/出错返回 null。 */
  git: (cwd: string, args: string[]) => string | null
}

/**
 * 扫 `plugins/*` 指向的那些仓库,返回【有未推提交】的那些。
 *
 * 按仓库根去重:plugins/ 下好几个符号链接常常指向同一个仓库的不同子目录
 * (wxfacts/wxgraph/wxmedia/wxperson/wxsearch 全在 wechat-cc-plugins 里),
 * 不去重的话同一个仓库要报五遍。
 *
 * 全程吞异常:doctor 的任何一项都不该因为一个坏符号链接或者 git 不在
 * PATH 就整体失败。
 */
export function scanSatelliteRepos(deps: SatelliteScanDeps): SatelliteRepo[] {
  let entries: string[]
  try { entries = deps.readdir(deps.pluginsDir) } catch { return [] }

  const seen = new Set<string>()
  const out: SatelliteRepo[] = []
  for (const name of entries) {
    try {
      const target = deps.realpath(`${deps.pluginsDir}/${name}`)
      if (!target) continue
      const root = deps.git(target, ['rev-parse', '--show-toplevel'])
      if (!root || seen.has(root)) continue
      seen.add(root)
      const branch = deps.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!branch) continue
      // 没配 upstream 时这条会失败 → 跳过。无从判断"推没推",报出来只是噪音。
      const ahead = deps.git(root, ['rev-list', '--count', '@{upstream}..HEAD'])
      if (ahead === null) continue
      const n = Number(ahead)
      if (!Number.isFinite(n) || n <= 0) continue
      out.push({ name, path: root, branch, ahead: n })
    } catch { continue }   // 一个坏条目不影响其它条目
  }
  return out
}
