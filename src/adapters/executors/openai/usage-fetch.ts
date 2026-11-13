import type {FetchLike} from '../../../lib/timeout-fetch'
import {isOfficialModelUrl} from '../../../lib/call-classifier'

// Capability belongs to an endpoint, across sessions/models and all APIModel callers.
const withoutStreamOptions=new Set<string>()
const endpointKey=(input:RequestInfo|URL)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  return `${url.origin}${url.pathname.replace(/\/+$/,'')}`
}
const unsupported=(text:string)=>/stream_options|include_usage/i.test(text)
  &&!/(?:parameter|argument|field)\s+value\b|must be (?:a |an )?(?:boolean|true|false)/i.test(text)
  &&/unrecogni[sz]ed|unknown (?:parameter|argument|field)|unsupported (?:parameter|argument|field|stream_options|include_usage)|unexpected (?:keyword|parameter|argument|field)|extra (?:inputs?|fields?)|not (?:supported|permitted|allowed)|does not support/i.test(text)

/** Observe only the serialized body actually sent. A parameter rejection permits one changed request. */
export function usageFetch(fetch:FetchLike,observe:(bytes:number)=>void,beforeRetry?:(signal:AbortSignal)=>Promise<void>):FetchLike{
  return async(input,init)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url
    // Official clients retain the SDK's serialized request, including errors.
    // Only a user-configured gateway may opt into the compatibility fallback.
    if(isOfficialModelUrl(url)){
      if(typeof init?.body==='string')observe(Buffer.byteLength(init.body))
      return fetch(input,init)
    }
    const key=endpointKey(input)
    const original=typeof init?.body==='string'?init.body:undefined
    const body=original?JSON.parse(original) as Record<string,unknown>:undefined
    const strip=()=>{const next={...body};delete next.stream_options;return JSON.stringify(next)}
    const send=async(serialized:string|undefined)=>{
      init?.signal?.throwIfAborted()
      if(serialized!==undefined)observe(Buffer.byteLength(serialized))
      return fetch(input,serialized===undefined?init:{...init,body:serialized})
    }
    const omitted=withoutStreamOptions.has(key)&&body?.stream_options!==undefined
    const response=await send(omitted?strip():original)
    if(!omitted&&body?.stream_options!==undefined&&[400,422].includes(response.status)&&unsupported(await response.clone().text())){
      withoutStreamOptions.add(key)
      await response.body?.cancel()
      init?.signal?.throwIfAborted()
      await beforeRetry?.(init?.signal??new AbortController().signal)
      return send(strip())
    }
    return response
  }
}
