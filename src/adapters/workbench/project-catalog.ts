import {createHash} from 'node:crypto'
import {basename} from 'node:path'
import {realpathSync,statSync} from 'node:fs'

export interface ProjectCatalogEntry {
  id:string
  name:string
  path:string
  providerId:string|null
}

interface ProjectCatalogInput {
  ownerChatId:string
  registered:Array<{alias:string;path:string}>
  known:Array<{path:string;providerId:string}>
  providers:string[]
  defaultProvider?:string
}

function directory(path:string):{path:string;dev:bigint;ino:bigint;birthtimeNs:bigint}|null {
  try {
    const canonical=realpathSync(path),stat=statSync(canonical,{bigint:true})
    return stat.isDirectory()?{path:canonical,dev:stat.dev,ino:stat.ino,birthtimeNs:stat.birthtimeNs}:null
  } catch { return null }
}

export function makeProjectCatalog(input:ProjectCatalogInput):ProjectCatalogEntry[] {
  const available=new Set(input.providers),knownProvider=new Map<string,string>()
  for(const known of input.known) {
    const found=directory(known.path)
    if(found&&!knownProvider.has(found.path)&&available.has(known.providerId))knownProvider.set(found.path,known.providerId)
  }
  const fallback=input.defaultProvider&&available.has(input.defaultProvider)?input.defaultProvider:(input.providers[0]??null)
  const names=new Map<string,string>()
  for(const registered of input.registered) {
    const found=directory(registered.path)
    if(found&&!names.has(found.path))names.set(found.path,registered.alias)
  }
  const candidates=[...input.registered.map(row=>row.path),...input.known.map(row=>row.path)],seen=new Set<string>(),result:ProjectCatalogEntry[]=[]
  for(const candidate of candidates) {
    const found=directory(candidate)
    if(!found||seen.has(found.path))continue
    seen.add(found.path)
    const identity=JSON.stringify([input.ownerChatId,found.path,found.dev.toString(),found.ino.toString(),found.birthtimeNs.toString()])
    result.push({
      id:'p-'+createHash('sha256').update(identity).digest('hex').slice(0,20),
      name:names.get(found.path)??basename(found.path),
      path:found.path,
      providerId:knownProvider.get(found.path)??fallback,
    })
  }
  return result
}
