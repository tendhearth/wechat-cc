import {join} from 'node:path'
import {test,expect,clickNav} from './fixtures'

// 出生地(2026-10-19):「一起做」每行头像组旁边一个小字形,详情标题下「名字 · 从哪来的」。只画知道的;老的事不画。
const t=(id:string,title:string,providerId:string,origin?:string,agents?:string[])=>({id,title,path:'/demo/blog',providerId,status:'completed',phase:'replied',createdAt:1,updatedAt:Date.now()-60_000,error:null,...(origin?{origin}:{}),...(agents?{agents}:{})})
const tasks=[
  t('a0000001','首页改成两栏','claude','wechat',['claude','codex']),
  t('a0000002','整理周报','codex','desktop'),
  t('a0000003','修登录页的报错','claude','app'),
  t('a0000004','给相册加个搜索','cursor','web'),
  t('a0000005','接着终端里那段重构','claude','cli'),
  t('a0000006','以前的一件事','codex'),
]

test('一起做:出生地字形挨着头像组,读屏念「从哪来的」;老的事不画',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:1280,height:820})
  await shim.invoke('demo.seed',{chat_id:'test_chat',daemonAlive:true})
  await page.route('**/v1/workbench**',async(route:any)=>{
    const url=new URL(route.request().url())
    let json:any={}
    if(url.pathname==='/v1/workbench')json={tasks,projects:[{id:'p-'+'1'.repeat(20),path:'/demo/blog',name:'blog',providerId:'claude'}],providers:[{id:'claude',displayName:'Claude Code'},{id:'codex',displayName:'Codex'},{id:'cursor',displayName:'Cursor'}],defaultProvider:'claude',canWechat:true}
    else if(url.pathname==='/v1/workbench/task'){const task=tasks.find(x=>x.id===url.searchParams.get('id'))??tasks[0]!;json={task,events:[{id:'1',taskId:task.id,kind:'text',text:'改好了，你看看。',createdAt:2}],artifacts:[]}}
    else if(url.pathname==='/v1/workbench/review')json={reviews:[]}
    await route.fulfill({json})
  })
  await page.goto(shimUrl)
  await page.waitForFunction(()=>document.documentElement.dataset.mode && document.documentElement.dataset.mode!=='loading')
  await page.evaluate(()=>{document.documentElement.dataset.mode='dashboard'})
  await clickNav(page,'workbench')
  const row=(id:string)=>page.locator(`.wb-task[data-task-id="${id}"]`)
  await expect(row('a0000001').locator('.th-origin')).toHaveAttribute('aria-label','从微信来的')
  await expect(row('a0000003').locator('.th-origin')).toHaveAttribute('title','从手机 App 来的')
  await expect(row('a0000005').locator('.th-origin')).toHaveAttribute('data-origin','cli')
  await expect(row('a0000006').locator('.th-origin')).toHaveCount(0)
  // 字形在头像组左边、同一行
  const mark=await row('a0000001').locator('.th-origin').boundingBox(),stack=await row('a0000001').locator('.th-agents').boundingBox()
  expect(mark!.x+mark!.width).toBeLessThanOrEqual(stack!.x+1)
  expect(Math.abs((mark!.y+mark!.height/2)-(stack!.y+stack!.height/2))).toBeLessThan(4)
  await row('a0000003').click()
  await expect(page.locator('.wb-task-agents')).toContainText('Claude Code · 从手机 App 来的')
  await expect(page.locator('.wb-task-agents .th-origin')).toHaveAttribute('data-origin','app')
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir){await page.waitForTimeout(700);await page.screenshot({path:join(dir,'origin-desktop-list.png')})}
})
