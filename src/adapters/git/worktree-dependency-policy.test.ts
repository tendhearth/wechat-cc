import { expect, it } from 'vitest'
import { dependencyInstallPlan, publicAddress } from './worktree-dependency-policy'
const integrity = 'sha512-' + 'A'.repeat(86) + '=='
function files(source = 'tool@1.0.0', url = '', sri: unknown = integrity) {
  return new Map([['package.json', Buffer.from('{}')], ['bun.lock', Buffer.from(JSON.stringify({ lockfileVersion: 1, packages: { tool: [source, url, {}, sri] } }))]])
}
it('derives canonical registry downloads from integrity-bound lock entries', () => {
  expect(dependencyInstallPlan(files()).packages[0]).toMatchObject({ url: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz', integrity })
})
it.each(['git+ssh://git@public.example/pkg','git:https://public.example/pkg','github:org/pkg','file:./pkg','link:../pkg','https://public.example/pkg.tgz','http://127.0.0.1/pkg','tool@workspace:../../pkg'])('rejects source %s before installation', source => {
  expect(() => dependencyInstallPlan(files(source))).toThrow()
})
it.each(['https://registry.npmjs.org/tool/-/tool-1.0.0.tgz','https://public.example/archive.tgz','http://public.example/a','https://127.0.0.1/a','https://10.0.0.1/a'])('rejects every explicit tarball URL %s', url => {
  expect(() => dependencyInstallPlan(files('tool@1.0.0', url))).toThrow()
})
it.each([undefined, '', 'sha1-old', 'sha512-short'])('requires sha512 integrity: %s', sri => {
  const input = files(); input.set('bun.lock',Buffer.from(JSON.stringify({lockfileVersion:1,packages:{tool:['tool@1.0.0','',{},sri]}})))
  expect(() => dependencyInstallPlan(input)).toThrow()
})
it.each(['http://registry.example','https://localhost','https://127.0.0.1','https://10.0.0.1','https://172.16.1.1','https://192.168.2.1','https://[::1]','https://user:secret@registry.example','https://registry.example/?secret=1','https://registry.local'])('rejects unsafe committed registry %s', registry => {
  const input = files(); input.set('.npmrc',Buffer.from(`registry=${registry}`))
  expect(() => dependencyInstallPlan(input)).toThrow()
})
it('uses only explicitly configured public https registries including scopes', () => {
  const input = files(); input.set('.npmrc',Buffer.from('registry=https://packages.example.org/npm/'))
  expect(dependencyInstallPlan(input).packages[0]!.url).toBe('https://packages.example.org/npm/tool/-/tool-1.0.0.tgz')
  input.delete('.npmrc'); input.set('bunfig.toml',Buffer.from('[install]\nregistry="https://packages.example.org/npm/"'))
  expect(dependencyInstallPlan(input).packages[0]!.url).toContain('https://packages.example.org/npm/')
})
it('refuses the whole plan when only one transitive source is unsafe', () => {
  const input = files(); const lock = JSON.parse(input.get('bun.lock')!.toString()); lock.packages.extra = ['extra@git+ssh://git@public.example/a']; input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(() => dependencyInstallPlan(input)).toThrow()
})
it.each(['0.0.0.0','10.1.2.3','127.0.0.1','100.64.0.1','169.254.0.1','172.31.1.1','192.168.1.1','198.19.0.1','224.0.0.1','::ffff:127.0.0.1','2001:db8::1'])('rejects nonpublic DNS answer %s', address => expect(publicAddress(address)).toBe(false))
it.each(['package-lock.json','yarn.lock','pnpm-lock.yaml','pkg/bun.lock'])('refuses mixed locks as a whole: %s',path=>{
  const input=files();input.set(path,Buffer.from('git+ssh://git@public.example/unsafe'))
  expect(()=>dependencyInstallPlan(input)).toThrow('dependency_lock_unsupported')
})
it.each(['overrides','catalog','catalogs'])('checks top-level lock %s sources',field=>{
  const input=files(),lock=JSON.parse(input.get('bun.lock')!.toString());lock[field]={tool:'git+ssh://git@public.example/unsafe'};input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(()=>dependencyInstallPlan(input)).toThrow('dependency_source_policy')
})
it('accepts tilde ranges and ignores dependency map key order in frozen comparison',()=>{
  const input=files(),lock=JSON.parse(input.get('bun.lock')!.toString())
  lock.packages.extra=['extra@1.0.0','',{},integrity];lock.workspaces={'':{dependencies:{extra:'~1.0.0',tool:'~1.0.0'}}}
  input.set('package.json',Buffer.from(JSON.stringify({dependencies:{tool:'~1.0.0',extra:'~1.0.0'}})));input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(dependencyInstallPlan(input).packages).toHaveLength(2)
})
it('skips incompatible optional platforms only after validating all their sources',()=>{
  const input=files(),lock=JSON.parse(input.get('bun.lock')!.toString())
  lock.packages.other=['other@1.0.0','',{os:'!'+process.platform},integrity];lock.workspaces={'':{optionalDependencies:{other:'1.0.0'}}}
  input.set('package.json',Buffer.from(JSON.stringify({optionalDependencies:{other:'1.0.0'}})));input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(dependencyInstallPlan(input).packages.map(p=>p.name)).toEqual(['tool'])
  lock.packages.other[0]='other@git+ssh://git@public.example/a';input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(()=>dependencyInstallPlan(input)).toThrow('dependency_source_policy')
})
it('refuses a platform exclusion that would leave a required dependency missing',()=>{
  const input=files(),lock=JSON.parse(input.get('bun.lock')!.toString())
  lock.packages.tool[2]={cpu:'!'+process.arch};lock.workspaces={'':{dependencies:{tool:'1.0.0'}}}
  input.set('package.json',Buffer.from(JSON.stringify({dependencies:{tool:'1.0.0'}})));input.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  expect(()=>dependencyInstallPlan(input)).toThrow('dependency_required_missing')
})
it('rejects extra resolution fields in workspace tuples',()=>{
  const input=files();input.set('pkg/package.json',Buffer.from('{}'))
  input.set('bun.lock',Buffer.from(JSON.stringify({lockfileVersion:1,packages:{tool:['tool@workspace:pkg','git+ssh://git@public.example/a']}})))
  expect(()=>dependencyInstallPlan(input)).toThrow('dependency_lock_unsupported')
})
