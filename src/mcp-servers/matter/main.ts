import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {createInternalApiClient} from '../wechat/client'
import {registerMatterTools} from './tools'

const baseUrl=process.env.WECHAT_INTERNAL_API,token=process.env.WECHAT_SESSION_TOKEN
// A task never falls back to the daemon-wide file credential.
if(!baseUrl||!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)||!token?.trim()){
  process.stderr.write('[matter-mcp] a loopback API and bound session token are required\n')
  process.exit(2)
}
const server=new McpServer({name:'matter-mcp',version:'0.1.0'},{capabilities:{tools:{}}})
registerMatterTools(server,createInternalApiClient({baseUrl,tokenFilePath:''}))
await server.connect(new StdioServerTransport())
