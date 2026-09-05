# CC 桌宠 Phase A(纯桌宠运行时)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌宠窗从熊 + 鱼缸换成 manifest 驱动的 CC 精灵运行时:loader、状态机、动画解析与 fallback、渲染、道具层、拖动、调试页;先接 presence 的现有字段做最小映射,不碰 daemon。

**Architecture:** 全部在 `apps/desktop/src/pet/` 下,ES module + `// @ts-check` + `.test.ts`(仓库桌面侧惯例:测试用最小 DOM 桩,不用 jsdom)。纯层(loader / resolver / state-machine / presence-map)不碰 DOM;renderer 与 prop-layer 通过注入的元素工厂与计时器工作,因此可单测。`companion-window.html` 重写,只引 `pet.js` 与窗口胶水;Rust 侧只改窗口尺寸。

**Tech Stack:** 桌面页面是静态文件(`tauri.conf.json` `frontendDist: ../src`,dev 由 `test-shim.ts` 服务),无 bundler;Vitest(`bun --bun vitest run <file>`,仓库根目录)。

**Spec:** `docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md`(本 plan 只覆盖 §1 Phase A、§2、§3、§4、§7 Phase A 表、§8 Phase A 验收)。

## Global Constraints

- 业务代码只调 `pet.setState('working')` / `pet.setForm('lit')` / `pet.setProps([...], badge)`;**任何** `pet/` 以外的文件不得出现帧文件名或 `assets/pet/...` 路径(`manifestUrl` 这一个字符串除外)。
- 13 个行为名逐字:`idle blink look receive working thinking permission done companion sleep drag wake error`;两态 `unlit | lit`;两个转场名 `unlit-to-lit | lit-to-unlit`;8 个道具名逐字:`micro-light sprout laptop envelope speech-bubble thought-bubble exclamation mug`。
- 优先级表(逐字,数字越大越高):`permission 100, drag 90, transition 80, error 70, receive 60, done 60, wake 60, working 50, thinking 50, sleep 40, companion 30, look 20, blink 20, idle 10`。一次性状态集合:`blink look receive done drag wake error`。
- Fallback 链(spec §3 表):缺 `forms[form].states[behavior]` → 同 form `idle` → 该 form master → `lit.idle`;缺 `lit-to-unlit` → 淡出淡入(不倒放);未知 behavior → 当前 form `idle` + warning;帧加载失败 → 跳帧。每次回退都产生一条 warning 字符串,格式 `fallback:<form>/<behavior>→<用的是什么>`。
- **禁止**:为单帧写 offset / 缩放 / 裁切;按 alpha bbox 矫正;因资产缺失抛错或崩溃;修改或复制资产文件来补状态;倒放转场。
- 资产目录 `apps/desktop/src/assets/pet/`(manifest.json、reference/、states/、transitions/、props/、README.md;**不带** source/)。整包替换即升级。
- 呼吸:`scale 1.00 → 1.02`,周期 `2.8s`;blink 每 `6–12s` 随机,look 每 `25–60s` 随机,仅在 `idle / companion` 下;`prefers-reduced-motion` 关闭呼吸与随机动作、转场改首末帧 cross-fade。
- 窗口:label `companion` 复用;inner size `240 × 300`,min `200 × 250`,resize clamp 宽 `200–600`、高 `250–750`;transparent / no decorations / always-on-top / skip-taskbar 不变。
- CC 不说话:窗口里唯一的文本是「daemon 没起」提示(Phase B 再加权限卡)。
- 每个提交全量测试绿(`bun --bun vitest run`)、`bun run typecheck` 干净、`bun run depcheck` 干净;Task 6 末尾另跑 `cargo check`。报告前 `git status --short` 为空。
- 提交信息一行中文;trailer:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01UyRSmFJFdAc7VP1TzUUdS7`。

---

### Task 1: 资产入库 + `manifest-loader.js`

**Files:**
- Create: `apps/desktop/src/assets/pet/**`(从 `/Users/nategu_mac_company/Documents/Codex/2026-09-05/referenced-chatgpt-conversation-this-is-an-2/outputs/cc-desktop-pet-assets-v1/` 复制 `manifest.json README.md reference states transitions props`;不复制 `source/`、`PROMPTS.md`、`.DS_Store`)
- Create: `apps/desktop/src/pet/assets/manifest-loader.js`
- Test: `apps/desktop/src/pet/assets/manifest-loader.test.ts`

**Interfaces:**
- Produces:

```ts
/** @typedef {{ frames: string[], fps: number, loop: boolean, next: string | null }} Animation */
/** @typedef {{ master: string, states: Record<string, Animation> }} FormAssets */
/** @typedef {{
 *   canvas: { width: number, height: number, anchor: [number, number] },   // anchor 是比例
 *   forms: { unlit: FormAssets, lit: FormAssets },
 *   transitions: Record<string, Animation>,
 *   props: Record<string, string>,
 *   warnings: string[],
 * }} PetManifest */
export function normalizeManifest(raw: unknown, baseUrl?: string): { ok: true, manifest: PetManifest } | { ok: false, reason: string }
export async function loadManifest(url: string, fetchImpl?: typeof fetch): Promise<{ ok: true, manifest: PetManifest } | { ok: false, reason: string }>
```

- [ ] **Step 1: 复制资产**

```bash
cd /Users/nategu_mac_company/Documents/tendhearth/wechat-cc
SRC="/Users/nategu_mac_company/Documents/Codex/2026-09-05/referenced-chatgpt-conversation-this-is-an-2/outputs/cc-desktop-pet-assets-v1"
DST=apps/desktop/src/assets/pet
mkdir -p "$DST"
cp "$SRC/manifest.json" "$SRC/README.md" "$DST/"
cp -R "$SRC/reference" "$SRC/states" "$SRC/transitions" "$SRC/props" "$DST/"
find "$DST" -name .DS_Store -delete
find "$DST" -type f | wc -l      # 期望 36 张 png + 2 个文件 = 38
```

- [ ] **Step 2: 写失败测试**

`apps/desktop/src/pet/assets/manifest-loader.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeManifest, loadManifest } from './manifest-loader.js'

const realRaw = JSON.parse(readFileSync(join(__dirname, '../../assets/pet/manifest.json'), 'utf8'))

describe('normalizeManifest — v1 扁平形状(资产包现状)', () => {
  it('states 全归到 lit;unlit 只有 master 的 idle;anchor 是比例;路径拼上 baseUrl', () => {
    const r = normalizeManifest(realRaw, './assets/pet')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.manifest
    expect(m.canvas).toEqual({ width: 512, height: 512, anchor: [0.5, 0.91796875] })
    expect(Object.keys(m.forms.lit.states).sort()).toEqual(['blink', 'companion', 'done', 'drag', 'error', 'idle', 'look', 'permission', 'receive', 'sleep', 'thinking', 'wake', 'working'])
    expect(m.forms.lit.master).toBe('./assets/pet/reference/master-lit.png')
    expect(m.forms.unlit.master).toBe('./assets/pet/reference/master-unlit.png')
    expect(m.forms.unlit.states).toEqual({ idle: { frames: ['./assets/pet/reference/master-unlit.png'], fps: 1, loop: true, next: null } })
    expect(m.forms.lit.states.blink).toEqual({ frames: [
      './assets/pet/reference/master-lit.png', './assets/pet/states/blink-half/000.png', './assets/pet/states/blink-closed/000.png', './assets/pet/states/blink-half/000.png', './assets/pet/reference/master-lit.png',
    ], fps: 8, loop: false, next: 'idle' })
    expect(m.transitions['unlit-to-lit'].frames).toHaveLength(8)
    expect(m.transitions['unlit-to-lit'].fps).toBe(8)
    expect(m.props.envelope).toBe('./assets/pet/props/envelope.png')
    expect(m.warnings).toEqual([])
  })
  it('每张引用到的文件都真的存在(资产包完整性)', () => {
    const r = normalizeManifest(realRaw, join(__dirname, '../../assets/pet'))
    if (!r.ok) throw new Error(r.reason)
    const all = new Set<string>()
    for (const f of Object.values(r.manifest.forms)) { all.add(f.master); for (const a of Object.values(f.states)) a.frames.forEach(x => all.add(x)) }
    for (const a of Object.values(r.manifest.transitions)) a.frames.forEach(x => all.add(x))
    Object.values(r.manifest.props).forEach(x => all.add(x))
    for (const p of all) expect(() => readFileSync(p)).not.toThrow()
    expect(all.size).toBe(36)
  })
})

describe('normalizeManifest — forms 嵌套形状(handoff 目标契约)', () => {
  const nested = {
    schemaVersion: 1,
    canvas: { width: 512, height: 512, anchor: { x: 256, y: 470 } },
    forms: {
      unlit: { states: { idle: { frames: ['u/idle.png'], fps: 6, loop: true }, sleep: { frames: ['u/sleep.png'], fps: 2, loop: true } } },
      lit: { states: { idle: { frames: ['l/idle.png'], fps: 6, loop: true }, working: { frames: ['l/w0.png', 'l/w1.png'], fps: 8, loop: true } } },
    },
    transitions: { 'unlit-to-lit': { frames: ['t/0.png', 't/1.png'], fps: 8, loop: false }, 'lit-to-unlit': { frames: ['t/1.png', 't/0.png'], fps: 8, loop: false } },
    props: { mug: 'p/mug.png' },
  }
  it('px anchor 换算成比例;master 缺省取该 form idle 的第一帧;两个转场都保留', () => {
    const r = normalizeManifest(nested, '')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.canvas.anchor).toEqual([0.5, 470 / 512])
    expect(r.manifest.forms.unlit.master).toBe('u/idle.png')
    expect(r.manifest.forms.unlit.states.sleep.fps).toBe(2)
    expect(r.manifest.forms.lit.states.working.frames).toEqual(['l/w0.png', 'l/w1.png'])
    expect(Object.keys(r.manifest.transitions).sort()).toEqual(['lit-to-unlit', 'unlit-to-lit'])
    expect(r.manifest.transitions['unlit-to-lit'].next).toBe('idle')   // 缺省 next=idle(非 loop)
  })
})

