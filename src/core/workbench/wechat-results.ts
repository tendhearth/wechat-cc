import {createHash} from 'node:crypto'
import type {TaskEvent} from './store'

const PAGE_UTF16_UNITS=3000
const TOKEN=/^r([1-9]\d*)-([a-f0-9]{12})$/

export function resultToken(event:Pick<TaskEvent,'id'|'text'>):string {
  return `r${event.id}-${createHash('sha256').update(event.text).digest('hex').slice(0,12)}`
}

export function resultCommandHelp(taskId:string):string {
  return `正文命令格式不正确。请先发送「任务 ${taskId} 结果」取得可复制的正文命令。`
}

function textPages(text:string):string[] {
  const pages:string[]=[]
  let page=''
  for(const point of text) {
    if(page.length+point.length>PAGE_UTF16_UNITS){pages.push(page);page=''}
    page+=point
  }
  if(page||!pages.length)pages.push(page)
  return pages
}

export function wechatResultPage(input:{taskId:string;events:TaskEvent[];token:string;page:number}):string {
  const parsed=TOKEN.exec(input.token)
  if(!parsed||!Number.isSafeInteger(input.page)||input.page<1)return resultCommandHelp(input.taskId)
  const id=Number(parsed[1]),event=input.events.find(item=>item.id===id&&item.kind==='text')
  if(!event)return `任务 ${input.taskId}：这份正文不存在或不属于这个任务。请重新发送「任务 ${input.taskId} 结果」。`
  if(resultToken(event)!==input.token)return `任务 ${input.taskId}：这份正文内容已经更新，旧分页编号已失效。请重新发送「任务 ${input.taskId} 结果」载入新版本。`
  const pages=textPages(event.text),total=pages.length
  if(input.page>total)return `任务 ${input.taskId}：正文只有 ${total} 页，没有第 ${input.page} 页。`
  const body=pages[input.page-1]!
  const command=(page:number)=>`任务 ${input.taskId} 正文 ${input.token} ${page}`
  const navigation:string[]=[]
  if(input.page>1)navigation.push(`上一页：${command(input.page-1)}`)
  if(input.page<total)navigation.push(`下一页：${command(input.page+1)}`)
  else navigation.push('已到末页。')
  return `任务 ${input.taskId} · 正文 ${input.page}/${total}\n\n${body}\n\n${navigation.join('\n')}`
}
