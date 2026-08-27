/**
 * Compile the CLI that Tauri bundles as its production sidecar.
 *
 * `tauri build` used to reuse whatever binary happened to be in
 * src-tauri/binaries. That made a locally built desktop app capable of
 * shipping an older CLI than its frontend, even though both came from the
 * same checkout. Keep the sidecar tied to the current `cli.ts` on every
 * production build.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

type Target = { bunTarget: string; rustTriple: string; extension?: string }

const targets: Record<string, Target> = {
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', rustTriple: 'aarch64-apple-darwin' },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', rustTriple: 'x86_64-apple-darwin' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', rustTriple: 'aarch64-unknown-linux-gnu' },
  'linux-x64': { bunTarget: 'bun-linux-x64', rustTriple: 'x86_64-unknown-linux-gnu' },
  'win32-arm64': { bunTarget: 'bun-windows-arm64', rustTriple: 'aarch64-pc-windows-msvc', extension: '.exe' },
  'win32-x64': { bunTarget: 'bun-windows-x64', rustTriple: 'x86_64-pc-windows-msvc', extension: '.exe' },
}

const target = targets[`${process.platform}-${process.arch}`]
if (!target) {
  throw new Error(`unsupported desktop sidecar platform: ${process.platform}-${process.arch}`)
}

const root = resolve(import.meta.dir, '../../..')
const output = join(
  root,
  'apps/desktop/src-tauri/binaries',
  `wechat-cc-cli-${target.rustTriple}${target.extension ?? ''}`,
)

mkdirSync(dirname(output), { recursive: true })

const args = [
  process.execPath,
  'build',
  '--compile',
  `--target=${target.bunTarget}`,
  ...(process.platform === 'win32' ? ['--windows-hide-console'] : []),
  join(root, 'cli.ts'),
  '--outfile',
  output,
]
const compiled = Bun.spawn({ cmd: args, stdout: 'inherit', stderr: 'inherit' })
if (await compiled.exited !== 0) {
  throw new Error('failed to compile the desktop CLI sidecar')
}

if (process.platform === 'win32') {
  // Bun 1.3.x accepts --windows-hide-console but still emits a CONSOLE PE;
  // Bun 1.4+ honors the flag and emits GUI directly (2026-08-26, first
  // real Windows build). Idempotent: CONSOLE(3) → patch to GUI(2);
  // already-GUI(2) → nothing to do; anything else is genuinely unexpected.
  const bytes = new Uint8Array(await Bun.file(output).arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const subsystemOffset = peOffset + 0x5c
  const subsystem = view.getUint16(subsystemOffset, true)
  if (subsystem === 3) {
    view.setUint16(subsystemOffset, 2, true)
    await Bun.write(output, bytes)
  } else if (subsystem !== 2) {
    throw new Error(`unexpected PE subsystem ${subsystem} (want CONSOLE=3 or GUI=2)`)
  }
} else {
  chmodSync(output, 0o755)
}

if (process.platform === 'darwin') {
  // Bun-compiled macOS binaries need an ad-hoc signature before Tauri bundles
  // them. The app bundle receives its final signature in the Tauri step.
  await Bun.spawn({ cmd: ['xattr', '-cr', output], stdout: 'ignore', stderr: 'ignore' }).exited
  await Bun.spawn({ cmd: ['codesign', '--remove-signature', output], stdout: 'ignore', stderr: 'ignore' }).exited
  const signed = Bun.spawn({
    cmd: ['codesign', '--force', '--sign', '-', '--identifier=dev.wechat-cc.cli', output],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (await signed.exited !== 0) {
    throw new Error('failed to ad-hoc sign the desktop CLI sidecar')
  }
}

console.log(`desktop sidecar ready: ${output}`)

// ── 打包资源安全断言 (2026-08-26 数据泄露后加固) ──
// beforeBuildCommand 每次构建必跑,是最早的关卡。核对 tauri.conf 声明的
// bundle.resources:禁止目录通配(会吞符号链接指向的仓库外数据 —— 曾把
// 105MB 解密私人微信库打进给别人的安装包),禁止符号链接,禁止巨文件。
// 数据泄露的修复本靠人盯注释;这条把它变成构建期硬 guard。
{
  const { readFileSync: rf, lstatSync, existsSync: ex } = await import('node:fs')
  const confPath = resolve(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json')
  const conf = JSON.parse(rf(confPath, 'utf8')) as { bundle?: { resources?: string[] } }
  const resources = conf.bundle?.resources ?? []
  const MAX_RESOURCE_BYTES = 2 * 1024 * 1024   // 单个打包资源 2MB 上限(源码/文档级,远超即可疑)
  const srcTauri = resolve(import.meta.dir, '..', 'src-tauri')
  const problems: string[] = []
  for (const res of resources) {
    if (res.includes('*') || res.endsWith('/')) { problems.push(`resources 含目录/通配 "${res}" —— 会吞符号链接指向的仓库外数据,改为逐个列出具体文件`); continue }
    const abs = resolve(srcTauri, res)
    if (!ex(abs)) { problems.push(`resources "${res}" 不存在`); continue }
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) { problems.push(`resources "${res}" 是符号链接 —— 可能指向仓库外的私密数据,禁止打包`); continue }
    if (st.isFile() && st.size > MAX_RESOURCE_BYTES) { problems.push(`resources "${res}" ${(st.size/1048576).toFixed(1)}MB 超过 ${MAX_RESOURCE_BYTES/1048576}MB 上限 —— 确认不含用户数据后再放行`) }
  }
  if (problems.length) {
    console.error('打包资源安全检查未通过:')
    for (const p of problems) console.error(`  ✗ ${p}`)
    throw new Error('bundle.resources 安全断言失败 —— 见上;数据泄露防线,不要绕过')
  }
  console.log(`bundle.resources 安全检查通过(${resources.length} 项)`)
}