describe('normalizeManifest — 两级校验', () => {
  it('无法解析:不是对象 / 没 canvas / 一个 form 都没有 → ok:false', () => {
    expect(normalizeManifest(null).ok).toBe(false)
    expect(normalizeManifest({ states: {} }).ok).toBe(false)
    expect(normalizeManifest({ canvas: { width: 512, height: 512 } })).toEqual({ ok: false, reason: 'no_forms' })
  })
  it('可降级缺失:空 frames 的 state 被丢弃并记 warning;fps 非法回 4;loop 缺省 false 且 next 缺省 idle', () => {
    const r = normalizeManifest({
      canvas: { width: 512, height: 512, anchor: [0.5, 0.9] },
      canonical: { unlit: 'u.png', lit: 'l.png' },
      states: { idle: { frames: ['l.png'] }, working: { frames: [] }, look: { frames: ['k.png'], fps: -3 } },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.forms.lit.states.working).toBeUndefined()
    expect(r.manifest.warnings).toContain('state_empty:lit/working')
    expect(r.manifest.forms.lit.states.look).toEqual({ frames: ['k.png'], fps: 4, loop: false, next: 'idle' })
    expect(r.manifest.forms.lit.states.idle).toEqual({ frames: ['l.png'], fps: 4, loop: false, next: 'idle' })
  })
  it('扁平形状缺 canonical.lit → lit.master 取 idle 第一帧;缺 canonical.unlit → unlit 用 lit master 顶上并 warning', () => {
    const r = normalizeManifest({ canvas: { width: 1, height: 1, anchor: [0.5, 0.5] }, states: { idle: { frames: ['l.png'], loop: true } } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.forms.lit.master).toBe('l.png')
    expect(r.manifest.forms.unlit.master).toBe('l.png')
    expect(r.manifest.warnings).toContain('form_missing:unlit')
  })
})

describe('loadManifest', () => {
  it('fetch 成功 → normalize,baseUrl 是 manifest 所在目录;fetch 失败 / 非 JSON → ok:false 不抛', async () => {
    const fetchOk = (async () => new Response(JSON.stringify(realRaw), { status: 200 })) as unknown as typeof fetch
    const r = await loadManifest('./assets/pet/manifest.json', fetchOk)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.forms.lit.master).toBe('./assets/pet/reference/master-lit.png')
    const fetch404 = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    expect(await loadManifest('./x/manifest.json', fetch404)).toEqual({ ok: false, reason: 'http_404' })
    const fetchBad = (async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch
    expect((await loadManifest('./x/manifest.json', fetchBad)).ok).toBe(false)
    const fetchThrow = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await loadManifest('./x/manifest.json', fetchThrow)).toEqual({ ok: false, reason: 'fetch_failed' })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/assets/manifest-loader.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现**

`apps/desktop/src/pet/assets/manifest-loader.js`:

```js
// @ts-check
// manifest-loader.js — 资产包的唯一视觉索引(spec 2026-09-05-cc-desktop-pet §3)。
// 接受两种形状:v1 扁平(states 全是 lit,canonical 两张 master)与 forms 嵌套。
// 归一后业务层只认 forms[form].states[behavior] / transitions / props。
// 两级校验:无法解析 → ok:false;可降级缺失 → 丢掉那一项 + warning。纯函数,不碰 DOM。

/** @typedef {{ frames: string[], fps: number, loop: boolean, next: string | null }} Animation */
/** @typedef {{ master: string, states: Record<string, Animation> }} FormAssets */
/** @typedef {{ canvas: { width: number, height: number, anchor: [number, number] }, forms: { unlit: FormAssets, lit: FormAssets }, transitions: Record<string, Animation>, props: Record<string, string>, warnings: string[] }} PetManifest */

const DEFAULT_FPS = 4

/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {string} baseUrl @param {string} p */
function resolvePath(baseUrl, p) {
  if (!baseUrl || /^(https?:|data:|\/|[a-zA-Z]:)/.test(p)) return p
  return `${baseUrl.replace(/\/+$/, '')}/${p.replace(/^\.?\//, '')}`
}

/**
 * @param {unknown} raw
 * @param {string} baseUrl
 * @param {string[]} warnings
 * @param {string} label   // 'lit/blink' / 'transition/unlit-to-lit',只用于 warning
 * @returns {Animation | null}
 */
function normalizeAnimation(raw, baseUrl, warnings, label) {
  if (!isObj(raw)) { warnings.push(`state_invalid:${label}`); return null }
  const o = /** @type {Record<string, unknown>} */ (raw)
  const frames = Array.isArray(o.frames) ? o.frames.filter((f) => typeof f === 'string' && f.length > 0).map((f) => resolvePath(baseUrl, /** @type {string} */ (f))) : []
  if (frames.length === 0) { warnings.push(`state_empty:${label}`); return null }
  const fps = typeof o.fps === 'number' && Number.isFinite(o.fps) && o.fps > 0 ? o.fps : DEFAULT_FPS
  const loop = o.loop === true
  const next = loop ? null : (typeof o.next === 'string' && o.next.length > 0 ? o.next : 'idle')
  return { frames, fps, loop, next }
}

/**
 * @param {unknown} rawStates
 * @param {string} baseUrl
 * @param {string[]} warnings
 * @param {string} form
 */
function normalizeStates(rawStates, baseUrl, warnings, form) {
  /** @type {Record<string, Animation>} */
  const out = {}
  if (!isObj(rawStates)) return out
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (rawStates))) {
    const a = normalizeAnimation(raw, baseUrl, warnings, `${form}/${name}`)
    if (a) out[name] = a
  }
  return out
}

/** @param {unknown} rawCanvas @returns {{ width: number, height: number, anchor: [number, number] } | null} */
function normalizeCanvas(rawCanvas) {
  if (!isObj(rawCanvas)) return null
  const c = /** @type {Record<string, unknown>} */ (rawCanvas)
  const width = typeof c.width === 'number' && c.width > 0 ? c.width : 0
  const height = typeof c.height === 'number' && c.height > 0 ? c.height : 0
  if (!width || !height) return null
  /** @type {[number, number]} */
  let anchor = [0.5, 0.9]
  const a = c.anchor
  if (Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === 'number')) {
    const [x, y] = /** @type {[number, number]} */ (a)
    anchor = x > 1 || y > 1 ? [x / width, y / height] : [x, y]
  } else if (isObj(a)) {
    const o = /** @type {{ x?: unknown, y?: unknown }} */ (a)
    if (typeof o.x === 'number' && typeof o.y === 'number') anchor = o.x > 1 || o.y > 1 ? [o.x / width, o.y / height] : [o.x, o.y]
  }
  return { width, height, anchor }
}

/**
 * @param {unknown} raw
 * @param {string} [baseUrl]
 * @returns {{ ok: true, manifest: PetManifest } | { ok: false, reason: string }}
 */
export function normalizeManifest(raw, baseUrl = '') {
  if (!isObj(raw)) return { ok: false, reason: 'not_object' }
  const r = /** @type {Record<string, unknown>} */ (raw)
  const canvas = normalizeCanvas(r.canvas)
  if (!canvas) return { ok: false, reason: 'no_canvas' }
  /** @type {string[]} */
  const warnings = []
  const canonical = isObj(r.canonical) ? /** @type {Record<string, unknown>} */ (r.canonical) : {}
  const canonicalOf = (/** @type {string} */ form) => typeof canonical[form] === 'string' ? resolvePath(baseUrl, /** @type {string} */ (canonical[form])) : null

  /** @type {Partial<Record<'unlit' | 'lit', FormAssets>>} */
  const forms = {}
  if (isObj(r.forms)) {
    for (const form of /** @type {const} */ (['unlit', 'lit'])) {
      const rf = /** @type {Record<string, unknown>} */ (r.forms)[form]
      if (!isObj(rf)) continue
      const states = normalizeStates(/** @type {Record<string, unknown>} */ (rf).states, baseUrl, warnings, form)
      const master = canonicalOf(form) ?? (typeof /** @type {Record<string, unknown>} */ (rf).master === 'string' ? resolvePath(baseUrl, /** @type {string} */ (/** @type {Record<string, unknown>} */ (rf).master)) : null) ?? states.idle?.frames[0] ?? null
      if (!master) { warnings.push(`form_no_master:${form}`); continue }
      forms[form] = { master, states }
    }
  } else if (isObj(r.states)) {
    // v1 扁平:states 全是 lit
    const states = normalizeStates(r.states, baseUrl, warnings, 'lit')
    const litMaster = canonicalOf('lit') ?? states.idle?.frames[0] ?? Object.values(states)[0]?.frames[0] ?? null
    if (litMaster) forms.lit = { master: litMaster, states }
    const unlitMaster = canonicalOf('unlit')
    if (unlitMaster) forms.unlit = { master: unlitMaster, states: { idle: { frames: [unlitMaster], fps: 1, loop: true, next: null } } }
  }
  if (!forms.lit && !forms.unlit) return { ok: false, reason: 'no_forms' }
  // 缺一边:用另一边的 master 顶上,逻辑上仍是两态,只是画面一样(warning 让人知道)
  if (!forms.lit) { warnings.push('form_missing:lit'); forms.lit = { master: forms.unlit.master, states: { idle: { frames: [forms.unlit.master], fps: 1, loop: true, next: null } } } }
  if (!forms.unlit) { warnings.push('form_missing:unlit'); forms.unlit = { master: forms.lit.master, states: { idle: { frames: [forms.lit.master], fps: 1, loop: true, next: null } } } }

  /** @type {Record<string, Animation>} */
  const transitions = {}
  if (isObj(r.transitions)) {
    for (const [name, raw2] of Object.entries(/** @type {Record<string, unknown>} */ (r.transitions))) {
      const a = normalizeAnimation(raw2, baseUrl, warnings, `transition/${name}`)
      if (a) transitions[name] = a
    }
  }
  /** @type {Record<string, string>} */
  const props = {}
  if (isObj(r.props)) {
    for (const [name, p] of Object.entries(/** @type {Record<string, unknown>} */ (r.props))) if (typeof p === 'string' && p) props[name] = resolvePath(baseUrl, p)
  }
  return { ok: true, manifest: { canvas, forms: /** @type {{ unlit: FormAssets, lit: FormAssets }} */ (forms), transitions, props, warnings } }
}

/**
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, manifest: PetManifest } | { ok: false, reason: string }>}
 */
export async function loadManifest(url, fetchImpl = fetch) {
  let res
  try { res = await fetchImpl(url) } catch { return { ok: false, reason: 'fetch_failed' } }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }
  let raw
  try { raw = await res.json() } catch { return { ok: false, reason: 'not_json' } }
  const baseUrl = url.includes('/') ? url.slice(0, url.lastIndexOf('/')) : ''
  return normalizeManifest(raw, baseUrl)
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/pet/assets/manifest-loader.test.ts && bun run typecheck && bun run depcheck`
Expected: PASS;typecheck 干净(desktop 的 `.js` 走 `// @ts-check`,若 tsconfig 不覆盖 apps/desktop 则至少 vitest 的 TS 测试通过);depcheck 无违规(新文件在 `apps/desktop`,不在 cruise 范围;若在,`no-orphans` 对 test 文件不生效)。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/assets/pet apps/desktop/src/pet/assets/manifest-loader.js apps/desktop/src/pet/assets/manifest-loader.test.ts
git commit -m "CC 桌宠资产 v1 入库 + manifest loader:扁平 / forms 两种形状归一,两级校验,不碰 DOM"
```

---

### Task 2: 领域类型 + 状态机(纯)

**Files:**
- Create: `apps/desktop/src/pet/domain/types.js`
- Create: `apps/desktop/src/pet/domain/state-machine.js`
- Test: `apps/desktop/src/pet/domain/state-machine.test.ts`

**Interfaces:**
- Produces:

```ts
// types.js
export const FORMS = ['unlit', 'lit']
export const BEHAVIORS = ['idle','blink','look','receive','working','thinking','permission','done','companion','sleep','drag','wake','error']
export const TRANSITIONS = ['unlit-to-lit', 'lit-to-unlit']
export const PROPS = ['micro-light','sprout','laptop','envelope','speech-bubble','thought-bubble','exclamation','mug']
export const PRIORITY = { permission: 100, drag: 90, transition: 80, error: 70, receive: 60, done: 60, wake: 60, working: 50, thinking: 50, sleep: 40, companion: 30, look: 20, blink: 20, idle: 10 }
export const ONE_SHOT = new Set(['blink','look','receive','done','drag','wake','error'])
export function isBehavior(x): x is PetBehavior
export function isForm(x): x is PetForm
// state-machine.js
/** @typedef {{ form: PetForm, behavior: PetBehavior, transition: PetTransition | null, targetForm: PetForm | null, resting: PetBehavior, props: string[], badge: number }} PetSnapshot */
export function createPetStateMachine(opts?: { initialForm?: PetForm }): {
  snapshot(): PetSnapshot
  subscribe(cb: (s: PetSnapshot) => void): () => void      // 每次变化都通知
  setForm(form: PetForm): boolean                            // 开始转场 → true;已是该态 / 已在往该态转 → false
  setState(behavior: string): 'applied' | 'queued' | 'ignored'
  setProps(props: string[], badge?: number): void
  notifyAnimationEnded(): void                               // renderer 在一次性动画 / 转场播完时调
  beginDrag(): void
  endDrag(): void
}
```

语义(逐条,测试按此写):
- `resting` = 当前的持续行为(初始 `idle`)。持续行为(非 ONE_SHOT):`setState(b)` 先把 `resting = b`;若当前没有一次性动画在播且没有转场 → `behavior = b`,返回 `applied`;若有一次性动画在播且 `PRIORITY[playing] > PRIORITY[b]` → 返回 `queued`(播完回落到 resting);若 `PRIORITY[b] >= PRIORITY[playing]` → 打断,`behavior = b`,`applied`。转场进行中:`permission`(优先级高于 transition)打断转场(form 直接变 targetForm、转场清空)并 `applied`;其它持续行为 `queued`。
- 一次性行为:当前正在播另一个一次性行为且其优先级更高 → `ignored`;转场进行中 → `ignored`(转场不被小动作打断);否则 `behavior = b`,`applied`,`resting` 不变。
- 未知字符串 → `ignored`。
- `setForm(f)`:`f === form && !transition` → false;`transition && targetForm === f` → false;否则 `transition = f === 'lit' ? 'unlit-to-lit' : 'lit-to-unlit'`,`targetForm = f`,返回 true。转场进行中 `behavior` 保持不变(renderer 播的是转场)。若正在转往另一边(A→B 中途要求回 A):直接结束当前转场到 A(form=A,transition=null),返回 false。
- `notifyAnimationEnded()`:有转场 → `form = targetForm`,`transition = null`,`targetForm = null`,`behavior = resting`;否则若 `behavior` 是一次性 → `behavior = resting`;否则无事。
- `beginDrag()`:`behavior = 'drag'`(即使转场中,也打断:form 跳到 targetForm);`endDrag()`:`behavior = resting`。拖动中 `setState` 的持续行为只更新 `resting` 并返回 `queued`,一次性行为 `ignored`。
- `setProps(list, badge=0)`:过滤掉不在 PROPS 里的名字,去重;badge 取非负整数。变化才通知。
- 每次状态变化(form / behavior / transition / props / badge)通知所有订阅者,传 `snapshot()`(深拷贝 props 数组)。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/domain/state-machine.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPetStateMachine } from './state-machine.js'
import { BEHAVIORS, PRIORITY, ONE_SHOT, PROPS, isBehavior } from './types.js'

describe('types', () => {
  it('13 个行为、优先级表覆盖全部行为 + transition、一次性集合是那 7 个', () => {
    expect(BEHAVIORS).toHaveLength(13)
    for (const b of BEHAVIORS) expect(PRIORITY[b]).toBeTypeOf('number')
    expect(PRIORITY.transition).toBe(80)
    expect([...ONE_SHOT].sort()).toEqual(['blink', 'done', 'drag', 'error', 'look', 'receive', 'wake'])
    expect(PROPS).toHaveLength(8)
    expect(isBehavior('working')).toBe(true); expect(isBehavior('paint')).toBe(false)
  })
})

describe('createPetStateMachine', () => {
  it('初始 unlit / idle / 无转场 / 无道具;setState 持续行为直接生效并成为 resting', () => {
    const m = createPetStateMachine()
    expect(m.snapshot()).toEqual({ form: 'unlit', behavior: 'idle', transition: null, targetForm: null, resting: 'idle', props: [], badge: 0 })
    expect(m.setState('working')).toBe('applied')
    expect(m.snapshot().behavior).toBe('working'); expect(m.snapshot().resting).toBe('working')
  })
  it('一次性行为播完回落到 resting;播放中更低优先级的持续行为只 queued', () => {
    const m = createPetStateMachine()
    m.setState('working')
    expect(m.setState('done')).toBe('applied')          // done 60 > working 50
    expect(m.snapshot().behavior).toBe('done')
    expect(m.setState('thinking')).toBe('queued')       // thinking 50 < done 60
    expect(m.snapshot().behavior).toBe('done'); expect(m.snapshot().resting).toBe('thinking')
    m.notifyAnimationEnded()
    expect(m.snapshot().behavior).toBe('thinking')
  })
  it('更高优先级的持续行为打断一次性行为;permission 打断一切', () => {
    const m = createPetStateMachine()
    m.setState('blink')                                  // 20
    expect(m.setState('working')).toBe('applied')        // 50 ≥ 20 → 打断
    expect(m.snapshot().behavior).toBe('working')
    m.setState('error')                                  // 70
    expect(m.setState('permission')).toBe('applied')     // 100
    expect(m.snapshot().behavior).toBe('permission')
  })
  it('一次性行为之间:正在播更高的 → ignored;更低的被打断', () => {
    const m = createPetStateMachine()
    m.setState('done')                                   // 60
    expect(m.setState('blink')).toBe('ignored')          // 20 < 60
    expect(m.setState('error')).toBe('applied')          // 70 > 60
    expect(m.snapshot().behavior).toBe('error')
    expect(m.setState('nope')).toBe('ignored')
  })
  it('setForm 开始转场;转场中一次性行为 ignored、持续行为 queued;播完 form 切换并回落到 resting', () => {
    const m = createPetStateMachine()
    m.setState('working')
    expect(m.setForm('lit')).toBe(true)
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: 'unlit-to-lit', targetForm: 'lit', behavior: 'working' })
    expect(m.setForm('lit')).toBe(false)                 // 已在往 lit 转
    expect(m.setState('blink')).toBe('ignored')
    expect(m.setState('thinking')).toBe('queued')
    m.notifyAnimationEnded()
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, targetForm: null, behavior: 'thinking', resting: 'thinking' })
    expect(m.setForm('lit')).toBe(false)                 // 已是 lit
    expect(m.setForm('unlit')).toBe(true)
    expect(m.snapshot().transition).toBe('lit-to-unlit')
  })
  it('转场中要求回原态 → 直接结束当前转场,不再转;permission 打断转场并把 form 跳到目标', () => {
    const m = createPetStateMachine()
    m.setForm('lit')
    expect(m.setForm('unlit')).toBe(false)
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: null })
    m.setForm('lit')
    expect(m.setState('permission')).toBe('applied')
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, behavior: 'permission' })
  })
  it('拖动:beginDrag 进 drag(打断转场并跳到目标 form),期间持续行为只记 resting,endDrag 回落', () => {
    const m = createPetStateMachine()
    m.setForm('lit')
    m.beginDrag()
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, behavior: 'drag' })
    expect(m.setState('working')).toBe('queued')
    expect(m.setState('blink')).toBe('ignored')
    m.endDrag()
    expect(m.snapshot().behavior).toBe('working')
  })
  it('setProps 过滤未知、去重、badge 非负整数;只在变化时通知', () => {
    const m = createPetStateMachine()
    const cb = vi.fn()
    m.subscribe(cb)
    m.setProps(['envelope', 'nope', 'envelope', 'mug'], 3.7)
    expect(m.snapshot().props).toEqual(['envelope', 'mug']); expect(m.snapshot().badge).toBe(3)
    expect(cb).toHaveBeenCalledTimes(1)
    m.setProps(['envelope', 'mug'], 3)
    expect(cb).toHaveBeenCalledTimes(1)                  // 没变,不通知
    m.setProps([], -2)
    expect(m.snapshot()).toMatchObject({ props: [], badge: 0 })
    expect(cb).toHaveBeenCalledTimes(2)
  })
  it('订阅者收到的是快照拷贝;退订后不再收', () => {
    const m = createPetStateMachine({ initialForm: 'lit' })
    const seen: unknown[] = []
    const off = m.subscribe(s => seen.push(s))
    m.setState('working')
    ;(seen[0] as { props: string[] }).props.push('x')
    expect(m.snapshot().props).toEqual([])
    off()
    m.setState('idle')
    expect(seen).toHaveLength(1)
    expect(m.snapshot().form).toBe('lit')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/domain/state-machine.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/pet/domain/types.js`:

```js
// @ts-check
// types.js — CC 的领域词表(spec 2026-09-05-cc-desktop-pet §2)。form / behavior / transition 分开建模。

/** @typedef {'unlit' | 'lit'} PetForm */
/** @typedef {'idle'|'blink'|'look'|'receive'|'working'|'thinking'|'permission'|'done'|'companion'|'sleep'|'drag'|'wake'|'error'} PetBehavior */
/** @typedef {'unlit-to-lit' | 'lit-to-unlit'} PetTransition */
/** @typedef {'micro-light'|'sprout'|'laptop'|'envelope'|'speech-bubble'|'thought-bubble'|'exclamation'|'mug'} PetProp */

/** @type {readonly PetForm[]} */
export const FORMS = Object.freeze(['unlit', 'lit'])
/** @type {readonly PetBehavior[]} */
export const BEHAVIORS = Object.freeze(['idle', 'blink', 'look', 'receive', 'working', 'thinking', 'permission', 'done', 'companion', 'sleep', 'drag', 'wake', 'error'])
/** @type {readonly PetTransition[]} */
export const TRANSITIONS = Object.freeze(['unlit-to-lit', 'lit-to-unlit'])
/** @type {readonly PetProp[]} */
export const PROPS = Object.freeze(['micro-light', 'sprout', 'laptop', 'envelope', 'speech-bubble', 'thought-bubble', 'exclamation', 'mug'])

/** handoff §5.4:permission > drag > transition > error > receive/done/wake > working/thinking > sleep > companion > look/blink > idle */
/** @type {Readonly<Record<PetBehavior | 'transition', number>>} */
export const PRIORITY = Object.freeze({
  permission: 100, drag: 90, transition: 80, error: 70, receive: 60, done: 60, wake: 60,
  working: 50, thinking: 50, sleep: 40, companion: 30, look: 20, blink: 20, idle: 10,
})
/** 播一次就回落的行为;其余是持续行为,保持到下一个事件。 */
export const ONE_SHOT = new Set(/** @type {PetBehavior[]} */ (['blink', 'look', 'receive', 'done', 'drag', 'wake', 'error']))

/** @param {unknown} x @returns {x is PetBehavior} */
export const isBehavior = (x) => typeof x === 'string' && /** @type {readonly string[]} */ (BEHAVIORS).includes(x)
/** @param {unknown} x @returns {x is PetForm} */
export const isForm = (x) => x === 'unlit' || x === 'lit'
/** @param {unknown} x @returns {x is PetProp} */
export const isProp = (x) => typeof x === 'string' && /** @type {readonly string[]} */ (PROPS).includes(x)
```

`apps/desktop/src/pet/domain/state-machine.js`:

```js
// @ts-check
// state-machine.js — CC 的状态机(spec §2):优先级、一次性 / 持续、转场、拖动、道具。
// 纯:不碰 DOM、不碰计时器。renderer 播完一次性动画 / 转场时调 notifyAnimationEnded()。
import { ONE_SHOT, PRIORITY, isBehavior, isForm, isProp } from './types.js'

/** @typedef {import('./types.js').PetForm} PetForm */
/** @typedef {import('./types.js').PetBehavior} PetBehavior */
/** @typedef {import('./types.js').PetTransition} PetTransition */
/** @typedef {{ form: PetForm, behavior: PetBehavior, transition: PetTransition | null, targetForm: PetForm | null, resting: PetBehavior, props: string[], badge: number }} PetSnapshot */

/**
 * @param {{ initialForm?: PetForm }} [opts]
 */
export function createPetStateMachine(opts = {}) {
  /** @type {PetForm} */ let form = isForm(opts.initialForm) ? opts.initialForm : 'unlit'
  /** @type {PetBehavior} */ let behavior = 'idle'
  /** @type {PetBehavior} */ let resting = 'idle'
  /** @type {PetTransition | null} */ let transition = null
  /** @type {PetForm | null} */ let targetForm = null
  /** @type {string[]} */ let props = []
  let badge = 0
  let dragging = false
  /** @type {Set<(s: PetSnapshot) => void>} */
  const subs = new Set()

  /** @returns {PetSnapshot} */
  const snapshot = () => ({ form, behavior, transition, targetForm, resting, props: [...props], badge })
  const notify = () => { const s = snapshot(); for (const cb of Array.from(subs)) { try { cb({ ...s, props: [...s.props] }) } catch (err) { console.error('pet subscriber threw', err) } } }

  /** 转场被更高优先级的东西打断:直接落到目标形态。 */
  const finishTransitionNow = () => { if (transition && targetForm) { form = targetForm } transition = null; targetForm = null }
  const playingOneShot = () => ONE_SHOT.has(behavior)

  return {
    snapshot,
    /** @param {(s: PetSnapshot) => void} cb */
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb) } },

    /** @param {PetForm} f */
    setForm(f) {
      if (!isForm(f)) return false
      if (transition) {
        if (targetForm === f) return false
        // 转到一半要求回去:结束当前转场留在原态,不再转
        transition = null; targetForm = null; notify(); return false
      }
      if (f === form) return false
      transition = f === 'lit' ? 'unlit-to-lit' : 'lit-to-unlit'
      targetForm = f
      notify()
      return true
    },

    /** @param {string} b @returns {'applied' | 'queued' | 'ignored'} */
    setState(b) {
      if (!isBehavior(b)) return 'ignored'
      const oneShot = ONE_SHOT.has(b)
      if (dragging) {
        if (oneShot) return 'ignored'
        if (resting !== b) { resting = b; notify() }
        return 'queued'
      }
      if (oneShot) {
        if (transition) return 'ignored'
        if (playingOneShot() && PRIORITY[behavior] > PRIORITY[b]) return 'ignored'
        behavior = b; notify(); return 'applied'
      }
      // 持续行为
      const changedResting = resting !== b
      resting = b
      if (transition) {
        if (PRIORITY[b] > PRIORITY.transition) { finishTransitionNow(); behavior = b; notify(); return 'applied' }
        if (changedResting) notify()
        return 'queued'
      }
      if (playingOneShot() && PRIORITY[behavior] > PRIORITY[b]) { if (changedResting) notify(); return 'queued' }
      if (behavior !== b) { behavior = b; notify() } else if (changedResting) notify()
      return 'applied'
    },

    /** @param {string[]} list @param {number} [b] */
    setProps(list, b = 0) {
      const next = Array.from(new Set((Array.isArray(list) ? list : []).filter(isProp)))
      const nextBadge = Math.max(0, Math.trunc(Number(b) || 0))
      const same = nextBadge === badge && next.length === props.length && next.every((p, i) => p === props[i])
      if (same) return
      props = next; badge = nextBadge; notify()
    },

    notifyAnimationEnded() {
      if (transition) { finishTransitionNow(); behavior = resting; notify(); return }
      if (dragging) return
      if (playingOneShot()) { behavior = resting; notify() }
    },

    beginDrag() {
      if (dragging) return
      dragging = true
      finishTransitionNow()
      behavior = 'drag'
      notify()
    },
    endDrag() {
      if (!dragging) return
      dragging = false
      behavior = resting
      notify()
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/pet/domain/ && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pet/domain
git commit -m "CC 状态机:form / behavior / transition 分开,优先级与一次性回落,拖动与道具 —— 纯函数"
```

---

### Task 3: `animation-resolver.js`(fallback 链,纯)

**Files:**
- Create: `apps/desktop/src/pet/assets/animation-resolver.js`
- Test: `apps/desktop/src/pet/assets/animation-resolver.test.ts`

**Interfaces:**
- Consumes: Task 1 `PetManifest` / `Animation`;Task 2 `isBehavior`。
- Produces:

```ts
export function resolveAnimation(manifest: PetManifest, form: PetForm, behavior: string): { animation: Animation, source: 'exact' | 'same-form-idle' | 'form-master' | 'lit-idle', warnings: string[] }
export function resolveTransition(manifest: PetManifest, transition: PetTransition, toForm: PetForm): { kind: 'frames', animation: Animation, warnings: string[] } | { kind: 'fade', to: Animation, warnings: string[] }
```

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/assets/animation-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveAnimation, resolveTransition } from './animation-resolver.js'
import type { PetManifest } from './manifest-loader.js'

const anim = (f: string, loop = true) => ({ frames: [f], fps: 4, loop, next: loop ? null : 'idle' })
const m: PetManifest = {
  canvas: { width: 512, height: 512, anchor: [0.5, 0.9] },
  forms: {
    lit: { master: 'lit-master.png', states: { idle: anim('lit-idle.png'), working: anim('lit-working.png'), blink: anim('lit-blink.png', false) } },
    unlit: { master: 'unlit-master.png', states: { idle: anim('unlit-master.png') } },
  },
  transitions: { 'unlit-to-lit': { frames: ['t0.png', 't1.png'], fps: 8, loop: false, next: 'idle' } },
  props: {},
  warnings: [],
}

describe('resolveAnimation', () => {
  it('exact 命中不带 warning', () => {
    expect(resolveAnimation(m, 'lit', 'working')).toEqual({ animation: anim('lit-working.png'), source: 'exact', warnings: [] })
  })
  it('unlit 下任何非 idle 行为 → unlit.idle(master),source same-form-idle,warning 说清楚', () => {
    const r = resolveAnimation(m, 'unlit', 'working')
    expect(r.source).toBe('same-form-idle')
    expect(r.animation.frames).toEqual(['unlit-master.png'])
    expect(r.warnings).toEqual(['fallback:unlit/working→unlit/idle'])
  })
  it('同 form 连 idle 都没有 → form master 合成的单帧 loop;再没有 → lit.idle', () => {
    const noIdle: PetManifest = { ...m, forms: { ...m.forms, unlit: { master: 'unlit-master.png', states: {} } } }
    const r = resolveAnimation(noIdle, 'unlit', 'sleep')
    expect(r.source).toBe('form-master')
    expect(r.animation).toEqual({ frames: ['unlit-master.png'], fps: 1, loop: true, next: null })
    const noUnlitAtAll: PetManifest = { ...m, forms: { ...m.forms, unlit: { master: '', states: {} } } }
    expect(resolveAnimation(noUnlitAtAll, 'unlit', 'sleep').source).toBe('lit-idle')
  })
  it('未知 behavior → 当前 form 的 idle + warning unknown_behavior', () => {
    const r = resolveAnimation(m, 'lit', 'paint')
    expect(r.animation.frames).toEqual(['lit-idle.png'])
    expect(r.warnings).toEqual(['unknown_behavior:paint', 'fallback:lit/paint→lit/idle'])
  })
})

describe('resolveTransition', () => {
  it('有帧 → frames 原样(不倒放)', () => {
    const r = resolveTransition(m, 'unlit-to-lit', 'lit')
    expect(r.kind).toBe('frames')
    if (r.kind === 'frames') expect(r.animation.frames).toEqual(['t0.png', 't1.png'])
  })
  it('缺 lit-to-unlit → fade 到目标 form 的 idle,warning 记录;绝不把 unlit-to-lit 倒过来用', () => {
    const r = resolveTransition(m, 'lit-to-unlit', 'unlit')
    expect(r.kind).toBe('fade')
    if (r.kind === 'fade') expect(r.to.frames).toEqual(['unlit-master.png'])
    expect(r.warnings).toEqual(['fallback:transition/lit-to-unlit→fade'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/assets/animation-resolver.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/pet/assets/animation-resolver.js`:

```js
// @ts-check
// animation-resolver.js — form + behavior + manifest → 动画(spec §3 的 fallback 链)。
// 业务层永远拿不到帧文件名;缺什么都有一条 warning,从不抛。纯函数。
import { isBehavior } from '../domain/types.js'

/** @typedef {import('./manifest-loader.js').PetManifest} PetManifest */
/** @typedef {import('./manifest-loader.js').Animation} Animation */
/** @typedef {import('../domain/types.js').PetForm} PetForm */
/** @typedef {import('../domain/types.js').PetTransition} PetTransition */

/** @param {string} master @returns {Animation} */
const masterLoop = (master) => ({ frames: [master], fps: 1, loop: true, next: null })

/**
 * @param {PetManifest} manifest
 * @param {PetForm} form
 * @param {string} behavior
 * @returns {{ animation: Animation, source: 'exact' | 'same-form-idle' | 'form-master' | 'lit-idle', warnings: string[] }}
 */
export function resolveAnimation(manifest, form, behavior) {
  /** @type {string[]} */
  const warnings = []
  let want = behavior
  if (!isBehavior(behavior)) { warnings.push(`unknown_behavior:${behavior}`); want = 'idle' }
  const f = manifest.forms[form]
  const exact = f?.states[want]
  if (exact) return { animation: exact, source: 'exact', warnings }
  if (f?.states.idle) { warnings.push(`fallback:${form}/${behavior}→${form}/idle`); return { animation: f.states.idle, source: 'same-form-idle', warnings } }
  if (f?.master) { warnings.push(`fallback:${form}/${behavior}→${form}/master`); return { animation: masterLoop(f.master), source: 'form-master', warnings } }
  warnings.push(`fallback:${form}/${behavior}→lit/idle`)
  const lit = manifest.forms.lit
  return { animation: lit?.states.idle ?? masterLoop(lit?.master ?? ''), source: 'lit-idle', warnings }
}

/**
 * @param {PetManifest} manifest
 * @param {PetTransition} transition
 * @param {PetForm} toForm
 * @returns {{ kind: 'frames', animation: Animation, warnings: string[] } | { kind: 'fade', to: Animation, warnings: string[] }}
 */
export function resolveTransition(manifest, transition, toForm) {
  const a = manifest.transitions[transition]
  if (a) return { kind: 'frames', animation: a, warnings: [] }
  // 缺转场:淡出淡入到目标形态的 idle。不倒放另一方向(handoff §4.3)。
  const to = resolveAnimation(manifest, toForm, 'idle').animation
  return { kind: 'fade', to, warnings: [`fallback:transition/${transition}→fade`] }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/pet/assets/ && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pet/assets/animation-resolver.js apps/desktop/src/pet/assets/animation-resolver.test.ts
git commit -m "CC 动画解析:缺什么退到哪一层写死成表,每次回退一条 warning,永不倒放转场"
```

---

### Task 4: `sprite-renderer.js` + `prop-layer.js`(注入式 DOM,可测)

**Files:**
- Create: `apps/desktop/src/pet/renderer/sprite-renderer.js`
- Create: `apps/desktop/src/pet/renderer/prop-layer.js`
- Test: `apps/desktop/src/pet/renderer/sprite-renderer.test.ts`
- Test: `apps/desktop/src/pet/renderer/prop-layer.test.ts`

**Interfaces:**
- Consumes: Task 1 `Animation`、`PetManifest`。
- Produces:

```ts
// 最小元素接口(真实 DOM 元素与测试桩都满足)
/** @typedef {{ style: Record<string, string>, classList: { add(c: string): void, remove(c: string): void, contains(c: string): boolean }, setAttribute(k: string, v: string): void, getAttribute(k: string): string | null, src?: string, textContent?: string, appendChild(c: any): void, replaceChildren(...c: any[]): void, children?: any[] }} ElLike */

export function createSpriteRenderer(deps: {
  img: ElLike,                                   // 主体 <img>
  stage: ElLike,                                 // 舞台容器(用来放 anchor CSS 变量)
  schedule: (fn: () => void, ms: number) => unknown,   // 缺省 setTimeout
  cancel: (handle: unknown) => void,             // 缺省 clearTimeout
  reducedMotion?: boolean,
  fadeMs?: number,                               // 缺省 240
  preload?: (url: string) => void,               // 缺省 new Image().src = url(测试传 no-op)
}): {
  applyAnchor(anchor: [number, number]): void    // 写 --pet-anchor-x / --pet-anchor-y 到 stage.style
  play(animation: Animation, opts?: { onEnd?: () => void }): void   // loop=false 播完调 onEnd 一次
  fadeTo(animation: Animation, opts?: { onEnd?: () => void }): void // 淡出 → 换动画 → 淡入 → onEnd
  setBreathing(on: boolean): void                // 加/去 class 'pet-breathing'(reducedMotion 时永远不加)
  stop(): void
  currentFrame(): string | null
}
export const PROP_SLOTS: Record<PetProp, 'above-head' | 'beside-right' | 'in-front'>
export const SLOTS: Record<'above-head' | 'beside-right' | 'in-front', { dx: number, dy: number, scale: number }>   // 相对 anchor、以舞台边长为 1 的比例
export function renderProps(container: ElLike, props: string[], badge: number, manifest: PetManifest, makeEl: (tag: string) => ElLike): void
```

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/renderer/sprite-renderer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createSpriteRenderer } from './sprite-renderer.js'

function el() {
  const classes = new Set<string>()
  return {
    style: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    src: '', appendChild() {}, replaceChildren() {},
  }
}
/** 手动计时器:schedule 入队,tick(ms) 推进。 */
function clock() {
  let now = 0; let seq = 0
  const q: Array<{ at: number, id: number, fn: () => void }> = []
  return {
    schedule: (fn: () => void, ms: number) => { const id = ++seq; q.push({ at: now + ms, id, fn }); return id },
    cancel: (id: unknown) => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1) },
    tick(ms: number) { const until = now + ms; while (true) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > until) break; q.shift(); now = n.at; n.fn() } now = until },
    pending: () => q.length,
  }
}
const anim = (frames: string[], fps: number, loop: boolean) => ({ frames, fps, loop, next: loop ? null : 'idle' })

describe('createSpriteRenderer', () => {
  it('applyAnchor 写 CSS 变量;play 立即显示第 0 帧,按 fps 推进,loop 循环', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    r.applyAnchor([0.5, 0.91796875])
    expect(stage.style['--pet-anchor-x']).toBe('50%'); expect(stage.style['--pet-anchor-y']).toBe('91.796875%')
    r.play(anim(['a.png', 'b.png'], 4, true))
    expect(img.src).toBe('a.png')
    c.tick(250); expect(img.src).toBe('b.png')
    c.tick(250); expect(img.src).toBe('a.png')
  })
  it('一次性动画播完最后一帧停在最后一帧并调 onEnd 一次;单帧非 loop 也会结束', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    const onEnd = vi.fn()
    r.play(anim(['a.png', 'b.png', 'c.png'], 8, false), { onEnd })
    c.tick(125); c.tick(125); expect(img.src).toBe('c.png'); expect(onEnd).not.toHaveBeenCalled()
    c.tick(125); expect(onEnd).toHaveBeenCalledTimes(1); expect(img.src).toBe('c.png')
    c.tick(1000); expect(onEnd).toHaveBeenCalledTimes(1)
    const onEnd2 = vi.fn()
    r.play(anim(['x.png'], 4, false), { onEnd: onEnd2 })
    c.tick(250); expect(onEnd2).toHaveBeenCalledTimes(1)
  })
  it('新 play 取消旧的计时器(不会两套帧交错);stop 后不再推进', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    r.play(anim(['a.png', 'b.png'], 4, true))
    r.play(anim(['x.png', 'y.png'], 4, true))
    expect(c.pending()).toBe(1)
    c.tick(250); expect(img.src).toBe('y.png')
    r.stop(); c.tick(1000); expect(img.src).toBe('y.png'); expect(c.pending()).toBe(0)
  })
  it('fadeTo:先加 pet-fading,fadeMs 后换动画并去掉 class,再 fadeMs 后 onEnd', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, fadeMs: 240 })
    r.play(anim(['old.png'], 1, true))
    const onEnd = vi.fn()
    r.fadeTo(anim(['new.png'], 1, true), { onEnd })
    expect(img.classList.contains('pet-fading')).toBe(true); expect(img.src).toBe('old.png')
    c.tick(240); expect(img.src).toBe('new.png'); expect(img.classList.contains('pet-fading')).toBe(false); expect(onEnd).not.toHaveBeenCalled()
    c.tick(240); expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('reducedMotion:setBreathing 永远不加 class;正常时加/去 pet-breathing', () => {
    const c = clock()
    const a = createSpriteRenderer({ img: el(), stage: el(), schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    const stageA = el(); const ra = createSpriteRenderer({ img: el(), stage: stageA, schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    ra.setBreathing(true); expect(stageA.classList.contains('pet-breathing')).toBe(false)
    void a
    const stageB = el(); const rb = createSpriteRenderer({ img: el(), stage: stageB, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
    rb.setBreathing(true); expect(stageB.classList.contains('pet-breathing')).toBe(true)
    rb.setBreathing(false); expect(stageB.classList.contains('pet-breathing')).toBe(false)
  })
  it('reducedMotion 下多帧一次性动画只显示首帧与末帧(cross-fade 由 CSS 做),onEnd 仍只调一次', () => {
    const img = el(), stage = el(), c = clock()
    const r = createSpriteRenderer({ img, stage, schedule: c.schedule, cancel: c.cancel, preload: () => {}, reducedMotion: true })
    const onEnd = vi.fn()
    r.play(anim(['a.png', 'b.png', 'c.png', 'd.png'], 8, false), { onEnd })
    expect(img.src).toBe('a.png')
    c.tick(500)                                   // 4 帧 @8fps = 500ms
    expect(img.src).toBe('d.png'); expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('preload 对每个不重复的帧 url 调一次', () => {
    const preload = vi.fn(); const c = clock()
    const r = createSpriteRenderer({ img: el(), stage: el(), schedule: c.schedule, cancel: c.cancel, preload })
    r.play(anim(['a.png', 'b.png', 'a.png'], 4, true))
    expect(preload.mock.calls.map(x => x[0]).sort()).toEqual(['a.png', 'b.png'])
  })
})
```

`apps/desktop/src/pet/renderer/prop-layer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PROP_SLOTS, SLOTS, renderProps } from './prop-layer.js'
import { PROPS } from '../domain/types.js'
import type { PetManifest } from '../assets/manifest-loader.js'

function makeEl(tag: string) {
  const kids: any[] = []
  const classes = new Set<string>()
  return {
    tag, style: {} as Record<string, string>, textContent: '', src: '', attrs: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c) }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) }, children: kids,
  }
}
const manifest = { canvas: { width: 512, height: 512, anchor: [0.5, 0.9] }, forms: {} as any, transitions: {}, props: { envelope: 'p/envelope.png', mug: 'p/mug.png' }, warnings: [] } as PetManifest

describe('prop-layer', () => {
  it('8 个道具都有槽位;3 个槽位都有偏移与缩放', () => {
    for (const p of PROPS) expect(SLOTS[PROP_SLOTS[p]]).toBeDefined()
    expect(Object.keys(SLOTS).sort()).toEqual(['above-head', 'beside-right', 'in-front'])
  })
  it('renderProps:每个道具一个 img(src 来自 manifest)+ 槽位 CSS 变量;envelope 带 badge;manifest 没有的道具跳过', () => {
    const c = makeEl('div')
    renderProps(c, ['envelope', 'mug', 'laptop'], 3, manifest, makeEl)
    expect(c.children).toHaveLength(2)
    const env = c.children[0]
    expect(env.children[0].src).toBe('p/envelope.png')
    expect(env.attrs['data-prop']).toBe('envelope')
    expect(env.style['--slot-dx']).toBe(String(SLOTS[PROP_SLOTS.envelope].dx))
    expect(env.children[1].textContent).toBe('3')          // badge
    expect(c.children[1].children).toHaveLength(1)         // mug 没 badge
  })
  it('空列表 → 清空;badge 0 不渲染数字', () => {
    const c = makeEl('div')
    renderProps(c, ['envelope'], 0, manifest, makeEl)
    expect(c.children[0].children).toHaveLength(1)
    renderProps(c, [], 0, manifest, makeEl)
    expect(c.children).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/renderer/`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/pet/renderer/sprite-renderer.js`:

```js
// @ts-check
// sprite-renderer.js — 只管按 resolved animation 换帧、fps、loop、anchor、呼吸、淡出淡入(spec §4)。
// DOM 与计时器都是注入的,所以能在没有 jsdom 的测试里跑。不认识 behavior,不认识文件名的含义。

/** @typedef {import('../assets/manifest-loader.js').Animation} Animation */
/** @typedef {{ style: Record<string, string>, classList: { add(c: string): void, remove(c: string): void, contains(c: string): boolean }, setAttribute(k: string, v: string): void, getAttribute(k: string): string | null, src?: string }} ElLike */

const DEFAULT_FADE_MS = 240

/**
 * @param {{
 *   img: ElLike, stage: ElLike,
 *   schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void,
 *   reducedMotion?: boolean, fadeMs?: number, preload?: (url: string) => void,
 * }} deps
 */
export function createSpriteRenderer(deps) {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((h) => clearTimeout(/** @type {any} */ (h)))
  const reduced = deps.reducedMotion === true
  const fadeMs = deps.fadeMs ?? DEFAULT_FADE_MS
  const preload = deps.preload ?? ((url) => { try { const i = new Image(); i.src = url } catch { /* 非浏览器环境 */ } })
  /** @type {Set<string>} */
  const preloaded = new Set()
  /** @type {unknown} */ let timer = null
  /** @type {unknown} */ let fadeIn = null      // 淡入结束的计时器,与帧计时器分开持有
  /** @type {string | null} */ let frame = null
  let generation = 0

  const clear = () => { if (timer !== null) { cancel(timer); timer = null } if (fadeIn !== null) { cancel(fadeIn); fadeIn = null } }
  /** @param {string} url */
  const show = (url) => { frame = url; deps.img.src = url }

  /**
   * @param {Animation} a
   * @param {(() => void) | undefined} onEnd
   */
  function run(a, onEnd) {
    clear()
    const gen = ++generation
    for (const f of a.frames) if (!preloaded.has(f)) { preloaded.add(f); preload(f) }
    const frames = a.frames.length ? a.frames : [frame ?? '']
    const stepMs = Math.max(16, Math.round(1000 / (a.fps > 0 ? a.fps : 1)))
    let i = 0
    show(frames[0])
    if (frames.length === 1 && a.loop) return
    // reduced motion:一次性多帧动画只显示首末帧,时长不变(给 CSS cross-fade 留时间)
    if (reduced && !a.loop && frames.length > 1) {
      timer = schedule(() => { if (gen !== generation) return; timer = null; show(frames[frames.length - 1]); onEnd?.() }, stepMs * frames.length)
      return
    }
    const step = () => {
      if (gen !== generation) return
      i += 1
      if (i >= frames.length) {
        if (a.loop) { i = 0 } else { timer = null; onEnd?.(); return }
      }
      show(frames[i])
      timer = schedule(step, stepMs)
    }
    timer = schedule(step, stepMs)
  }

  return {
    /** @param {[number, number]} anchor */
    applyAnchor(anchor) {
      deps.stage.style['--pet-anchor-x'] = `${anchor[0] * 100}%`
      deps.stage.style['--pet-anchor-y'] = `${anchor[1] * 100}%`
    },
    /** @param {Animation} a @param {{ onEnd?: () => void }} [opts] */
    play(a, opts = {}) { run(a, opts.onEnd) },
    /** @param {Animation} a @param {{ onEnd?: () => void }} [opts] */
    fadeTo(a, opts = {}) {
      clear()
      const gen = ++generation
      deps.img.classList.add('pet-fading')
      timer = schedule(() => {
        if (gen !== generation) return
        deps.img.classList.remove('pet-fading')
        run(a, undefined)                 // run() 会 clear(),所以 fadeIn 必须在它之后再排
        const gen2 = generation
        fadeIn = schedule(() => { if (gen2 !== generation) return; fadeIn = null; opts.onEnd?.() }, fadeMs)
      }, fadeMs)
    },
    /** @param {boolean} on */
    setBreathing(on) {
      if (on && !reduced) deps.stage.classList.add('pet-breathing')
      else deps.stage.classList.remove('pet-breathing')
    },
    stop() { generation += 1; clear() },
    currentFrame() { return frame },
  }
}
```

`apps/desktop/src/pet/renderer/prop-layer.js`:

```js
// @ts-check
// prop-layer.js — 道具独立于主体渲染(spec §4)。manifest 没有道具偏移,这里用一张集中的槽位表:
// 槽位是相对 anchor 的比例偏移,不是逐帧 offset。改道具位置只改这张表。
import { isProp } from '../domain/types.js'

/** @typedef {import('../assets/manifest-loader.js').PetManifest} PetManifest */
/** @typedef {import('../domain/types.js').PetProp} PetProp */
/** @typedef {'above-head' | 'beside-right' | 'in-front'} Slot */

/** 以舞台边长为 1;dx 向右为正,dy 向上为负(相对 anchor 点)。 */
/** @type {Readonly<Record<Slot, { dx: number, dy: number, scale: number }>>} */
export const SLOTS = Object.freeze({
  'above-head': { dx: 0.22, dy: -0.66, scale: 0.34 },
  'beside-right': { dx: 0.36, dy: -0.26, scale: 0.34 },
  'in-front': { dx: 0.02, dy: -0.12, scale: 0.40 },
})

/** @type {Readonly<Record<PetProp, Slot>>} */
export const PROP_SLOTS = Object.freeze({
  'micro-light': 'above-head',
  sprout: 'above-head',
  'speech-bubble': 'above-head',
  'thought-bubble': 'above-head',
  exclamation: 'above-head',
  envelope: 'beside-right',
  mug: 'beside-right',
  laptop: 'in-front',
})

/**
 * @param {{ replaceChildren(...c: any[]): void }} container
 * @param {string[]} props
 * @param {number} badge
 * @param {PetManifest} manifest
 * @param {(tag: string) => any} makeEl
 */
export function renderProps(container, props, badge, manifest, makeEl) {
  /** @type {any[]} */
  const nodes = []
  for (const name of props) {
    if (!isProp(name)) continue
    const src = manifest.props[name]
    if (!src) continue
    const slot = SLOTS[PROP_SLOTS[name]]
    const wrap = makeEl('div')
    wrap.classList.add('pet-prop')
    wrap.setAttribute('data-prop', name)
    wrap.style['--slot-dx'] = String(slot.dx)
    wrap.style['--slot-dy'] = String(slot.dy)
    wrap.style['--slot-scale'] = String(slot.scale)
    const img = makeEl('img')
    img.src = src
    img.setAttribute('alt', '')
    img.setAttribute('aria-hidden', 'true')
    wrap.appendChild(img)
    if (name === 'envelope' && badge > 0) {
      const b = makeEl('span')
      b.classList.add('pet-badge')
      b.textContent = String(badge)
      wrap.appendChild(b)
    }
    nodes.push(wrap)
  }
  container.replaceChildren(...nodes)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/pet/ && bun run typecheck`
Expected: PASS(含 Task 1–3 的测试)。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pet/renderer
git commit -m "CC 渲染层:换帧 / fps / loop / anchor / 呼吸 / 淡出淡入 + 道具槽位表 —— DOM 与计时器注入,可单测"
```

---

### Task 5: `presence-map.js` + `pet.js` 组装 + 陪伴窗重写 + Rust 尺寸

**Files:**
- Create: `apps/desktop/src/pet/bridge/presence-map.js` + `presence-map.test.ts`
- Create: `apps/desktop/src/pet/pet.js` + `pet.test.ts`
- Rewrite: `apps/desktop/src/companion-window.html`、`companion-window.js`、`companion-window.css`
- Delete: `apps/desktop/src/companion-window-presence.js`(其职责并入 `companion-window.js`)
- Modify: `apps/desktop/src-tauri/src/lib.rs`(尺寸与 clamp)

**Interfaces:**
- Consumes: Task 1–4 全部;既有 `createPresencePoller`(`presence-poller.js`,20 s)、`invokeApi`(`api.js`)、`invoke`(`ipc.js`)、`Presence` 形状 `{ presence: 'down'|'offline'|'degraded'|'ok', activity: { kind, label, since }, news: { unread, latest_kind, latest_title } }`。
- Produces:

```ts
// presence-map.js(纯)
/** @typedef {{ form: 'unlit' | 'lit', behavior: PetBehavior, props: string[], badge: number, hint: string | null, oneShots: PetBehavior[] }} PetIntent */
export function presenceToPet(p: Presence | null, prev: Presence | null, nowMs?: number): PetIntent
// pet.js
export async function createPet(root: { stage: ElLike, img: ElLike, props: ElLike & { replaceChildren }, hint?: { textContent: string, hidden: boolean } }, opts: { manifestUrl: string, fetchImpl?: typeof fetch, reducedMotion?: boolean, makeEl?: (tag: string) => any, schedule?, cancel?, preload? }): Promise<{
  machine: ReturnType<typeof createPetStateMachine>,
  warnings: string[],                                  // loader + 每次 resolve 的累计(去重)
  setState(b: string): 'applied' | 'queued' | 'ignored',
  setForm(f: PetForm): boolean,
  setProps(list: string[], badge?: number): void,
  applyIntent(intent: PetIntent): void,                // form → props → 持续 behavior → oneShots 依次
  setHint(text: string | null): void,
  beginDrag(): void, endDrag(): void,
  destroy(): void,
}>
```

Phase A 的 presence 映射(spec §5.1 的处境部分,turn 部分 Phase B 再接):

| 输入 | form | behavior | props | hint | oneShots |
|---|---|---|---|---|---|
| `p === null` 或 `presence === 'down'` | unlit | sleep | [] | 「daemon 没起」 | [] |
| `offline` | unlit | sleep | unread>0 ? [envelope] : [] | null | [] |
| `degraded`(且 prev 不是 degraded) | 按 chatting | idle | [exclamation, +envelope?] | null | [error] |
| `degraded`(持续) | 同上 | idle | 同上 | null | [] |
| `activity.kind ∈ {hosting_human, visiting, hosting_peer}` | 按 chatting | companion | +envelope? | null | — |
| `activity.kind ∈ {foraging, working}` | 按 chatting | working | [laptop, +envelope?] | null | — |
| `chatting` | **lit** | idle | +envelope? | null | — |
| `idle` | unlit | idle | +envelope? | null | — |
| 任一行:`news.unread > prev.news.unread` | — | — | — | — | +receive |

「按 chatting」= `activity.kind === 'chatting' ? 'lit' : 'unlit'`(Phase A 先用 presence 的 3 分钟「在聊」窗当微光;Phase B 换成真实 contact 时间)。`envelope` 仅当 `unread > 0`,badge = unread。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/bridge/presence-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { presenceToPet } from './presence-map.js'

const P = (over: Record<string, unknown> = {}) => ({ presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null }, ...over }) as any

describe('presenceToPet(Phase A:只有处境)', () => {
  it('daemon 没起 → unlit sleep + 提示;offline → unlit sleep,道具保留', () => {
    expect(presenceToPet(null, null)).toEqual({ form: 'unlit', behavior: 'sleep', props: [], badge: 0, hint: 'daemon 没起', oneShots: [] })
    expect(presenceToPet(P({ presence: 'down' }), null).hint).toBe('daemon 没起')
    const off = presenceToPet(P({ presence: 'offline', news: { unread: 2, latest_kind: 'hunt', latest_title: 't' } }), null)
    expect(off).toMatchObject({ form: 'unlit', behavior: 'sleep', props: ['envelope'], badge: 2, hint: null })
  })
  it('degraded:开始时播一次 error 并挂 exclamation;持续时不再播', () => {
    const first = presenceToPet(P({ presence: 'degraded' }), P())
    expect(first).toMatchObject({ behavior: 'idle', props: ['exclamation'], oneShots: ['error'] })
    const again = presenceToPet(P({ presence: 'degraded' }), P({ presence: 'degraded' }))
    expect(again.oneShots).toEqual([])
  })
  it('chatting → lit;其它 → unlit;companion / working 的映射;laptop 只在 working', () => {
    expect(presenceToPet(P({ activity: { kind: 'chatting', label: '在跟你聊', since: null } }), null)).toMatchObject({ form: 'lit', behavior: 'idle' })
    for (const k of ['hosting_human', 'visiting', 'hosting_peer']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null).behavior).toBe('companion')
    for (const k of ['foraging', 'working']) expect(presenceToPet(P({ activity: { kind: k, label: '', since: null } }), null)).toMatchObject({ form: 'unlit', behavior: 'working', props: ['laptop'] })
    expect(presenceToPet(P(), null)).toMatchObject({ form: 'unlit', behavior: 'idle', props: [], hint: null })
  })
  it('unread 增加 → oneShots 含 receive;不变 / 减少不含;envelope 带 badge', () => {
    const r = presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 1, latest_kind: 'hunt', latest_title: 'y' } }))
    expect(r).toMatchObject({ props: ['envelope'], badge: 3, oneShots: ['receive'] })
    expect(presenceToPet(P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } }), P({ news: { unread: 3, latest_kind: 'postcard', latest_title: 'x' } })).oneShots).toEqual([])
    expect(presenceToPet(P({ news: { unread: 0, latest_kind: null, latest_title: null } }), P({ news: { unread: 3, latest_kind: 'x', latest_title: 'y' } })).props).toEqual([])
    const both = presenceToPet(P({ presence: 'degraded', news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } }), P())
    expect(both.props).toEqual(['exclamation', 'envelope']); expect(both.oneShots).toEqual(['error', 'receive'])
  })
})
```

`apps/desktop/src/pet/pet.test.ts`(组装的集成测试:假 fetch 给真 manifest,假元素,手动计时器):

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPet } from './pet.js'

const realRaw = readFileSync(join(__dirname, '../assets/pet/manifest.json'), 'utf8')
const fetchReal = (async () => new Response(realRaw, { status: 200 })) as unknown as typeof fetch

function el(tag = 'div') {
  const classes = new Set<string>(); const kids: any[] = []
  return { tag, style: {} as Record<string, string>, src: '', textContent: '', hidden: false, attrs: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { this.attrs[k] = v }, getAttribute(k: string) { return this.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c) }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) }, children: kids }
}
function clock() {
  let now = 0; let seq = 0; const q: Array<{ at: number, id: number, fn: () => void }> = []
  return { schedule: (fn: () => void, ms: number) => { const id = ++seq; q.push({ at: now + ms, id, fn }); return id },
    cancel: (id: unknown) => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1) },
    tick(ms: number) { const until = now + ms; while (true) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > until) break; q.shift(); now = n.at; n.fn() } now = until } }
}
const boot = async (fetchImpl = fetchReal, reducedMotion = false) => {
  const c = clock(); const root = { stage: el(), img: el('img'), props: el(), hint: el('p') }
  const pet = await createPet(root, { manifestUrl: './assets/pet/manifest.json', fetchImpl, reducedMotion, makeEl: el, schedule: c.schedule, cancel: c.cancel, preload: () => {} })
  return { c, root, pet }
}

describe('createPet(组装)', () => {
  it('加载真 manifest:初始 unlit idle 显示 master-unlit;anchor 写到舞台;呼吸开着', async () => {
    const { root, pet } = await boot()
    expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    expect(root.stage.style['--pet-anchor-y']).toBe('91.796875%')
    expect(root.stage.classList.contains('pet-breathing')).toBe(true)
    expect(pet.warnings).toEqual([])
  })
  it('setForm(lit) 播 8 帧转场后停在 lit idle(master-lit);转场中呼吸关', async () => {
    const { c, root, pet } = await boot()
    expect(pet.setForm('lit')).toBe(true)
    expect(root.img.src).toBe('./assets/pet/transitions/unlit-to-lit/000.png')
    expect(root.stage.classList.contains('pet-breathing')).toBe(false)
    c.tick(125 * 8 + 5)
    expect(pet.machine.snapshot().form).toBe('lit')
    expect(root.img.src).toBe('./assets/pet/reference/master-lit.png')
    expect(root.stage.classList.contains('pet-breathing')).toBe(true)
  })
  it('lit 下 working 显示 working 帧 + laptop 道具;done 播一次后回到 working', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setState('working'); pet.setProps(['laptop'])
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
    expect(root.props.children[0].attrs['data-prop']).toBe('laptop')
    pet.setState('done')
    expect(root.img.src).toBe('./assets/pet/states/done/000.png')
    c.tick(260)
    expect(root.img.src).toBe('./assets/pet/states/working/000.png')
  })
  it('unlit 下 working:画面仍是 master-unlit,逻辑状态是 working,warnings 记了回退', async () => {
    const { root, pet } = await boot()
    pet.setState('working')
    expect(pet.machine.snapshot().behavior).toBe('working')
    expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    expect(pet.warnings).toContain('fallback:unlit/working→unlit/idle')
  })
  it('unlit 下一次性行为(receive)没有专属帧:露 600ms 后回落到 idle,不会卡住', async () => {
    const { c, pet } = await boot()
    expect(pet.setState('receive')).toBe('applied')
    expect(pet.machine.snapshot().behavior).toBe('receive')
    c.tick(610)
    expect(pet.machine.snapshot().behavior).toBe('idle')
  })
  it('lit → unlit 走淡出淡入(不倒放):中途 pet-fading,结束后 master-unlit', async () => {
    const { c, root, pet } = await boot()
    pet.setForm('lit'); c.tick(1100)
    pet.setForm('unlit')
    expect(root.img.classList.contains('pet-fading')).toBe(true)
    c.tick(245); expect(root.img.src).toBe('./assets/pet/reference/master-unlit.png')
    c.tick(245); expect(pet.machine.snapshot()).toMatchObject({ form: 'unlit', transition: null })
    expect(pet.warnings).toContain('fallback:transition/lit-to-unlit→fade')
  })
  it('applyIntent:form → props → 持续行为 → oneShots;setHint 控制提示可见', async () => {
    const { c, root, pet } = await boot()
    pet.applyIntent({ form: 'lit', behavior: 'companion', props: ['envelope'], badge: 2, hint: null, oneShots: ['receive'] })
    c.tick(1100)                       // 转场播完
    expect(pet.machine.snapshot()).toMatchObject({ form: 'lit', resting: 'companion' })
    expect(root.props.children[0].attrs['data-prop']).toBe('envelope')
    expect(root.hint.hidden).toBe(true)
    pet.setHint('daemon 没起')
    expect(root.hint.hidden).toBe(false); expect(root.hint.textContent).toBe('daemon 没起')
  })
  it('manifest 加载失败:不抛,显示提示,setState 不崩,warnings 含原因', async () => {
    const fetch404 = (async () => new Response('x', { status: 404 })) as unknown as typeof fetch
    const { root, pet } = await boot(fetch404)
    expect(pet.warnings).toContain('manifest:http_404')
    expect(root.hint.hidden).toBe(false)
    expect(() => pet.setState('working')).not.toThrow()
  })
  it('reducedMotion:不呼吸', async () => {
    const { root } = await boot(fetchReal, true)
    expect(root.stage.classList.contains('pet-breathing')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/bridge/ apps/desktop/src/pet/pet.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 presence-map.js**

```js
// @ts-check
// presence-map.js — presence(处境)→ CC 的意图(spec §5.1 处境部分)。Phase A 先用 presence 的
// 「在聊」(3 分钟入站窗)当微光;Phase B 换成真实 contact 时间与 turn 端点。纯函数。

