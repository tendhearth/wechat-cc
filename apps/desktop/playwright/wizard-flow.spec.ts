import {test,expect} from './fixtures'
const report=(overrides:Record<string,unknown>={})=>({runtime:'compiled-bundle',ready:false,stateDir:'/tmp/cc-wizard-test',checks:{bun:{ok:true,path:'bundled'},git:{ok:true,path:'unused'},claude:{ok:true,path:'/mock/claude'},codex:{ok:true,path:'/mock/codex'},cursor:{ok:false,apiKeySet:false,sdkInstalled:false},accounts:{ok:false,count:0,items:[]},access:{ok:false,dmPolicy:'allowlist',allowFromCount:0},provider:{ok:true,provider:'claude',binaryPath:'/mock/claude'},daemon:{alive:false,pid:null},service:{installed:false,kind:'launchd'},...overrides}})
async function boot(page:any,shim:any,shimUrl:string,doctor=report()){
  await shim.invoke('demo.seed')
  await shim.invoke('mock.doctor',{report:doctor})
  await page.route('**/__invoke',async (route:any)=>{
    const body=route.request().postDataJSON()
    if(body.command==='wechat_cli_json'&&body.args?.args?.[0]==='provider'&&body.args.args[1]==='show')await route.fulfill({json:{result:{provider:'claude',unattended:false,autoStart:false}}})
    else await route.fallback()
  })
  await page.goto(shimUrl)
  await page.waitForFunction(()=>document.documentElement.dataset.mode==='wizard')
}
test('first setup reaches AI choice, waits for saving, and keeps the old choice on failure',async({page,shim,shimUrl})=>{
  await boot(page,shim,shimUrl)
  await expect(page.locator('#screen-provider')).toBeVisible()
  let resolve!:(value:unknown)=>void
  const pending=new Promise(r=>{resolve=r})
  await page.route('**/__invoke',async route=>{
    const body=route.request().postDataJSON()
    if(body.command==='wechat_cli_text'&&body.args.args[0]==='provider'&&body.args.args[2]==='codex'){
      await pending;await route.fulfill({json:{error:'test connection failed'}})
    }else await route.continue()
  })
  await page.locator('.agent[data-provider=codex]').click()
  await expect(page.locator('#continue-wechat')).toBeDisabled()
  resolve(null)
  await expect(page.locator('#provider-error')).toContainText('没能保存')
  await expect(page.locator('.agent[data-provider=claude]')).toHaveClass(/selected/)
  await expect(page.locator('.agent[data-provider=codex]')).not.toHaveClass(/selected/)
  await expect(page.locator('#continue-wechat')).toBeEnabled()
})
test('QR refresh clears success before waiting, shows failure, and retries with a fresh code',async({page,shim,shimUrl})=>{
  await boot(page,shim,shimUrl)
  // The preceding AI choice is deliberate and reusable when coming back.
  await page.locator('#continue-wechat').click()
  await expect(page.locator('#qr-title')).toContainText('连接成功',{timeout:10000})
  await expect(page.locator('#qr-message')).toBeVisible()
  let broken=true
  await page.route('**/__invoke',async route=>{
    const body=route.request().postDataJSON()
    if(body.command==='wechat_cli_json'&&body.args.args[0]==='setup'&&broken)await route.fulfill({json:{error:'test QR generation failed'}})
    else await route.continue()
  })
  await page.locator('#qr-refresh').click()
  await expect(page.locator('#continue-service')).toBeDisabled()
  await expect(page.locator('#qr-message')).toBeVisible()
  await expect(page.locator('#qr-title')).toContainText('没能生成')
  broken=false;await page.locator('#qr-refresh').click()
  await expect(page.locator('#qr-title')).toContainText('连接成功',{timeout:10000})
  await page.locator('#wechat-back').click()
  await expect(page.locator('#screen-provider')).toBeVisible()
  await page.locator('#continue-wechat').click()
  await expect(page.locator('#continue-service')).toBeDisabled()
  await expect(page.locator('#qr-box')).toBeVisible()
  await expect(page.locator('#qr-title')).toContainText('用微信扫一扫')
})
test('service step keeps checking and enables entering after a late start',async({page,shim,shimUrl})=>{
  await boot(page,shim,shimUrl,report({accounts:{ok:true,count:1,items:[]}}))
  await expect(page.locator('#screen-service')).toBeVisible()
  await expect(page.locator('#enter-dashboard')).toBeDisabled()
  await shim.invoke('mock.doctor',{report:report({accounts:{ok:true,count:1,items:[]},daemon:{alive:true,pid:123}})})
  await expect(page.locator('#enter-dashboard')).toBeEnabled({timeout:9000})
})

test('late environment recheck cannot interrupt the new scan after leaving the doctor page',async({page,shim,shimUrl})=>{
  await boot(page,shim,shimUrl)
  await page.locator('#provider-back').click()
  let resolve!:(value:unknown)=>void
  const pending=new Promise(r=>{resolve=r})
  await page.route('**/__invoke',async route=>{
    const body=route.request().postDataJSON()
    if(body.command==='wechat_cli_json'&&body.args?.args?.[0]==='doctor'){
      await pending;await route.fulfill({json:{result:report()}})
    }else await route.fallback()
  })
  await page.locator('#recheck-env').click()
  await page.locator('#continue-provider').click()
  await page.locator('#continue-wechat').click()
  await expect(page.locator('#screen-wechat')).toBeVisible()
  resolve(null)
  await expect(page.locator('#qr-title')).toContainText('连接成功',{timeout:10000})
  await expect(page.locator('#screen-provider')).toBeHidden()
})
