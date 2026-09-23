/** Embed approved PNGs so the compiled daemon needs no source checkout. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..')
const pack=resolve(root,'assets/starter-stickers')
const manifest=JSON.parse(readFileSync(resolve(pack,'manifest.json'),'utf8'))
writeFileSync(resolve(root,'src/daemon/cc-starter-pack.json'),JSON.stringify(manifest.map((e: {file:string})=>({...e,png:readFileSync(resolve(pack,e.file)).toString('base64')})))+'\n')
