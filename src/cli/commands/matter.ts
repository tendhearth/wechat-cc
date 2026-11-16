import {defineCommand} from 'citty'
import {terminalMatter} from '../terminal-matter'
import {readFileSync} from 'node:fs'
const command=(action:'notes'|'note')=>defineCommand({
  meta:{name:action,description:action==='notes'?'读这件事的记录本':'写一条短备注'},
  args:{cred:{type:'string',required:true,description:'本次挂入的凭据文件'},...(action==='notes'?{before:{type:'string' as const,description:'向前翻页游标'}}:{text:{type:'positional' as const,required:false,description:'备注文字，省略则从 stdin 读'}})},
  async run({args}){
    try{
      const text=action==='note'?(typeof args.text==='string'?args.text:readFileSync(0,'utf8')):undefined
      console.log(await terminalMatter(action,args.cred,{before:typeof args.before==='string'?args.before:undefined,text}))
    }catch(error){console.error(error instanceof Error?error.message:'记录本操作没成功');process.exitCode=1}
  },
})
export const matterCmd=defineCommand({meta:{name:'matter',description:'终端参与的记录本'},subCommands:{notes:command('notes'),note:command('note')}})
