var cHandlingPop=false,cConversationScroll=0
function cPushLayer(layer){
 if(cHandlingPop||!isDevice||!cReady)return
 if(!history.state||!history.state.ccLayer)cConversationScroll=window.scrollY
 var old=history.state&&history.state.ccLayer
 if(old&&(old.kind===layer.kind||old.kind==='search'&&layer.kind==='matter'))history.replaceState({ccLayer:layer},'')
 else history.pushState({ccLayer:layer},'')
}
function cBackLayer(){if(history.state&&history.state.ccLayer)history.back();else cRestoreLayer(null)}
function cRestoreLayer(layer){
 cHandlingPop=true
 try{
  if(mCurrent&&(!layer||layer.kind!=='matter'))document.getElementById('m-back').click()
  document.getElementById('chat-search').hidden=!(layer&&layer.kind==='search')
  if(layer&&layer.kind==='matter'){openMatter(layer.id);return}
  if(layer&&layer.kind==='topic'){
   document.body.classList.add('topic-open');document.getElementById('topic-panel').hidden=false
   if(layer.id){tSelected=layer.id;document.getElementById('topic-all').hidden=true;tRead()}else{document.getElementById('topic-all').hidden=false;tList(true,false)}
  }else{tClose();if(!layer)window.scrollTo(0,cConversationScroll)}
 }finally{cHandlingPop=false}
}
window.addEventListener('popstate',function(ev){if(isDevice&&cReady)cRestoreLayer(ev.state&&ev.state.ccLayer)})
document.addEventListener('keydown',function(ev){if(ev.key==='Escape'&&history.state&&history.state.ccLayer){ev.preventDefault();cBackLayer()}})
