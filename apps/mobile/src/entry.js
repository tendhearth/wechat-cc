function cConnectionText(){var text=document.getElementById('pres-txt').textContent;document.getElementById('cc-connection').textContent=(mOffline?'尚未同步':text||'连接');document.getElementById('cc-connection').title='连接与设备'}
document.getElementById('cc-connection').addEventListener('click',function(){ccNav('/set')})
document.getElementById('small-cc').addEventListener('click',function(){if(mCurrent||tSelected||!document.getElementById('chat-search').hidden){history.replaceState(null,'');cRestoreLayer(null)}document.getElementById('chat-input').focus()})
window.addEventListener('offline',function(){cConnectionText();if(cReady)cRender()})
window.addEventListener('online',function(){cConnectionText();if(cReady){cRead(false);tList(false,false)}})
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('controllerchange',function(){toast('界面已更新，请刷新继续。')})

function cShowMatterLayout(){if(!cReady){document.body.classList.remove('matter-open');return};document.body.classList.toggle('matter-open',!!mCurrent);if(mCurrent){document.getElementById('m-home').hidden=!window.matchMedia('(min-width:1000px)').matches;document.getElementById('topic-panel').hidden=true}}
window.addEventListener('resize',cShowMatterLayout)

var cEntryRestored=false
function cRestoreEntry(){
 if(cEntryRestored||!isDevice||!cReady)return;cEntryRestored=true
 var layer=history.state&&history.state.ccLayer,url=new URL(location.href),id=url.searchParams.get('matter')
 if(id&&/^[a-f0-9]{8}$/.test(id)){url.searchParams.delete('matter');history.replaceState(null,'',url);layer={kind:'matter',id:id};cPushLayer(layer)}
 if(layer)cRestoreLayer(layer)
}
function cShowReconnect(){document.getElementById('conversation').hidden=false;cNotice('连接身份未确认，请重新连接。');var button=document.createElement('button');button.type='button';button.textContent='重新连接';button.addEventListener('click',function(){location.reload()});document.getElementById('chat-notice').appendChild(button)}
