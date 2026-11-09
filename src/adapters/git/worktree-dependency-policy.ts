import { isDeepStrictEqual } from 'node:util'
import { isIP } from 'node:net'
import { parse as parseToml } from 'smol-toml'

export interface RegistryPackage { path: string; name: string; version: string; url: string; integrity: string; unpackedSize?: number; fileCount?: number }
export interface InstallPlan { packages: RegistryPackage[]; workspaces: { path: string; target: string }[] }
export function parseLock(text: string): Record<string, any> {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, s => s.startsWith('"') ? s : '')
    .replace(/"(?:[^"\\]|\\.)*"|,\s*([}\]])/g, (s, close: string | undefined) => close ?? s))
}
/** Deliberately conservative: only globally routable IPv4 and ordinary DNS names. */
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a = 0, b = 0] = address.split('.').map(Number)
  return !([0,10,127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0,2,168].includes(b)) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0))
}
function registry(value: unknown): string {
  if (typeof value !== 'string') throw Error('dependency_registry_policy')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
    /[%\\]/.test(value) || (isIP(url.hostname) ? !publicAddress(url.hostname) :
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) || /\.(?:localhost|local|internal|lan|home|test|invalid)$/i.test(url.hostname))) throw Error('dependency_registry_policy')
  return url.href.replace(/\/?$/, '/')
}
/** Conservative caseless identity, independent of the host filesystem/locale.
 * Decompose first; map each code point to avoid contextual final-sigma casing.
 * Lower then upper also unifies sharp-s/SS, sigma variants and ligatures. This
 * intentionally folds more than Unicode default casefold (e.g. dotless i/I).
 * Win32 suffix aliases share a key, but unsafe original spellings stay rejected.
 */
export function dependencyPathIdentity(part: string): string {
  return Array.from(part.normalize('NFD'), c => c.toLowerCase().toUpperCase()).join('').normalize('NFC').replace(/[. ]+$/, '')
}
/** Portable components: reject Win32 and HFS+ aliases even on other hosts. */
export function dependencySafePart(part: string): boolean {
  const identity = dependencyPathIdentity(part), base = identity.split('.')[0]!.replace(/ +$/, '')
  // '~' may name a generated Win32 8.3 alias of another directory.
  return !!identity && identity !== '.GIT' && !/[\\/\x00-\x1f:<>"|?*~]/.test(part) && !/[. ]$/.test(part) &&
    !/\p{Default_Ignorable_Code_Point}/u.test(part) &&
    !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])$/.test(base)
}
/** Register explicit entries and every implicit parent before any writes.
 * Exact parent reuse is allowed; aliases, duplicate declarations and type
 * conflicts are rejected, including an explicit directory followed by a file.
 */
