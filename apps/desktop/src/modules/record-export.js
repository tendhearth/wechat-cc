// @ts-check
/// <reference lib="dom" />
// Keep a picture and its words together using the existing native text-file save command.
/** @param {string} filename @param {string} content @returns {Promise<'native'|'download'>} */
export async function saveRecordDocument(filename,content) {
 if(/** @type {any} */ (window).__TAURI__?.core?.invoke){
  await /** @type {any} */ (window).__TAURI__.core.invoke('save_text_file',{filename,content})
  return 'native'
 }
 const url=URL.createObjectURL(new Blob([content],{type:'text/html;charset=utf-8'}))
 const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove()
 setTimeout(()=>URL.revokeObjectURL(url),30000)
 return 'download'
}
