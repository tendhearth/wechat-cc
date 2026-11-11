/**
 * 发版管线的**接缝守卫**。
 *
 * 自动更新要成立,得有三个地方对上同一批字节:
 *   ① desktop.yml 构建时生成 `.sig`
 *   ② desktop.yml 把 `.sig` 拷进要上传到 release 的目录
 *   ③ publish-update.ts 从 release 资产里认出它,写进 latest.json
 *
 * v1.6.6 第一次出包时 ① 和 ③ 都对,② 的文件名白名单漏了 `.sig` —— 结果是
 * 六个安装包齐齐整整、零个签名,而**发布日志里一切正常**。上游 2026-08-31
 * 才刚为同一个问题修过一次,注释就在 35 行之外;修的是另一步。
 *
 * 这些断言不测逻辑,测的是「两份文件里的约定还对得上」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

// import.meta.dir 是 Bun 的扩展,vitest 转译后是 undefined —— 测试跑在
// vitest 上(见 CLAUDE.md 的标准测试命令),所以这里用标准写法。
const HERE = dirname(fileURLToPath(import.meta.url))
const wf = (name: string) => readFileSync(join(HERE, '..', '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')

describe('desktop.yml —— 上传到 release 的产物必须带签名', () => {
  const yml = wf('desktop.yml')
  const flatten = yml.slice(yml.indexOf('Flatten bundles for upload'))
    .split('\n').slice(0, 20).join('\n')

  it('拷贝白名单里有 *.sig(漏了它 → 装机包齐全但无人能自动更新)', () => {
    expect(flatten).toContain("-name '*.sig'")
  })

  it('两种 updater 产物本体也在白名单里', () => {
    expect(flatten).toContain("-name '*.app.tar.gz'")  // macOS
    expect(flatten).toContain("-name '*.exe'")          // Windows NSIS setup
  })
})

describe('desktop.yml —— macOS 画室渲染器的源码克隆要带子模块', () => {
  // 2026-09-27 desktop-v1.7.0 第一次在真 tag 上跑这一步就红:stable-diffusion.cpp 的
  // ggml 是 git submodule,`git clone --depth 1` 不带 --recurse-submodules 时 ggml/ 是
  // 空目录,CMake 在 add_subdirectory(ggml) 处停。这一步 09-03 加进来后一直没被发版
  // 真正跑过(1.6.5 在它之前)。
  const yml = wf('desktop.yml')
  const cloneLine = yml.split('\n').find(l => l.includes('git clone') && l.includes('stable-diffusion.cpp')) ?? ''

  it('克隆 stable-diffusion.cpp 那一行存在', () => {
    expect(cloneLine).not.toBe('')
  })

  it('带 --recurse-submodules(否则 ggml/ 为空,CMake 必红)', () => {
    expect(cloneLine).toContain('--recurse-submodules')
  })
})

describe('desktop.yml —— 没有 Developer ID 时,公证的三个环境变量必须**不存在**,不能是空串', () => {
  // 2026-09-27 desktop-v1.7.0 第二次真跑:sidecar 过了,Tauri build 红在
  // 「failed to notarize app: Team ID must be at least 3 characters」。原因:Tauri build 步骤的
  // env 里写着 APPLE_TEAM_ID: ${{ … || '' }} —— macOS/Linux 上「设成空串」不等于「没设」,
  // tauri-bundler 看到键存在就去公证。(和导图里 Win32「赋空串 = 删除」正好相反。)
  // 正确做法:只在证书 import 成功的那一步把三个变量写进 $GITHUB_ENV,Tauri build 的 env 里不出现它们。
  const yml = wf('desktop.yml')
  const tauriStep = yml.slice(yml.indexOf('- name: Tauri build'), yml.indexOf('- name:', yml.indexOf('- name: Tauri build') + 10))

  it('Tauri build 步骤的 env 里没有 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID', () => {
    for (const k of ['APPLE_ID:', 'APPLE_PASSWORD:', 'APPLE_TEAM_ID:']) {
      expect(tauriStep, `${k} 出现在 Tauri build 的 env 里 —— 空串也会触发公证`).not.toContain(k)
    }
  })

  it('公证变量由证书 import 之后的一步按 DEVELOPER_ID_READY 写进 GITHUB_ENV', () => {
    expect(yml).toMatch(/DEVELOPER_ID_READY == '1'[\s\S]*APPLE_TEAM_ID=[\s\S]*GITHUB_ENV/)
  })
})

describe('desktop.yml —— DMG 外壳必须在上传前单独公证并 staple', () => {
  // .app / updater 公证不覆盖 DMG 外壳;没把 ticket staple 进 DMG,新用户断网首次打开仍会被拦。
  const build = (parse(wf('desktop.yml')) as {
    jobs: { build: { 'continue-on-error'?: boolean; steps: Array<{
      id?: string; name?: string; if?: string; run?: string; shell?: string
      env?: Record<string, string>; 'continue-on-error'?: boolean
    }> } }
  }).jobs.build
  const steps = build.steps
  const index = steps.findIndex(s => s.id === 'notarize-dmg')
  const dmg = steps[index]
  const uploadIndex = steps.findIndex(s => s.name === 'Upload bundle artefacts')
  const script = dmg?.run ?? ''

  it('Tauri 打包之后、上传之前有独立 DMG 公证步骤', () => {
    expect(index).toBeGreaterThan(steps.findIndex(s => s.name === 'Tauri build'))
    expect(index).toBeLessThan(uploadIndex)
    expect(script).toContain('xcrun notarytool submit')
    expect(script).toContain('--wait')
    expect(script).toContain('xcrun stapler staple')
  })

  it('只在 macOS 且三项公证凭据齐全时运行,不在 step if 直接读 secrets 或声明空串公证变量', () => {
    expect(dmg?.if?.split(/\s*&&\s*/)).toEqual([
      "matrix.os == 'macos-latest'",
      "env.APPLE_ID != ''", "env.APPLE_PASSWORD != ''", "env.APPLE_TEAM_ID != ''",
    ])
    expect(dmg?.env).toBeUndefined()
    for (const step of steps) expect(step.if ?? '').not.toContain('secrets.')
  })

  it('公证/staple 失败不被忽略,失败产物也不上传', () => {
    expect(build['continue-on-error']).not.toBe(true)
    expect(dmg?.['continue-on-error']).not.toBe(true)
    expect(dmg?.shell).toBe('bash')
    expect(steps[uploadIndex]?.if).toBe('success()')
  })

  // 执行 workflow 的真实脚本,仅替换 xcrun;不访问 Apple,也不使用本机签名凭据。
  function runDmgStep(fail = '', names = ['Tendhearth CC_1.7.9_aarch64.dmg']) {
    expect(script).not.toBe('')
    const dir = mkdtempSync(join(tmpdir(), 'dmg-notarization-guard-'))
    try {
      const bin = join(dir, 'bin')
      const bundle = join(dir, 'apps/desktop/src-tauri/target/release/bundle/dmg')
      const log = join(dir, 'xcrun.log')
      mkdirSync(bin)
      mkdirSync(bundle, { recursive: true })
      for (const name of names) writeFileSync(join(bundle, name), 'fixture')
      writeFileSync(log, '')
      writeFileSync(join(bin, 'xcrun'), `#!/usr/bin/env bash
printf '<%s>' "$@" >> "$XCRUN_LOG"
printf '\\n' >> "$XCRUN_LOG"
if [[ "$1 $2" == "$XCRUN_FAIL" ]]; then exit 42; fi
`, { mode: 0o755 })
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd: dir, encoding: 'utf8', env: {
          ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
          APPLE_ID: 'ci@example.invalid', APPLE_PASSWORD: 'test-notary-password', APPLE_TEAM_ID: 'TESTTEAM123',
          XCRUN_LOG: log, XCRUN_FAIL: fail,
        },
      })
      expect(result.error).toBeUndefined()
      return { status: result.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === 'win32')('逐个 submit --wait 后 staple 同一个 DMG,兼容文件名空格且不提交其他文件', () => {
    const names = ['Tendhearth CC_1.7.9_aarch64.dmg', 'Tendhearth CC_1.7.9_x64.dmg']
    const result = runDmgStep('', [...names, 'other.txt'])
    expect(result.status).toBe(0)
    expect(result.calls).toHaveLength(4)
    for (const [i, name] of names.entries()) {
      const path = `apps/desktop/src-tauri/target/release/bundle/dmg/${name}`
      expect(result.calls[i * 2]).toContain(`<notarytool><submit><${path}>`)
      expect(result.calls[i * 2]).toContain('<--wait>')
      expect(result.calls[i * 2]).toContain('<--apple-id><ci@example.invalid>')
      expect(result.calls[i * 2]).toContain('<--password><test-notary-password>')
      expect(result.calls[i * 2]).toContain('<--team-id><TESTTEAM123>')
      expect(result.calls[i * 2 + 1]).toBe(`<stapler><staple><${path}>`)
    }
  })

  it.skipIf(process.platform === 'win32')('submit 失败立即退出,不继续 staple', () => {
    const result = runDmgStep('notarytool submit')
    expect(result.status).toBe(42)
    expect(result.calls).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('staple 失败同样让步骤失败', () => {
    const result = runDmgStep('stapler staple')
    expect(result.status).toBe(42)
    expect(result.calls).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('有凭据却没有 DMG 时失败,不把空 glob 当成已公证', () => {
    const result = runDmgStep('', [])
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
  })
})

describe('publish-update.yml —— 点 Publish 就该滚更新源', () => {
  const yml = wf('publish-update.yml')

  it('由 release published 触发(而不是只能手工跑)', () => {
    expect(yml).toMatch(/release:\s*\n\s*types:\s*\[published\]/)
  })

  it('用 --from-dir 一次发全平台,而不是单平台', () => {
    expect(yml).toContain('--from-dir release-assets')
  })

  it('挂在 release-signing 环境上 —— R2 令牌决定所有客户端装哪版', () => {
    expect(yml).toContain('environment: release-signing')
  })

  it('publish-update.ts 在 CI 里带 --strict:令牌无效 / 上传失败时退出非零,不能「降级为本地暂存」还报成功', () => {
    // 2026-09-27 desktop-v1.7.0:CF_API_TOKEN 已失效(verify 401),脚本降级暂存到 runner 的
    // dist-update/ 然后 exit 0,作业绿、GitHub Release 已发,而 latest.json 还是 1.6.5 ——
    // 新用户装到 1.7.0、老用户永远收不到更新。runner 上的暂存目录没有人会去拿。
    expect(yml).toMatch(/publish-update\.ts[\s\S]*--strict/)
    const script = readFileSync(join(HERE, 'publish-update.ts'), 'utf8')
    expect(script).toContain("'--strict'")
  })

  it('CF_API_TOKEN 缺失时**失败**,不静默跳过', () => {
    // 静默跳过的后果:release 发了,老用户永远停在旧版,没人会发现。
    expect(yml).toMatch(/if \[ -z "\$CF_API_TOKEN" \]/)
    expect(yml).toContain('exit 1')
  })

  it('release 标题/tag 经环境变量传进 shell,不做模板内插', () => {
    expect(yml).not.toMatch(/--notes "\$\{\{/)
    expect(yml).not.toMatch(/TAG="\$\{\{/)
  })
})
