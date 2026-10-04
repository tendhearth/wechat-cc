// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {captureTimelineReading,restoreTimelineReading} from './workbench-reading-dom.js'
import {clearLiveTimelinePatches,patchLiveRow} from './workbench-live-dom.js'

let root
beforeEach(()=>{
  vi.useFakeTimers()
  document.body.innerHTML='<main id="reading-fixture"></main>'
  root=document.getElementById('reading-fixture')
})
afterEach(()=>{
  clearLiveTimelinePatches(root)
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML=''
  vi.useRealTimers()
})
const row=(id,body)=>`<article id="${id}" class="wb-message">${body}</article>`
const timeline=rows=>`<div class="wb-dialogue">${rows}</div>`
function select(anchor,anchorOffset,focus,focusOffset){
  const selection=document.getSelection()
  selection.setBaseAndExtent(anchor,anchorOffset,focus,focusOffset)
  return selection
}
function fullPaint(html){
  const snapshot=captureTimelineReading(root)
  root.innerHTML=html
  // Browsers clear a selection when the full-paint operation detaches its nodes.
  // Happy DOM can retain detached endpoints, so exercise restoration explicitly.
  document.getSelection().removeAllRanges()
  restoreTimelineReading(root,snapshot)
}
async function releaseSelection(){
  document.getSelection().removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  await vi.runOnlyPendingTimersAsync()
}

describe('full timeline paint preserves the actual reading nodes',()=>{
  it('retains a backward selection with its original anchor, focus and offsets',()=>{
    root.innerHTML=timeline(row('message-1','<p>abcdef</p>'))
    const article=root.querySelector('article'),paragraph=article.querySelector('p'),text=paragraph.firstChild
    const selection=select(text,5,text,1)

    fullPaint(timeline(row('message-1','<p>abcdef more</p>')))

    expect(root.querySelector('article')).toBe(article)
    expect(article.querySelector('p')).toBe(paragraph)
    expect(selection.anchorNode).toBe(text);expect(selection.anchorOffset).toBe(5)
    expect(selection.focusNode).toBe(text);expect(selection.focusOffset).toBe(1)
    expect(selection.toString()).toBe('bcde')
    expect(text.textContent).toBe('abcdef more')
  })

  it('retains a selection spanning the paragraphs of two messages when a new message arrives',()=>{
    const first=row('message-1','<p>abcdef</p>'),second=row('message-2','<p>ghijkl</p>')
    root.innerHTML=timeline(first+second)
    const articles=Array.from(root.querySelectorAll('article')),anchor=articles[0].querySelector('p').firstChild,focus=articles[1].querySelector('p').firstChild
    const selection=select(anchor,2,focus,4),selectedText=selection.toString()

    fullPaint(timeline(first+second+row('message-3','<p>new output</p>')))

    expect(root.querySelector('#message-1')).toBe(articles[0]);expect(root.querySelector('#message-2')).toBe(articles[1])
    expect(selection.anchorNode).toBe(anchor);expect(selection.anchorOffset).toBe(2)
    expect(selection.focusNode).toBe(focus);expect(selection.focusOffset).toBe(4)
    expect(selection.toString()).toBe(selectedText)
    expect(root.querySelector('#message-3').textContent).toBe('new output')
  })

  it('retains an open user source, its focused summary and horizontal code position',()=>{
    const user=row('message-user','<p><strong>user request</strong></p><details id="user-source" data-user-source open><summary>查看原文</summary><pre><code>**user request**</code></pre></details>')
    root.innerHTML=timeline(user)
    const article=root.querySelector('article'),source=article.querySelector('details'),summary=source.querySelector('summary'),pre=source.querySelector('pre')
    summary.focus();pre.scrollLeft=120;pre.scrollTop=24
    const snapshot=captureTimelineReading(root)
    // The page has already restored disclosure attributes in this new HTML.
    root.innerHTML=timeline(user+row('message-next','<p>new output</p>'))
    pre.scrollLeft=0;pre.scrollTop=0

    restoreTimelineReading(root,snapshot)

    expect(root.querySelector('#message-user')).toBe(article)
    expect(article.querySelector('#user-source')).toBe(source);expect(source.open).toBe(true)
    expect(source.querySelector('summary')).toBe(summary);expect(document.activeElement).toBe(summary)
    expect(source.querySelector('pre')).toBe(pre);expect(pre.scrollLeft).toBe(120);expect(pre.scrollTop).toBe(24)
  })

  it('does not throw or revive a deleted selected message from an old deferred patch',async()=>{
    const remaining=row('message-2','<p>remaining reply</p>')
    root.innerHTML=timeline(row('message-1','<p>abcdef</p>')+remaining)
    const removed=root.querySelector('#message-1'),kept=root.querySelector('#message-2'),text=removed.querySelector('p').firstChild
    select(text,1,text,5)
    expect(patchLiveRow(root,removed,row('message-1','<p><strong>stale deferred reply</strong></p>'))).toBe(false)

    expect(()=>fullPaint(timeline(remaining))).not.toThrow()
    expect(removed.isConnected).toBe(false);expect(root.querySelector('#message-2')).toBe(kept)
    await releaseSelection()

    expect(root.querySelector('#message-1')).toBeNull()
    expect(root.textContent).toBe('remaining reply')
    expect(removed.textContent).toBe('abcdef')
  })

  it('replaces an old pending patch with the latest full-paint HTML and applies it only after selection releases',async()=>{
    root.innerHTML=timeline(row('message-1','<p>abcdef</p>'))
    const article=root.querySelector('article'),text=article.querySelector('p').firstChild,selection=select(text,5,text,1)
    expect(patchLiveRow(root,article,row('message-1','<p><strong>old pending reply</strong></p>'))).toBe(false)

    fullPaint(timeline(row('message-1','<p><strong>latest reply</strong></p>')))

    expect(root.querySelector('article')).toBe(article)
    expect(article.querySelector('strong')).toBeNull();expect(article.textContent).toBe('abcdef')
    expect(selection.anchorNode).toBe(text);expect(selection.anchorOffset).toBe(5)
    expect(selection.focusNode).toBe(text);expect(selection.focusOffset).toBe(1)
    await releaseSelection()

    expect(root.querySelector('article')).toBe(article)
    expect(article.querySelector('strong').textContent).toBe('latest reply')
    expect(root.textContent).not.toContain('old pending reply')
  })
})
