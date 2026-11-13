/** Offline MCP subprocess: records transport closure for the spawn-failure regression. */
import {writeFileSync} from 'node:fs'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
writeFileSync(process.argv[2]!+'.pid',String(process.pid))
process.on('SIGTERM',()=>process.exit(0))
process.on('exit',()=>writeFileSync(process.argv[2]!,'closed'))
const server=new McpServer({name:'offline-close-probe',version:'1.0.0'})
server.registerTool('matter_notes',{inputSchema:{}},async()=>({content:[{type:'text',text:'data'}]}))
await server.connect(new StdioServerTransport())
process.stdin.on('end',()=>process.exit(0))