/** @typedef {import('../../presence-poller.js').Presence} Presence */
/** @typedef {import('../domain/types.js').PetBehavior} PetBehavior */
/** @typedef {{ form: 'unlit' | 'lit', behavior: PetBehavior, props: string[], badge: number, hint: string | null, oneShots: PetBehavior[] }} PetIntent */

const COMPANION_KINDS = new Set(['hosting_human', 'visiting', 'hosting_peer'])
const WORKING_KINDS = new Set(['foraging', 'working'])

/** @param {Presence | null} p */
const unreadOf = (p) => Math.max(0, Math.trunc(Number(p?.news?.unread) || 0))

/**
 * @param {Presence | null} p
 * @param {Presence | null} prev
 * @returns {PetIntent}
 */
export function presenceToPet(p, prev) {
  if (!p || p.presence === 'down') return { form: 'unlit', behavior: 'sleep', props: [], badge: 0, hint: 'daemon 没起', oneShots: [] }
  const unread = unreadOf(p)
  const badge = unread
  /** @type {string[]} */
  const props = []
  /** @type {PetBehavior[]} */
  const oneShots = []
  const envelope = unread > 0 ? ['envelope'] : []
  if (p.presence === 'offline') return { form: 'unlit', behavior: 'sleep', props: envelope, badge, hint: null, oneShots }

  const degraded = p.presence === 'degraded'
  if (degraded) { props.push('exclamation'); if (!prev || prev.presence !== 'degraded') oneShots.push('error') }
  const kind = p.activity?.kind ?? 'idle'
  /** @type {'unlit' | 'lit'} */
  const form = kind === 'chatting' ? 'lit' : 'unlit'
  /** @type {PetBehavior} */
  let behavior = 'idle'
  if (COMPANION_KINDS.has(kind)) behavior = 'companion'
  else if (WORKING_KINDS.has(kind)) { behavior = 'working'; props.push('laptop') }
  props.push(...envelope)
  if (prev && unread > unreadOf(prev)) oneShots.push('receive')
  return { form, behavior, props, badge, hint: null, oneShots }
}
```

- [ ] **Step 4: 实现 pet.js**

```js
// @ts-check
// pet.js — 组装:loader → resolver → state machine → renderer + props(spec §7)。
// 业务代码只认这里导出的语义接口;帧文件名到此为止。
import { loadManifest } from './assets/manifest-loader.js'
import { resolveAnimation, resolveTransition } from './assets/animation-resolver.js'
import { createPetStateMachine } from './domain/state-machine.js'
import { ONE_SHOT } from './domain/types.js'
import { createSpriteRenderer } from './renderer/sprite-renderer.js'
import { renderProps } from './renderer/prop-layer.js'

