// @ts-check
/**
 * 执行者头像(2026-10-19,与 apps/app 的 view/agents.ts + ui/AgentAvatars.tsx 同一套):桌面与手机网页共用这一份。
 * 每件事 / 每条终端会话画一组圆头像,正在做的在最上;名字只进读屏标签、title 与详情页,行里不再写名字。
 * 图形按 currentColor 着色(跟页面同一支笔,不带各家的品牌色),颜色、尺寸交给两边各自的 CSS(.th-agents / .th-agent)。
 *
 * 跟 task-entry-contract.js 一样:桌面原生 ESM 直接 import;手机生成页把这个工厂整段内联进经典脚本
 * (apps/mobile/sources.ts)。工厂之外不放任何东西 —— 不 import、不碰 DOM / Node。
 */
export function createAgentAvatars() {
  /*
   * Agent glyphs (claude, codex, cursor, agy, gemini, kimi, openai, deepseek, qwen) are from
   * LobeHub Icons, @lobehub/icons-static-svg 1.95.1 (https://github.com/lobehub/lobe-icons), MIT licence;
   * full text in agent-glyphs-LICENSE.txt next to this file. The marks are trademarks of their owners.
   *
   * MIT License — Copyright (c) 2023 LobeHub
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  /** 24×24 的单色路径(lobe-icons 的 mono 版原样);有图标的就这几家,别的执行者画首字母。 @type {Readonly<Record<string,string>>} */
  const GLYPHS = Object.freeze({
    claude: '<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    codex: '<path clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>',
    cursor: '<path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/>',
    agy: '<path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"/>',
    gemini: '<path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/>',
    kimi: '<path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"/><path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"/>',
    openai: '<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>',
    deepseek: '<path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/>',
    qwen: '<path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"/>',
  })
  const AGENT_GLYPHS = Object.freeze(Object.keys(GLYPHS))
  /**
   * @typedef {(id:string)=>string|null|undefined} NameOf 执行者叫什么:由 daemon 下发(收敛清单 ⑥,agentNames / providers[].displayName / displayName),
   * 这里**不存名字表**。调用方从手里的数据查;查不到(老 daemon)⇒ 退回 id。
   */
  /** @typedef {readonly (string|null|undefined)[]|null|undefined} Ids */
  /** @typedef { {max?:number,nameOf?:NameOf,cls?:string} } AvatarOptions 手机页把这段内联进生成页,连着的两个左花括号在那边是构建标记 —— 这里别写。 */
  /** @type {Readonly<Record<string,string>>} */
  const ENTITY = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })
  /** @param {string} s */
  const esc = s => String(s).replace(/[&<>"']/g, c => ENTITY[c] ?? c)

  /** @param {string} id @param {NameOf} [nameOf] */
  function agentName(id, nameOf) {
    return nameOf?.(id) || id
  }
  /** @param {string} id @returns {string|null} */
  function agentGlyph(id) {
    return Object.prototype.hasOwnProperty.call(GLYPHS, id) ? id : null
  }
  /** 没有图标的执行者:取名字里第一个字母 / 汉字,大写。 @param {string} id @param {NameOf} [nameOf] */
  function agentMonogram(id, nameOf) {
    return (Array.from(agentName(id, nameOf).trim())[0] ?? '?').toUpperCase()
  }
  /** @param {Ids} ids @returns {string[]} */
  function uniq(ids) {
    /** @type {string[]} */ const out = []
    for (const id of ids ?? []) if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
    return out
  }
  /**
   * 一组最多露 max 个,多出来的折成「+N」;重复的、空的去掉,顺序不动(正在做的在前)。
   * 正好多一个时直接画出来:「+1」占的地方跟一个头像一样大,不如让人看见是谁。
   * @param {Ids} ids @param {number} [max]
   */
  function agentStack(ids, max = 3) {
    const all = uniq(ids)
    if (all.length <= max + 1) return { shown: all, more: 0 }
    return { shown: all.slice(0, max), more: all.length - max }
  }
  /** 读屏念的那一句:「Claude、Codex」。 @param {Ids} ids @param {NameOf} [nameOf] */
  function agentsLabel(ids, nameOf) {
    return uniq(ids).map(id => agentName(id, nameOf)).join('、')
  }
  /** 一件事的那一组:任务自己的执行者在前,再接 daemon 给的 agents(老 daemon 不带 ⇒ 至少有任务那一家)。 @param {string|null|undefined} providerId @param {Ids} agents */
  function matterAgents(providerId, agents) {
    return uniq([providerId, ...(agents ?? [])])
  }
  /** 一个圆:图标或首字母。z = 叠放次序(正在做的最大)。 @param {string} id @param {NameOf} [nameOf] @param {number} [z] */
  function agentAvatarHtml(id, nameOf, z) {
    const glyph = agentGlyph(id)
    const inner = glyph
      ? `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false">${GLYPHS[glyph]}</svg>`
      : `<span class="th-agent-mono" aria-hidden="true">${esc(agentMonogram(id, nameOf))}</span>`
    return `<span class="th-agent"${z === undefined ? '' : ` style="z-index:${z}"`} data-agent="${esc(id)}">${inner}</span>`
  }
  /**
   * 一件事的执行者:一个就是一个圆,几个就往左半叠,正在做的(第一个)压在最上面;超过 max+1 个折成「+N」。
   * 整组对读屏是一张图,标签念名字(也进 title,鼠标停上去看得到)。没有执行者 ⇒ 空串,什么都不画。
   * @param {Ids} ids @param {AvatarOptions} [o]
   */
  function agentAvatarsHtml(ids, o = {}) {
    const { shown, more } = agentStack(ids, o.max ?? 3)
    if (!shown.length) return ''
    const label = esc(agentsLabel(ids, o.nameOf)), n = shown.length + (more ? 1 : 0)
    const items = shown.map((id, i) => agentAvatarHtml(id, o.nameOf, n - i))
    if (more) items.push(`<span class="th-agent th-agent-more" style="z-index:0" aria-hidden="true">+${more}</span>`)
    return `<span class="th-agents${o.cls ? ` ${esc(o.cls)}` : ''}" role="img" aria-label="${label}" title="${label}">${items.join('')}</span>`
  }
  // 出生地(2026-10-19):这件事从哪个表面来的,头像组旁边一个单色小字形,跟头像同一支笔(currentColor)。
  // 只画出生地(建时写一次),不画露过面的多端;不知道(老的事 / 老 daemon)⇒ 空串,什么都不画。
  // 字形是自己画的通用线条图(两个气泡 / 显示器 / 手机 / 地球 / >_ / 一颗心;不用星芒 —— 那是 Claude 的头像),不是任何一家的商标。
  // 跟 apps/app 的 view/origin.ts + assets/origins 同一组(App 那边是同一份路径渲成的 PNG)。
  /** @type {Readonly<Record<string,string>>} */
  const ORIGIN_GLYPHS = Object.freeze({
    wechat: '<path d="M10 4.5c-4.1 0-7.5 2.7-7.5 6 0 1.8 1 3.5 2.6 4.6L4.5 18l3.1-1.6c.8.2 1.6.3 2.4.3"/><path d="M15.5 9.5c3.3 0 6 2.2 6 5 0 1.5-.8 2.9-2.1 3.8l.5 2.2-2.5-1.3c-.6.2-1.2.3-1.9.3-3.3 0-6-2.2-6-5s2.7-5 6-5z"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
    app: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>',
    cli: '<path d="M5 7l5 5-5 5M12.5 17.5H19"/>',
    companion: '<path d="M12 20s-7.5-4.6-7.5-10A4.1 4.1 0 0 1 12 7.7 4.1 4.1 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  })
  /** 读屏与 title 念的那一句。 @type {Readonly<Record<string,string>>} */
  const ORIGIN_LABELS = Object.freeze({
    wechat: '从微信来的', desktop: '从电脑来的', app: '从手机 App 来的', web: '从浏览器来的', cli: '从终端来的', companion: 'CC 自己起的',
  })
  const MATTER_ORIGINS = Object.freeze(Object.keys(ORIGIN_GLYPHS))
  /** 认得的出生地才算;别的(空的 / 未来的新值)当不知道。 @param {unknown} origin @returns {string|null} */
  function matterOrigin(origin) {
    return typeof origin === 'string' && Object.prototype.hasOwnProperty.call(ORIGIN_GLYPHS, origin) ? origin : null
  }
  /** @param {unknown} origin */
  function originLabel(origin) {
    const o = matterOrigin(origin)
    return o ? ORIGIN_LABELS[o] ?? '' : ''
  }
  /** 一个小字形;不知道 ⇒ 空串。 @param {unknown} origin @param { {cls?:string} } [o] */
  function originMarkHtml(origin, o = {}) {
    const key = matterOrigin(origin)
    if (!key) return ''
    const label = esc(ORIGIN_LABELS[key] ?? '')
    return `<span class="th-origin${o.cls ? ` ${esc(o.cls)}` : ''}" role="img" aria-label="${label}" title="${label}" data-origin="${esc(key)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ORIGIN_GLYPHS[key]}</svg></span>`
  }
  return Object.freeze({ AGENT_GLYPHS, agentName, agentGlyph, agentMonogram, agentStack, agentsLabel, matterAgents, agentAvatarHtml, agentAvatarsHtml, MATTER_ORIGINS, matterOrigin, originLabel, originMarkHtml })
}
