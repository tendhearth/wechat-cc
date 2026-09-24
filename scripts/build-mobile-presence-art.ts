import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

// Embed exact frozen assets so compiled sidecars and tunnel pages need no checkout.
const art=Object.fromEntries(['lit','unlit'].map(form=>{
  const path=`apps/desktop/src/assets/pet/cc-v1/canonical/${form}/front.png`
  const bytes=readFileSync(new URL(`../${path}`,import.meta.url))
  return [form,{source:path,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}]
}))
writeFileSync(new URL('../src/daemon/mobile-presence-art.json',import.meta.url),JSON.stringify(art)+'\n')
