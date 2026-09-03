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
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// import.meta.dir 是 Bun 的扩展,vitest 转译后是 undefined —— 测试跑在
// vitest 上(见 CLAUDE.md 的标准测试命令),所以这里用标准写法。
const HERE = dirname(fileURLToPath(import.meta.url))
const wf = (name: string) => readFileSync(join(HERE, '..', '.github', 'workflows', name), 'utf8')

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