/** @typedef {import('./bridge/presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./domain/types.js').PetForm} PetForm */

const BREATHING_BEHAVIORS = new Set(['idle', 'working', 'thinking', 'permission', 'companion', 'sleep'])
/** 一次性行为在没有专属帧的形态下(v1 的 unlit)露多久就回落。 */
const ONE_SHOT_FALLBACK_MS = 600

/**
 * @param {{ stage: any, img: any, props: any, hint?: any }} root
 * @param {{ manifestUrl: string, fetchImpl?: typeof fetch, reducedMotion?: boolean, makeEl?: (tag: string) => any, schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void, preload?: (url: string) => void }} opts
 */
export async function createPet(root, opts) {
  const makeEl = opts.makeEl ?? ((tag) => document.createElement(tag))
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((h) => clearTimeout(/** @type {any} */ (h)))
  /** @type {unknown} */ let oneShotTimer = null
  const renderer = createSpriteRenderer({ img: root.img, stage: root.stage, schedule, cancel, preload: opts.preload, reducedMotion: opts.reducedMotion })
  const machine = createPetStateMachine()
  /** @type {string[]} */
  const warnings = []
  const warn = (/** @type {string[]} */ ...ws) => { for (const w of ws) if (!warnings.includes(w)) { warnings.push(w); console.warn('[pet]', w) } }

  const setHint = (/** @type {string | null} */ text) => {
    if (!root.hint) return
    root.hint.textContent = text ?? ''
    root.hint.hidden = !text
  }

  const loaded = await loadManifest(opts.manifestUrl, opts.fetchImpl)
  if (!loaded.ok) {
    warn(`manifest:${loaded.reason}`)
    setHint('桌宠资产没加载出来')
    // 没有 manifest:状态机照常工作(逻辑状态仍真实),只是画不出来
    return { machine, warnings, setState: machine.setState, setForm: machine.setForm, setProps: machine.setProps, applyIntent: () => {}, setHint, beginDrag: machine.beginDrag, endDrag: machine.endDrag, destroy: () => { renderer.stop() } }
  }
  const manifest = loaded.manifest
  warn(...manifest.warnings)
  renderer.applyAnchor(manifest.canvas.anchor)
  setHint(null)

  /** 上一次画的是什么,避免同一快照重复 play */
  let lastKey = ''
  const render = (/** @type {ReturnType<typeof machine.snapshot>} */ s) => {
    renderProps(root.props, s.props, s.badge, manifest, makeEl)
    const key = s.transition ? `t:${s.transition}` : `b:${s.form}/${s.behavior}`
    if (key === lastKey) return
    lastKey = key
    if (s.transition && s.targetForm) {
      renderer.setBreathing(false)
      const t = resolveTransition(manifest, s.transition, s.targetForm)
      warn(...t.warnings)
      if (t.kind === 'frames') renderer.play(t.animation, { onEnd: () => machine.notifyAnimationEnded() })
      else renderer.fadeTo(t.to, { onEnd: () => machine.notifyAnimationEnded() })
      return
    }
    const r = resolveAnimation(manifest, s.form, s.behavior)
    warn(...r.warnings)
    renderer.setBreathing(BREATHING_BEHAVIORS.has(s.behavior))
    const oneShot = ONE_SHOT.has(s.behavior)
    if (oneShot && r.animation.loop) {
      // 一次性行为被 fallback 成了 loop 动画(unlit 下只有 master):renderer 永远不会 onEnd,
      // 这里兜底 —— 露一下就回落,逻辑上这次一次性行为仍然「发生过」。
      renderer.play(r.animation)
      if (oneShotTimer !== null) cancel(oneShotTimer)
      const myKey = key
      oneShotTimer = schedule(() => { oneShotTimer = null; if (lastKey === myKey) machine.notifyAnimationEnded() }, ONE_SHOT_FALLBACK_MS)
      return
    }
    renderer.play(r.animation, { onEnd: oneShot || !r.animation.loop ? () => machine.notifyAnimationEnded() : undefined })
  }
  const off = machine.subscribe(render)
  render(machine.snapshot())

  return {
    machine, warnings,
    setState: machine.setState,
    setForm: machine.setForm,
    setProps: machine.setProps,
    /** @param {PetIntent} intent */
    applyIntent(intent) {
      machine.setForm(intent.form)
      machine.setProps(intent.props, intent.badge)
      machine.setState(intent.behavior)
      for (const b of intent.oneShots) machine.setState(b)
      setHint(intent.hint)
    },
    setHint,
    beginDrag: machine.beginDrag,
    endDrag: machine.endDrag,
    destroy() { off(); renderer.stop(); if (oneShotTimer !== null) cancel(oneShotTimer) },
  }
}
```

- [ ] **Step 5: 重写陪伴窗**

`apps/desktop/src/companion-window.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CC · wechat-cc</title>
    <link rel="stylesheet" href="./companion-window.css" />
  </head>
  <body>
    <main class="pet-shell">
      <section class="pet-stage" id="pet-stage" data-tauri-drag-region aria-label="CC">
        <img class="pet-sprite" id="pet-sprite" alt="" draggable="false" />
        <div class="pet-props" id="pet-props" aria-hidden="true"></div>
      </section>
      <p class="pet-hint" id="pet-hint" hidden></p>
      <div class="pet-controls">
        <button id="pet-zoom-out" type="button" aria-label="缩小">−</button>
        <button id="pet-zoom-in" type="button" aria-label="放大">＋</button>
        <button id="pet-close" type="button" aria-label="关闭桌面陪伴">×</button>
      </div>
    </main>
    <script type="module" src="./companion-window.js"></script>
  </body>
