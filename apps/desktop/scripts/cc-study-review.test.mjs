import { test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshOutput, previewHtml } from './cc-study-review.mjs'
import { propRect, SCENES, buildCompositionStudies, isCompositionPropSource } from './build-cc-composition-studies.mjs'

test('review outputs reject both overlap directions, symlink aliases and occupied folders',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cc-review-'))
  try{
    const input=join(root,'input');await mkdir(input);await writeFile(join(input,'asset'),'original')
    for(const out of [root,input,join(input,'nested')])await expect(freshOutput(out,[input])).rejects.toThrow(/overlap/)
    const alias=join(root,'alias');await symlink(input,alias)
    await expect(freshOutput(join(alias,'nested'),[input])).rejects.toThrow(/overlap/)
    const occupied=join(root,'occupied');await mkdir(occupied);await writeFile(join(occupied,'keep'),'keep')
    await expect(freshOutput(occupied,[input])).rejects.toThrow(/empty/)
    expect(await freshOutput(join(root,'new'),[input])).toBe(join(await realpath(root),'new'))
  }finally{await rm(root,{recursive:true,force:true})}
})
test('composition refuses missing and digest-corrupt source PNGs before creating output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cc-scene-bad-'))
  try{
    const kit=join(root,'kit'),output=join(root,'out');await mkdir(kit);await mkdir(join(root,'props'))
    const manifest=await readFile(new URL('../src/assets/pet/cc-v1/manifest.json',import.meta.url))
    await writeFile(join(kit,'manifest.json'),manifest)
    await expect(buildCompositionStudies({kitPath:kit,outputPath:output})).rejects.toThrow(/ENOENT/)
    await mkdir(join(kit,'motion/lit/working'),{recursive:true});await writeFile(join(kit,'motion/lit/working/000.png'),'corrupted')
    await expect(buildCompositionStudies({kitPath:kit,outputPath:output})).rejects.toThrow(/digest/)
    await expect(access(output)).rejects.toThrow()
  }finally{await rm(root,{recursive:true,force:true})}
})
test('props use actual anchor-relative centered CSS slots with explicit overflow',()=>{
  for(const size of [48,96,128,256]){
    const r=propRect('laptop',size)
    expect(r.left/size).toBeCloseTo(.5+.01-.34/2)
    expect(r.top/size).toBeCloseTo(470/512-.04-.34/2)
    expect((r.top+r.height)/size).toBeGreaterThan(1)
  }
  expect(()=>propRect('unknown',128)).toThrow(/prop/)
  expect(SCENES).toHaveLength(5);expect(SCENES.every(s=>s.badge===0)).toBe(true)
})
test('portable preview embeds frames, escapes text and exposes motion lifecycle controls',()=>{
  const html=previewHtml([{id:'safe',title:'<study>',fps:8,loop:true,posterIndex:0,frames:['data:image/png;base64,AAAA']}],'CC study')
  expect(html).toContain('&lt;study&gt;');expect(html).toContain("connect-src 'none'")
  expect(html).toContain('visibilitychange');expect(html).toContain('prefers-reduced-motion')
  expect(html).toContain('requestAnimationFrame');expect(html).toContain('data-frame=')
  expect(html).not.toMatch(/src="https?:|fetch\(|WebSocket/)
})
test('only the provenance-backed micro-light revision can join reviewed source props as a candidate',()=>{
  const digest='a'.repeat(64),entry={kind:'prop',artStatus:'production-candidate',sha256:digest,generation:{schemaVersion:1,artStatus:'production-candidate',pngSha256:digest,glowRadius:28,samples:96,seed:11,bodySha256:'b'.repeat(64),scriptSha256:'c'.repeat(64),adapterSha256:'d'.repeat(64)},previousVersions:[{sha256:'e'.repeat(64),kind:'prop',artStatus:'reviewed-production'}]}
  expect(isCompositionPropSource('../props/micro-light.png',entry)).toBe(true)
  expect(isCompositionPropSource('../props/mug.png',{kind:'prop',artStatus:'reviewed-production'})).toBe(true)
  for(const [path,mutate] of [['../props/mug.png',e=>{}],['../props/micro-light.png',e=>{delete e.generation}],['../props/micro-light.png',e=>{e.generation.pngSha256='f'.repeat(64)}],['../props/micro-light.png',e=>{e.previousVersions=[]}],['../props/micro-light.png',e=>{e.generation.glowRadius=80}]]){const bad=structuredClone(entry);mutate(bad);expect(isCompositionPropSource(path,bad)).toBe(false)}
})
