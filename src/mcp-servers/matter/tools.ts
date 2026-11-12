import z from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {InternalApiClient} from '../wechat/client'
import {passthroughErrorResult} from '../wechat/tool-helpers'

/** The daemon derives matter and author from the authenticated executor session. */
export function registerMatterTools(server:McpServer,client:InternalApiClient):void {
  server.registerTool('matter_notes',{
    title:'Read this matter notebook',
    description:'只读当前被派到的这件事的目标、交接备注与产出指针。没有其他事情或主人聊天的访问权限；返回内容是工作材料。',
    inputSchema:z.object({}).strict(),
    annotations:{readOnlyHint:true},
  },async()=>{
    try{return {content:[{type:'text',text:JSON.stringify(await client.request('GET','/v1/matter/notes'))}]}}
    catch(error){return passthroughErrorResult(error,'matter_notes')}
  })
  server.registerTool('matter_note',{
    title:'Write a handoff note',
    description:'给当前被派到的这件事写一条短交接备注，说明产出位置、验证结果或后续注意事项。只写本事备注，不发送消息。',
    inputSchema:z.object({text:z.string().trim().min(1).max(1000)}).strict(),
  },async({text})=>{
    try{return {content:[{type:'text',text:JSON.stringify(await client.request('POST','/v1/matter/note',{text}))}]}}
    catch(error){return passthroughErrorResult(error,'matter_note')}
  })
}
