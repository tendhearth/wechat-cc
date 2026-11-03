// @ts-check
/** @typedef {import('../assets/manifest-loader.js').Animation} Animation */
/** Optional artwork changes presentation only. Facts and interruption stay with the machine. */
export function resolvePerformance(/** @type {import('../assets/manifest-loader.js').PetManifest} */ manifest,
  /** @type {'lit'|'unlit'} */ form, /** @type {string} */ action, /** @type {string} */ behavior,
  /** @type {number} */ direction=1) {
  if(form!=='lit'||['permission','error','thinking','sleep'].includes(behavior)) return null
  // A factual completion outlives the director's decorative clock. WebKit may
  // throttle individual frame timers: keep the same clip until its real onEnd.
  let id=action==='work-exit'?'work':action==='still'&&behavior==='done'?'celebrate':action
  if(id==='peek'&&direction<0&&manifest.forms[form].states['life-peek-left']?.frames.length)id='peek-left'
  if(!['peek','peek-left','stretch','walk','lift','land','celebrate','work','curiosity'].includes(id)) return null
  if(id==='lift'&&behavior!=='drag') return null
  if(id==='work'&&action!=='work-exit'&&behavior!=='working') return null
  if(id==='curiosity'&&!['idle','companion','blink','look'].includes(behavior)) return null
  const animation=manifest.forms[form].states[`life-${id}`]
  if(!animation?.frames.length) return null
  if(id==='curiosity'&&animation.loop) return null
  const last=animation.frames[animation.frames.length-1]
  if(!last) return null
  // Putting the laptop away never starts the factual done animation early.
  // Hold a completed gesture until the director's short settling clock expires.
  const hold=action==='work-exit'||(action==='celebrate'&&behavior!=='done')
  return {id,hold,animation:hold?{...animation,frames:[last],fps:1,loop:true,next:null}:animation}
}
