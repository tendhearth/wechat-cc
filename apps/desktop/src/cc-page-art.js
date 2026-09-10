// @ts-check
/** Shared decorative scene markup. Characters always come from frozen assets.
 * @param {'chat'|'memory'} kind
 */
export function ccPageArt(kind) {
  const background = kind === 'memory'
    ? '<img class="cc-page-background" src="./assets/cc-memory-watercolor.png" alt="" />' : ''
  const prop = kind === 'chat'
    ? '<img class="cc-page-prop" src="./assets/pet/props/mug.png" alt="" />' : ''
  return `<span class="cc-page-art cc-page-art-${kind}" aria-hidden="true">
    ${background}<span class="cc-page-ground"></span>
    <img class="cc-page-character cc-page-light" src="./assets/pet/cc-v1/canonical/lit/front.png" alt="" draggable="false" />
    ${prop}</span>`
}
