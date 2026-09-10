// @ts-check
// Registration against the approved 4:3 aquarium illustration.
export const CC_GROUND = Object.freeze({ x: .258, y: .806, width: .34 })
export const WATER = Object.freeze({ left: .305, right: .83, top: .407, bottom: .70 })
/** @param {number} width @param {number} height */
export function ccBox(width, height) {
  const size=width*CC_GROUND.width
  return { x:width*CC_GROUND.x-size/2, y:height*CC_GROUND.y-size*470/512, width:size, height:size }
}
/** @param {number} x @param {number} y */
export function waterContains(x,y) { return x>WATER.left && x<WATER.right && y>WATER.top && y<WATER.bottom }
/** @param {number} x @param {number} y @param {number} width @param {number} height */
export function ccContains(x,y,width,height) {
  const box=ccBox(width,height)
  const u=(x*width-box.x)/box.width,v=(y*height-box.y)/box.height
  return u>.16 && u<.84 && v>.12 && v<.92
}
