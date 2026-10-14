/**
 * 编进桌面 sidecar 的两处原生依赖(2026-10-06,知识库语义搜索在打包版里能用)。
 *
 * `bun build --compile` 会把 onnxruntime-node 的 `.node` 绑定塞进二进制,运行时解到 $TMPDIR
 * 一个随机名字下;那个绑定按 `@loader_path` 找 `libonnxruntime.*.dylib`,而 dylib 没跟着解出来 ⇒
 * dlopen 失败,JS 向量化在打包版里从来没成功过(之前一直退回 Python,而 Python 那边模型下载也会失败)。
 *
 * 修法:macOS 上绑定和 dylib 一起放在 sidecar 旁边(.app 的 `Contents/MacOS`,走 Tauri 的 externalBin),
 * 编译时把 onnxruntime-node 的 `dist/binding.js` 改成从那里 `process.dlopen` —— 标准的
 * `@loader_path` 就能找到旁边的 dylib。`WECHAT_CC_ORT_DIR` 只给本地验证用。
 * 为什么不放 Frameworks:Tauri 给 `bundle.macOS.frameworks` 签名时不带安全时间戳(本地 DevID 构建核对过),
 * 公证会拒;externalBin 跟 sidecar 本身一样带 hardened runtime + 时间戳。
 * 其它平台不改(照旧退回 Python)。
 *
 * sharp:transformers.js 顶层 `import sharp`(图片处理),我们只做文本向量化,用不到;
 * 编进去反而又是一个解不出依赖的原生模块 ⇒ 所有平台都换成一个用到才报错的空壳。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BunPlugin } from 'bun'
import { readJsonFile } from '../../../src/lib/read-json-file'

export const ORT_VERSION = '1.24.3'
/** .app 里的两个文件名(Contents/MacOS 下)。绑定也用 .dylib 后缀:dlopen 不看后缀,统一好认。 */
export const ORT_FRAMEWORK_FILES = { binding: 'libonnxruntime_binding.dylib', runtime: `libonnxruntime.${ORT_VERSION}.dylib` } as const

const BINDING_REQUIRE = /require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/
const FRAMEWORKS_LOAD = `(()=>{const p=require("node:path");const m={exports:{}};process.dlopen(m,p.join(process.env.WECHAT_CC_ORT_DIR||p.dirname(process.execPath),${JSON.stringify(ORT_FRAMEWORK_FILES.binding)}));return m.exports})()`

/** onnxruntime-node 的 binding.js 改成从 sidecar 旁边载入;形状变了就让构建失败(升级 onnxruntime 时要重看)。 */
export function rewriteOrtBinding(source: string): string {
  const out = source.replace(BINDING_REQUIRE, FRAMEWORKS_LOAD)
  if (out === source) throw new Error('onnxruntime-node dist/binding.js changed shape; update apps/desktop/scripts/sidecar-native.ts')
  return out
}

export function sidecarNativePlugin(platform: NodeJS.Platform): BunPlugin {
  return {
    name: 'sidecar-native',
    setup(build) {
      build.onResolve({ filter: /^sharp$/ }, () => ({ path: 'sharp', namespace: 'sidecar-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'sidecar-stub' }, () => ({
        loader: 'js',
        contents: 'const sharp=()=>{throw new Error("sharp_unavailable_in_sidecar")};export default sharp',
      }))
      if (platform !== 'darwin') return
      build.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, args => ({ loader: 'js', contents: rewriteOrtBinding(readFileSync(args.path, 'utf8')) }))
    },
  }
}

/**
 * 把绑定和 dylib 拷到 src-tauri/frameworks(gitignore),文件名按 externalBin 的规矩带 Rust 三元组后缀;
 * tauri.macos.conf.json 的 externalBin 写不带后缀的名字,打包时落到 Contents/MacOS/<名字>。
 */
export function stageOrtFrameworks(root: string, arch: string, rustTriple: string): string[] {
  // onnxruntime-node 是 transformers 的依赖,bun 不一定把它提到顶层:从 transformers 那里解析。
  let transformers = dirname(Bun.resolveSync('@huggingface/transformers', root))
  while (!existsSync(join(transformers, 'package.json'))) transformers = dirname(transformers)
  const pkg = dirname(Bun.resolveSync('onnxruntime-node/package.json', transformers))
  const version = readJsonFile<{ version: string }>(join(pkg, 'package.json')).version
  if (version !== ORT_VERSION) throw new Error(`onnxruntime-node is ${version}, sidecar-native expects ${ORT_VERSION}`)
  const from = join(pkg, 'bin/napi-v6/darwin', arch)
  const to = join(root, 'apps/desktop/src-tauri/frameworks')
  mkdirSync(to, { recursive: true })
  const binding = join(to, `${ORT_FRAMEWORK_FILES.binding}-${rustTriple}`), runtime = join(to, `${ORT_FRAMEWORK_FILES.runtime}-${rustTriple}`)
  copyFileSync(join(from, 'onnxruntime_binding.node'), binding)
  copyFileSync(join(from, ORT_FRAMEWORK_FILES.runtime), runtime)
  return [binding, runtime]
}
