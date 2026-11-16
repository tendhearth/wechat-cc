import z from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {InternalApiClient} from './client'
import {passthroughErrorResult} from './tool-helpers'
export function registerTerminalParticipationTools(server:McpServer,client:InternalApiClient){
  const matter=z.string().regex(/^[a-f0-9]{8}$/)
  server.registerTool('terminal_attach',{
    title:'把终端会话挂进一件事',
    description:'【主人当前对话】把主人已开的终端会话挂到 matter。sessionId 完整 ID 或 code 短码二选一；歧义先问主人。系统先请主人确认会话码、目录和事名。成功后必须把 instructions 原样转给主人，供主人粘贴到终端；只接记录本，不启动执行者或自动接力。',
    inputSchema:z.object({sessionId:z.string().min(7).optional(),code:z.string().min(4).optional(),matter}).strict(),
  },async input=>{
    try{return {content:[{type:'text',text:JSON.stringify(await client.request('POST','/v1/cli/attach',input))}]}}catch(e){return passthroughErrorResult(e,'terminal_attach')}
  })
  server.registerTool('terminal_detach',{
    title:'从这件事摘下终端',description:'【主人当前对话】participationId 或 matter 二选一。先请主人确认；摘下只撤销记录本访问，不停止终端。',
    inputSchema:z.object({participationId:z.string().min(1).optional(),matter:matter.optional()}).strict(),
  },async input=>{
    try{return {content:[{type:'text',text:JSON.stringify(await client.request('POST','/v1/cli/detach',input))}]}}catch(e){return passthroughErrorResult(e,'terminal_detach')}
  })
}
