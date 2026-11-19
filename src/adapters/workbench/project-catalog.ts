import {createHash} from 'node:crypto'
import {basename} from 'node:path'
import {realpathSync,statSync} from 'node:fs'

export interface ProjectCatalogEntry {
  id:string
  name:string
  path:string
  providerId:string|null
  lookupName?:string
}

interface ProjectCatalogInput {
  ownerChatId:string
  registered:Array<{alias:string;path:string}>
  known:Array<{path:string;providerId:string;name?:string}>
  providers:string[]
  defaultProvider?:string
  includeLookupName?:boolean
}

function directory(path:string):{path:string;dev:bigint;ino:bigint;birthtimeNs:bigint}|null {
  try {
    const canonical=realpathSync(path),stat=statSync(canonical,{bigint:true})
    return stat.isDirectory()?{path:canonical,dev:stat.dev,ino:stat.ino,birthtimeNs:stat.birthtimeNs}:null
  } catch { return null }
}

function catalogId(ownerChatId:string,found:NonNullable<ReturnType<typeof directory>>):string {
  const identity=JSON.stringify([ownerChatId,found.path,found.dev.toString(),found.ino.toString(),found.birthtimeNs.toString()])
  return 'p-'+createHash('sha256').update(identity).digest('hex').slice(0,20)
}

/** Resolve the future catalog ID only when the directory can be identified safely. */
export function projectRegistrationId(ownerChatId:string,path:string):string|null {
  const found=directory(path)
  if(!found)return null
  // Some Windows filesystems do not supply an inode. In that case the catalog
  // identity still includes the real path and creation time.
  if(found.ino<=0n&&(process.platform!=='win32'||found.birthtimeNs<=0n))return null
  return catalogId(ownerChatId,found)
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
  const configuredNames=new Map(names)
  for(const known of input.known){
    if(known.name&&!names.has(known.path))names.set(known.path,known.name)
  }
  const candidates=[...input.registered.map(row=>row.path),...input.known.map(row=>row.path)],seen=new Set<string>(),result:ProjectCatalogEntry[]=[]
  for(const candidate of candidates) {
    const found=directory(candidate)
    if(!found||seen.has(found.path))continue
    seen.add(found.path)
    const lookupName=configuredNames.get(found.path)??basename(found.path)
    const name=names.get(found.path)??lookupName
    result.push({
      id:catalogId(input.ownerChatId,found),
      name,
      ...(input.includeLookupName&&lookupName!==name?{lookupName}:{}),
      path:found.path,
      providerId:knownProvider.get(found.path)??fallback,
    })
  }
  return result
}
