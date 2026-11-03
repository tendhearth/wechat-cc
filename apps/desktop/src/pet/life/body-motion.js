// @ts-check
// Transform only CC's existing body/props layer; interaction geometry stays put.
/** @param {{stage:any,body?:any}} root */
export function createBodyMotion(root){
  const body=root.body??root.stage
  return {
    /** @param {{action:string,direction:number}} pose */
    render(pose){
      root.stage.setAttribute('data-pet-action',pose.action)
      body.setAttribute('data-pet-action',pose.action)
      body.style.setProperty('--pet-direction',String(pose.direction))
      if(pose.action!=='lift')body.style.setProperty('--pet-swing','0')
    },
    /** @param {number} speed */
    velocity(speed){body.style.setProperty('--pet-swing',String(Number.isFinite(speed)?Math.max(-1,Math.min(1,speed)):0))},
  }
}
