import {canonicalProject} from './artifacts'

export function validateProjectRegistration(input:{path:string;name?:string;providerId?:string},checkProvider?:()=>void):string {
  if(typeof input.path!=='string'||input.path.length>4096||(checkProvider&&typeof input.providerId!=='string')||(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)))throw Error('invalid_request')
  checkProvider?.()
  return canonicalProject(input.path)
}