</html>
```

`apps/desktop/src/companion-window.css`:

```css
@font-face { font-family: Geist; src: url("./fonts/geist-variable-latin.woff2") format("woff2"); font-weight: 100 900; }
:root { color-scheme: light; --ink: #5a422f; }
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
body { color: var(--ink); font-family: Geist, "PingFang SC", sans-serif; }
button { font: inherit; }

.pet-shell { position: relative; display: grid; grid-template-rows: 1fr auto; width: 100%; height: 100%; padding: 8px; }
/* 舞台正方形,anchor 用 manifest 给的比例(--pet-anchor-x/y)。主体 img 的底部中线对齐 anchor 点。 */
.pet-stage { position: relative; width: min(100%, calc(100vh - 60px)); aspect-ratio: 1 / 1; margin: 0 auto; cursor: grab; }
.pet-stage:active { cursor: grabbing; }
.pet-sprite { position: absolute; left: 50%; top: 0; width: 100%; height: 100%; transform: translateX(-50%); transform-origin: var(--pet-anchor-x, 50%) var(--pet-anchor-y, 92%); object-fit: contain; pointer-events: none; user-select: none; transition: opacity 240ms ease; }
.pet-sprite.pet-fading { opacity: 0; }
.pet-breathing .pet-sprite { animation: pet-breathe 2.8s ease-in-out infinite; }
@keyframes pet-breathe { 0%, 100% { transform: translateX(-50%) scale(1); } 50% { transform: translateX(-50%) scale(1.02); } }
/* 道具:相对 anchor 点的比例偏移(prop-layer.js 的槽位表),以舞台边长为 1。 */
.pet-props { position: absolute; inset: 0; pointer-events: none; }
.pet-prop { position: absolute; left: calc(var(--pet-anchor-x, 50%) + var(--slot-dx, 0) * 100%); top: calc(var(--pet-anchor-y, 92%) + var(--slot-dy, 0) * 100%); width: calc(var(--slot-scale, .34) * 100%); aspect-ratio: 1 / 1; transform: translate(-50%, -50%); }
.pet-prop img { width: 100%; height: 100%; object-fit: contain; }
.pet-badge { position: absolute; right: 4%; top: 4%; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #d9773b; color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
.pet-hint { margin: 4px 0 0; padding: 4px 8px; border-radius: 999px; background: rgba(255, 253, 247, .86); color: #7b6b5c; font-size: 11px; text-align: center; justify-self: center; }
.pet-controls { position: absolute; right: 6px; top: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity .2s ease; }
.pet-shell:hover .pet-controls, .pet-controls:focus-within { opacity: 1; }
.pet-controls button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: rgba(255, 253, 247, .8); color: rgba(111, 78, 49, .8); cursor: pointer; font-size: 14px; line-height: 22px; }
.pet-controls button:focus-visible { outline: 2px solid #d9773b; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .pet-breathing .pet-sprite { animation: none; } .pet-sprite { transition: opacity 400ms ease; } }
```

`apps/desktop/src/companion-window.js`(取代旧 `companion-window.js` 与 `companion-window-presence.js`):

```js
// @ts-check
// companion-window.js — CC 桌宠窗的胶水:组装 pet,接 presence 轮询,窗口拖动 / 缩放 / 关闭。
// 只调 pet 的语义接口;这里不出现任何帧文件名。
import { createPet } from './pet/pet.js'
import { presenceToPet } from './pet/bridge/presence-map.js'
import { createPresencePoller } from './presence-poller.js'
import { invokeApi } from './api.js'
import { invoke } from './ipc.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
const stage = $('pet-stage'), img = $('pet-sprite'), props = $('pet-props'), hint = $('pet-hint')
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const pet = await createPet({ stage, img, props, hint }, { manifestUrl: './assets/pet/manifest.json', reducedMotion })
if (new URLSearchParams(location.search).has('lab')) /** @type {any} */ (window).__pet = pet

// presence(处境)→ 意图。Phase B 在这里再叠 turn 端点。
/** @type {import('./presence-poller.js').Presence | null} */
let prev = null
const poller = createPresencePoller({ invokeApi, intervalMs: 20_000 })
poller.subscribe(p => { pet.applyIntent(presenceToPet(p, prev)); prev = p })
poller.start()
document.addEventListener('visibilitychange', () => { if (document.hidden) poller.stop(); else { poller.start(); poller.refresh() } })

// 拖动:整只 CC 是 drag-region;按下进 drag,松开回落。
stage?.addEventListener('mousedown', (event) => {
  if (!(event instanceof MouseEvent) || event.button !== 0) return
  event.preventDefault()
  pet.beginDrag()
  invoke('start_companion_drag').catch(console.warn).finally(() => { /* 系统拖动结束后不会有事件回来,用 mouseup/blur 兜底 */ })
})
const endDrag = () => pet.endDrag()
window.addEventListener('mouseup', endDrag)
window.addEventListener('blur', endDrag)
window.addEventListener('focus', endDrag)

$('pet-close')?.addEventListener('click', () => { invoke('close_companion_window').catch(() => window.close()) })
$('pet-zoom-out')?.addEventListener('click', () => invoke('resize_companion_window', { direction: 'out' }).catch(console.warn))
$('pet-zoom-in')?.addEventListener('click', () => invoke('resize_companion_window', { direction: 'in' }).catch(console.warn))
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('pet-close')?.click() })
```

注意:`presence-poller.js` 若没有 `stop()`,加一个(清 interval);其测试文件追加一条「stop 后不再 refresh」。删除 `companion-window-presence.js`;若它有测试文件一并删。**主窗口** (`index.html` / `main.js`) 仍挂旧的鱼缸与 `startCompanionPresence`,本轮不动。

`apps/desktop/src-tauri/src/lib.rs`:`open_companion_window` 里 `.inner_size(280.0, 210.0)` → `(240.0, 300.0)`,`.min_inner_size(280.0, 210.0)` → `(200.0, 250.0)`,`.title("陪伴小世界")` → `.title("CC")`;`resize_companion_window` 的 clamp 改为 `width.clamp(200.0, 600.0)`、`height.clamp(250.0, 750.0)`。

- [ ] **Step 6: 跑测试确认通过 + 全量**

Run: `bun --bun vitest run apps/desktop/ && bun run typecheck && bun run depcheck`
Expected: PASS;`apps/desktop/src/*.test.ts` 中若有引用 `companion-window-presence.js` 的测试随之删除。然后 `bun --bun vitest run` 全量。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/pet apps/desktop/src/companion-window.html apps/desktop/src/companion-window.js apps/desktop/src/companion-window.css apps/desktop/src/presence-poller.js apps/desktop/src/presence-poller.test.ts apps/desktop/src-tauri/src/lib.rs
git rm -q apps/desktop/src/companion-window-presence.js
git commit -m "陪伴窗换成 CC:presence 处境 → 意图 → 状态机 → 精灵;拖动进 drag;窗口 240×300"
```

---

### Task 6: `pet-lab.html` 调试页 + 全量与 cargo check

**Files:**
- Create: `apps/desktop/src/pet-lab.html`、`apps/desktop/src/pet-lab.js`
- Full: `bun run typecheck && bun run depcheck && bun --bun vitest run && (cd apps/desktop/src-tauri && cargo check)`

**Interfaces:**
- Consumes: Task 5 `createPet`、`presenceToPet`;Task 2 `BEHAVIORS` / `PROPS`。

- [ ] **Step 1: 写页面**

`apps/desktop/src/pet-lab.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CC Lab</title>
    <link rel="stylesheet" href="./companion-window.css" />
    <style>
      body { background: #e9e4dc; overflow: auto; }
      .lab { display: grid; grid-template-columns: 260px 1fr; gap: 16px; padding: 16px; }
      .lab .pet-shell { width: 260px; height: 320px; background: rgba(255,255,255,.35); border-radius: 12px; }
      .lab-panel { font-size: 13px; }
      .lab-panel h3 { margin: 10px 0 4px; font-size: 12px; color: #7b6b5c; text-transform: uppercase; letter-spacing: .06em; }
      .lab-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .lab-row button, .lab-row label { padding: 4px 8px; border: 1px solid #c9bfb2; border-radius: 6px; background: #fffdf8; cursor: pointer; }
      .lab-state, .lab-warn { margin-top: 8px; padding: 8px; background: #fffdf8; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div class="lab">
      <main class="pet-shell">
        <section class="pet-stage" id="pet-stage" aria-label="CC">
          <img class="pet-sprite" id="pet-sprite" alt="" draggable="false" />
          <div class="pet-props" id="pet-props" aria-hidden="true"></div>
        </section>
        <p class="pet-hint" id="pet-hint" hidden></p>
      </main>
      <aside class="lab-panel">
        <h3>形态</h3><div class="lab-row" id="lab-forms"></div>
        <h3>行为(13)</h3><div class="lab-row" id="lab-behaviors"></div>
        <h3>道具</h3><div class="lab-row" id="lab-props"></div>
        <h3>假 presence</h3><div class="lab-row" id="lab-presence"></div>
        <h3>选项</h3><div class="lab-row"><label><input type="checkbox" id="lab-reduced" /> reduced motion(需刷新)</label><button id="lab-drag">drag 1 秒</button></div>
        <h3>状态</h3><div class="lab-state" id="lab-state"></div>
        <h3>warnings</h3><div class="lab-warn" id="lab-warn">(无)</div>
      </aside>
    </div>
    <script type="module" src="./pet-lab.js"></script>
  </body>
</html>
```

`apps/desktop/src/pet-lab.js`:

```js
// @ts-check
// pet-lab.js — 调试页:13 个状态、两态、道具、假 presence、reduced motion、warning 列表。不进正式窗口。
import { createPet } from './pet/pet.js'
import { presenceToPet } from './pet/bridge/presence-map.js'
import { BEHAVIORS, PROPS } from './pet/domain/types.js'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const reduced = new URLSearchParams(location.search).has('reduced')
/** @type {HTMLInputElement} */ ($('lab-reduced')).checked = reduced
$('lab-reduced').addEventListener('change', (e) => { location.search = /** @type {HTMLInputElement} */ (e.target).checked ? '?reduced' : '' })

const pet = await createPet({ stage: $('pet-stage'), img: $('pet-sprite'), props: $('pet-props'), hint: $('pet-hint') }, { manifestUrl: './assets/pet/manifest.json', reducedMotion: reduced })
/** @type {any} */ (window).__pet = pet

const btn = (/** @type {string} */ label, /** @type {() => void} */ onClick) => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', onClick); return b }
for (const f of /** @type {const} */ (['unlit', 'lit'])) $('lab-forms').appendChild(btn(f, () => pet.setForm(f)))
for (const b of BEHAVIORS) $('lab-behaviors').appendChild(btn(b, () => { const r = pet.setState(b); console.log('setState', b, r) }))
/** @type {Set<string>} */ const on = new Set()
for (const p of PROPS) {
  const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'
  c.addEventListener('change', () => { c.checked ? on.add(p) : on.delete(p); pet.setProps([...on], on.has('envelope') ? 3 : 0) })
  l.append(c, ` ${p}`); $('lab-props').appendChild(l)
}
/** @type {Record<string, any>} */
const fakes = {
  down: null,
  offline: { presence: 'offline', activity: { kind: 'idle', label: '', since: null }, news: { unread: 2, latest_kind: 'hunt', latest_title: 'x' } },
  degraded: { presence: 'degraded', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  chatting: { presence: 'ok', activity: { kind: 'chatting', label: '在跟你聊', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  working: { presence: 'ok', activity: { kind: 'working', label: '在忙', since: null }, news: { unread: 1, latest_kind: 'postcard', latest_title: 'y' } },
  visiting: { presence: 'ok', activity: { kind: 'visiting', label: '去串门', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  idle: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
}
/** @type {any} */ let prev = null
for (const [name, p] of Object.entries(fakes)) $('lab-presence').appendChild(btn(name, () => { pet.applyIntent(presenceToPet(p, prev)); prev = p }))
$('lab-drag').addEventListener('click', () => { pet.beginDrag(); setTimeout(() => pet.endDrag(), 1000) })

const paint = () => { $('lab-state').textContent = JSON.stringify(pet.machine.snapshot(), null, 1); $('lab-warn').textContent = pet.warnings.length ? pet.warnings.join('\n') : '(无)' }
pet.machine.subscribe(paint); paint(); setInterval(paint, 1000)
```

- [ ] **Step 2: 手动验证清单(记录到报告)**

用 `cd apps/desktop && bun run dev:web` 起静态服务(端口 4174),浏览器开 `http://127.0.0.1:4174/pet-lab.html`,逐项确认并在报告里勾选:
1. 初始 unlit master,呼吸可见;点 `lit` → 8 帧转场 → master-lit。
2. lit 下 13 个按钮各显示对应帧;一次性的播完回 idle。
3. `unlit` 下点 `working` → 画面不变、状态面板 behavior=working、warnings 多一条 fallback。
4. `lit` → `unlit` 淡出淡入。
5. 勾 envelope → 信封 + 角标 3;勾 laptop → 在身前。
6. 假 presence:down 有提示,degraded 播一次 error 并挂叹号,chatting 亮起,working 挂笔记本。
7. `?reduced` 下不呼吸,转场只首末帧。
8. 临时把 `assets/pet/states/working` 改名再刷新 → 点 working 回退到 idle 且不崩,改回来。

- [ ] **Step 3: 全量**

Run: `bun run typecheck && bun run depcheck && bun --bun vitest run && (cd apps/desktop/src-tauri && cargo check)`
Expected: 全绿;cargo check 通过(只改了几个数字与标题)。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/pet-lab.html apps/desktop/src/pet-lab.js
git commit -m "CC Lab:13 个状态、两态、道具、假 presence、reduced motion 与 warnings 一页看全"
```

---

## 完成后

- 真窗口:`bun run dev`(Tauri)→ 主窗点开桌面陪伴 → 看到 CC(unlit sleep + 「daemon 没起」或按 presence 的处境);拖动它;缩放。
- Phase B 的 plan 另写:`GET /v1/companion/pet`、权限两条路由、`runtime-events.js`、权限卡片。
- memory:`cc-pet-phase-a-shipped`。
