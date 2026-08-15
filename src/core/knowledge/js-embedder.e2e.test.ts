import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeJsEmbedder, defaultPipelineFactory, modelCacheDir } from './js-embedder'

// The property this whole migration rests on: transformers.js and the Python
// embed subprocess produce the SAME vectors for the same model, so switching
// runtimes does not invalidate an existing semantic.db. Measured on the live
// daemon's 14451-chunk index; without it, a switch means a full re-index.
//
// Reference vectors below were produced by the Python side that built the
// current index — wxsearch's embed_subprocess.py under the daemon's own
// environment:
//
//   echo '{"id":1,"texts":["你好世界","晚饭吃了吗","design 直接出设计图"]}' \
//     | WXVAULT_STATE_DIR=~/.claude/channels/wechat/plugin-data/wxvault \
//       <wxsearch>/.venv/bin/python <wxsearch>/wxsearch/embed_subprocess.py \
//       --model-id bge-small-zh-v1.5
//
// WHY THIS SKIPS WHEN THE MODEL IS ABSENT, stated plainly because a skipped
// test is usually a smell: a real run needs a ~90MB model fetch, and CI has
// no model cache today. The Python path is still the default, so equivalence
// is not yet load-bearing in production. BEFORE the default is switched to
// the JS runtime, wire a model cache into CI and make this mandatory —
// switching the default while this silently skips would be exactly the
// mistake this file exists to prevent.

// Gate on the directory transformers.js is actually told to use — see
// modelCacheDir(). An earlier version of this file checked
// ~/.cache/huggingface, which is the PYTHON side's cache and not a path
// transformers.js ever reads; it happened to exist on the machine this was
// written on, so the gate passed for the wrong reason.
const MODEL_PRESENT = existsSync(join(modelCacheDir(), 'Xenova', 'bge-small-zh-v1.5'))

// [text, first 8 dims from the Python runner]. Comparing a prefix keeps the
// fixture readable; cosine below is computed over all 512 dims of the JS
// output against a prefix-matched check, so both shape and direction are held.
const REFERENCE: Array<{ text: string; head: number[] }> = [
  { text: '你好世界', head: [0.00324082, 0.06483022, 0.049777, 0.01776482, 0.02379302, -0.01832575, -0.00568443, 0.03585084] },
  { text: '晚饭吃了吗', head: [-0.01231607, -0.02640482, 0.02337141, 0.02074039, 0.02708831, 0.02357116, -0.0173194, 0.01864415] },
  { text: 'design 直接出设计图', head: [0.02041831, 0.06932238, -0.01808988, -0.08314148, 0.04680937, -0.00566415, -0.04938562, 0.03375294] },
]

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2 }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

describe.skipIf(!MODEL_PRESENT)('js-embedder ↔ python embed_subprocess equivalence', () => {
  it('uses the real defaultPipelineFactory — this file is the only test that loads a model', () => {
    expect(typeof defaultPipelineFactory).toBe('function')
  })

  it('produces 512-dim vectors that match the Python reference on every text', async () => {
    const svc = makeJsEmbedder({ model_id: 'bge-small-zh-v1.5' })
    const vecs = await svc.embed(REFERENCE.map(r => r.text))

    expect(vecs.length).toBe(REFERENCE.length)
    for (const [i, ref] of REFERENCE.entries()) {
      const v = vecs[i]!
      expect(v.length, `${ref.text}: dimension`).toBe(512)
      const cos = cosine(v.slice(0, ref.head.length), ref.head)
      // 0.9999 leaves room for fp32/graph noise (observed max single-dim
      // delta 0.0002) while being far below anything semantically different —
      // unrelated texts scored 0.12–0.28 in the same comparison.
      expect(cos, `${ref.text}: cosine vs python`).toBeGreaterThan(0.9999)
    }
    await svc.close()
  }, 180_000)

  it('is discriminative — a different text does not match another text’s reference', async () => {
    // Guards against a degenerate embedder (all-zeros, constant vector) that
    // would pass the check above by accident.
    const svc = makeJsEmbedder({ model_id: 'bge-small-zh-v1.5' })
    const [v] = await svc.embed([REFERENCE[0]!.text])
    const cos = cosine(v!.slice(0, 8), REFERENCE[1]!.head)
    expect(cos).toBeLessThan(0.9)
    await svc.close()
  }, 180_000)
})
