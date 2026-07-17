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
  // Bun 1.3.x accepts --windows-hide-console but still emits a CONSOLE PE.
  // Keep the established CI workaround here too, so local and CI builds agree.
  const bytes = new Uint8Array(await Bun.file(output).arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const subsystemOffset = peOffset + 0x5c
  if (view.getUint16(subsystemOffset, true) !== 3) {
    throw new Error('expected a CONSOLE PE sidecar before applying the GUI-subsystem workaround')
  }
  view.setUint16(subsystemOffset, 2, true)
  await Bun.write(output, bytes)
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