export class DependencyPathNamespace {
  private names = new Map<string, { path: string; directory: boolean; declared: boolean }>()
  constructor(private error = 'dependency_archive_path') {}
  add(path: string, directory: boolean): void {
    const parts = path ? path.split('/') : []
    if (parts.some(p => !dependencySafePart(p))) throw Error(this.error)
    const identities = parts.map(dependencyPathIdentity)
    for (let depth = 0; depth <= parts.length; depth++) {
      const original = parts.slice(0, depth).join('/'), identity = identities.slice(0, depth).join('/')
      const declared = depth === parts.length, isDirectory = !declared || directory, previous = this.names.get(identity)
      if (previous && (previous.path !== original || previous.directory !== isDirectory || declared && previous.declared)) throw Error(this.error)
      this.names.set(identity, { path: original, directory: isDirectory, declared: declared || !!previous?.declared })
    }
  }
}
function platformMatches(value: unknown, platform: string): boolean {
  if (value === undefined) return true
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw Error('dependency_platform_unsupported')
  return !values.includes('!' + platform) && (!values.some(v => !v.startsWith('!')) || values.includes(platform) || values.includes('*'))
}
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
function location(key: string): string {
  const parts = key.match(/(?:@[^/]+\/)?[^/]+/g) ?? []
  if (parts.join('/') !== key || !parts.length || parts.some(p => !packageName.test(p) || dependencyPathIdentity(p) === 'NODE_MODULES' || p.split('/').some(p => !dependencySafePart(p)))) throw Error('dependency_lock_layout')
  return parts.map(p => `node_modules/${p}`).join('/')
}
const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies','overrides','resolutions','patchedDependencies','catalog','catalogs']
function sources(value: unknown): void {
  if (typeof value === 'string') {
    if (/(?:https?:|git(?:\+[^:]+)?:|ssh:|github:|gitlab:|bitbucket:|file:|link:|portal:|patch:|[\\/]|@.*:)/i.test(value.replace(/^npm:(?:@[^/]+\/)?[^@]+@/, '')) || /^\./.test(value) || /^~(?![0-9])/.test(value)) throw Error('dependency_source_policy')
  } else if (value && typeof value === 'object') for (const item of Object.values(value)) sources(item)
}
/** Every source is checked before any download. Unsupported lock/config forms miss as a whole. */
export function dependencyInstallPlan(files: Map<string, Buffer>): InstallPlan {
  if (!files.has('package.json') || !files.has('bun.lock')) throw Error('dependency_lock_unsupported')
  const registries = new Map<string, string>([['', 'https://registry.npmjs.org/']])
  const npmrc = files.get('.npmrc')?.toString()
  if (npmrc) for (const line of npmrc.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^[#;]/.test(s))) {
    const m = /^(?:(@[a-z0-9._-]+):)?registry\s*=\s*(\S+)$/i.exec(line)
    if (!m) throw Error('dependency_registry_config_unsupported')
    registries.set(m[1] ?? '', registry(m[2]))
  }
  const bunfig = files.get('bunfig.toml')
  if (bunfig) {
    const config = parseToml(bunfig.toString()) as any
    if (Object.keys(config).some(k => k !== 'install') || Object.keys(config.install ?? {}).some(k => !['registry','scopes'].includes(k))) throw Error('dependency_registry_config_unsupported')
    if (config.install?.registry) registries.set('', registry(config.install.registry))
    for (const [scope, value] of Object.entries(config.install?.scopes ?? {})) registries.set('@' + scope.replace(/^@/, ''), registry(value))
  }
  const lock = parseLock(files.get('bun.lock')!.toString())
  if (!lock || lock.lockfileVersion !== 1 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw Error('dependency_lock_unsupported')
  for (const field of fields) if (lock[field]) sources(lock[field])
  for (const [path, manifest] of Object.entries(lock.workspaces ?? {}) as [string, any][]) {
    if (path && (!files.has(path + '/package.json') || path.split('/').some(p => !dependencySafePart(p) || dependencyPathIdentity(p) === 'NODE_MODULES'))) throw Error('dependency_workspace_policy')
    for (const field of fields) if (manifest[field]) sources(manifest[field])
  }
  if ([...files.keys()].some(path => /(?:^|\/)(?:bun\.lockb|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path) || path.endsWith('/bun.lock'))) throw Error('dependency_lock_unsupported')
  for (const [path, bytes] of files) if (path === 'package.json' || path.endsWith('/package.json')) {
    const manifest = JSON.parse(bytes.toString())
    for (const field of fields) if (manifest[field]) sources(manifest[field])
    if (manifest.workspaces && (!Array.isArray(manifest.workspaces) || manifest.workspaces.some((p: unknown) => typeof p !== 'string' || /(?:^|\/)\.\.(?:\/|$)|^[/.~]|\\|:/.test(p)))) throw Error('dependency_workspace_policy')
    const workspace = path === 'package.json' ? '' : path.slice(0, -13)
    for (const field of fields) {
      if (!isDeepStrictEqual(manifest[field] ?? {}, lock.workspaces?.[workspace]?.[field] ?? {})) throw Error('dependency_frozen_mismatch')
    }
  }
  const plan: InstallPlan = { packages: [], workspaces: [] }, selected = new Set<string>()
  for (const [key, tuple] of Object.entries(lock.packages)) {
    const path = location(key)
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') throw Error('dependency_lock_unsupported')
    const workspace = /^(.+)@workspace:([a-z0-9_/-]+)$/i.exec(tuple[0])
    if (workspace) {
      if (tuple.length !== 1) throw Error('dependency_lock_unsupported')
      const target = workspace[2]!
      if (target.split('/').some(p => !dependencySafePart(p) || dependencyPathIdentity(p) === 'NODE_MODULES') || !files.has(target + '/package.json') || !packageName.test(workspace[1]!)) throw Error('dependency_workspace_policy')
      plan.workspaces.push({ path, target }); selected.add(key); continue
    }
    const match = /^((?:@[^/]+\/)?[^@]+)@(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?)$/i.exec(tuple[0])
    if (!match || !packageName.test(match[1]!) || tuple.length !== 4 || typeof tuple[1] !== 'string' || !tuple[2] || typeof tuple[2] !== 'object' || Array.isArray(tuple[2]) ||
      typeof tuple[3] !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(tuple[3])) throw Error('dependency_source_policy')
    const name = match[1]!, version = match[2]!, meta = tuple[2]
    if (meta.bundled || meta.binDir) throw Error('dependency_package_unsupported')
    for (const field of fields) if (meta[field]) sources(meta[field])
    const base = registries.get(name.startsWith('@') ? name.split('/')[0]! : '') ?? registries.get('')!
    // A registry base is supported; arbitrary tarball URLs (even https) are not.
    if (tuple[1]) throw Error('dependency_source_policy')
    for (const field of ['unpackedSize','fileCount']) if (meta[field] !== undefined && (!Number.isSafeInteger(meta[field]) || meta[field] < 0)) throw Error('dependency_size_policy')
    if (!platformMatches(meta.os, process.platform) || !platformMatches(meta.cpu, process.arch)) continue
    if (meta.libc !== undefined) throw Error('dependency_platform_unsupported')
    selected.add(key)
    plan.packages.push({ path, name, version, integrity: tuple[3], url: `${base}${name}/-/${name.split('/').at(-1)}-${version}.tgz`, unpackedSize: meta.unpackedSize, fileCount: meta.fileCount })
  }
  // A skipped optional platform package must never hide a missing required
  // dependency. Verify resolution using the physical locations recorded by Bun.
  const checkRequired = (manifest: Record<string, any>, context: string, dev: boolean) => {
    const required = { ...manifest.dependencies, ...(dev ? manifest.devDependencies : {}) }
    const parents = context.match(/(?:@[^/]+\/)?[^/]+/g) ?? []
    for (const name of Object.keys(required)) {
      if (manifest.optionalDependencies?.[name] !== undefined) continue
      if (!packageName.test(name)) throw Error('dependency_lock_layout')
      if (!Array.from({ length: parents.length + 1 }, (_, i) => [...parents.slice(0, parents.length - i), name].join('/')).some(key => selected.has(key))) throw Error('dependency_required_missing')
    }
  }
  for (const key of selected) {
    const tuple = lock.packages[key]
    if (!String(tuple[0]).includes('@workspace:')) checkRequired(tuple[2], key, false)
  }
  for (const [path, manifest] of Object.entries(lock.workspaces ?? {}) as [string, Record<string, any>][]) {
    const key = path ? Object.keys(lock.packages).find(key => lock.packages[key][0] === `${manifest.name}@workspace:${path}`) : ''
    if (key === undefined && Object.keys(manifest.dependencies ?? {}).length) throw Error('dependency_lock_layout')
    checkRequired(manifest, key ?? '', true)
  }
  const anchors = plan.workspaces.map(workspace => ({ ...workspace })).sort((a, b) => b.path.length - a.path.length)
  const relocate = (path: string) => {
    const anchor = anchors.find(workspace => path.startsWith(workspace.path + '/'))
    return anchor ? anchor.target + path.slice(anchor.path.length) : path
  }
  for (const pkg of plan.packages) pkg.path = relocate(pkg.path)
  for (const workspace of plan.workspaces) workspace.path = relocate(workspace.path)
  const namespace = new DependencyPathNamespace('dependency_lock_layout')
  for (const pkg of [...plan.packages, ...plan.workspaces]) namespace.add(pkg.path, true)
  return plan
}
