import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ORT_FRAMEWORK_FILES, ORT_VERSION, rewriteOrtBinding } from './sidecar-native'

describe('sidecar-native (2026-10-06)', () => {
  // 用装着的那份 onnxruntime-node:升级后 binding.js 换了形状,这里先红,而不是等发版构建或用户机上才发现。
  // transformers 的 exports 不开放 package.json:从它的入口往上找包根,再从那里解析 onnxruntime-node。
  let transformersDir = dirname(require.resolve('@huggingface/transformers'))
  while (!existsSync(join(transformersDir, 'package.json'))) transformersDir = dirname(transformersDir)
  const pkgDir = dirname(createRequire(join(transformersDir, 'package.json')).resolve('onnxruntime-node/package.json'))
  it('pins the installed onnxruntime-node version and its native file names', () => {
    expect(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version).toBe(ORT_VERSION)
    expect(ORT_FRAMEWORK_FILES.runtime).toBe(`libonnxruntime.${ORT_VERSION}.dylib`)
  })
  it('rewrites the real binding.js to dlopen the binding next to the executable', () => {
    const out = rewriteOrtBinding(readFileSync(join(pkgDir, 'dist/binding.js'), 'utf8'))
    expect(out).not.toContain('onnxruntime_binding.node`')
    expect(out).toContain('process.dlopen(')
    expect(out).toContain('WECHAT_CC_ORT_DIR')
    expect(out).toContain(JSON.stringify(ORT_FRAMEWORK_FILES.binding))
  })
  it('fails the build when the shape is unknown', () => {
    expect(() => rewriteOrtBinding('exports.binding = require("./x.node")')).toThrow(/changed shape/)
  })
})
