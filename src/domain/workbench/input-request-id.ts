/**
 * 「补一句」/ 说一句的 requestId 规矩(架构终态 E5,从 adapters/store/workbench/live-inputs.ts 搬来):只认 UUID 形状,
 * 统一成小写;不是 ⇒ invalid_request。纯函数。
 */
export function normalizeInputRequestId(value:unknown):string{
  if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw Error('invalid_request')
  return value.toLowerCase()
}
