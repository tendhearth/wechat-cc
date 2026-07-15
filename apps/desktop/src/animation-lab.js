const canvas = document.getElementById("companion-stage")
const ctx = canvas.getContext("2d")
const hint = document.getElementById("stage-hint")
const bearMessage = document.getElementById("bear-message")
const crabEscapeOverlay = document.getElementById("crab-escape")
const calmToggle = document.getElementById("calm-toggle")
const background = new Image()
background.src = "./assets/moment-cc-companion-animation-base-clean.png"
const fishSpriteSources = [
  "./assets/animation/fish-yellow-left.png",
  "./assets/animation/fish-yellow-right.png",
  "./assets/animation/fish-blue.png",
  "./assets/animation/fish-orange.png",
  "./assets/animation/fish-pink.png",
  "./assets/companion-fish.png",
  "./assets/animation/fish-dialogue-orange.png",
  "./assets/animation/fish-dialogue-bluegray.png",
]
const fishSprites = fishSpriteSources.map(source => {
  const image = new Image()
  image.src = source
  return image
})
const bearBody = new Image()
const bearBodyWarped = document.createElement("canvas")
const bearBodyMeshPadding = 64
let bearBodyWarpedReady = false
bearBody.addEventListener("load", buildBearBodyMesh)
bearBody.src = "./assets/animation/bear-rig-body-cute-v3-cropped.png"
const bearFishArm = new Image()
const bearFishArmWarped = document.createElement("canvas")
const bearFishArmMeshPadding = 96
let bearFishArmWarpedReady = false
bearFishArm.addEventListener("load", buildBearFishArmMesh)
bearFishArm.src = "./assets/animation/bear-rig-fish-arm-cropped.png"
const plantLayers = [
  { source: "./assets/animation/plant-round-ai.png", box: [.365, .5352, .1032, .2448], offsetX: -20, phase: 1.2, amplitude: .0042 },
  { source: "./assets/animation/plant-small-ai.png", box: [.625, .684, .066, .076], phase: 3.4, amplitude: .0022 },
  { source: "./assets/animation/plant-round-ai.png", box: [.695, .541, .092, .224], phase: 4.4, amplitude: .0046 },
  // Keep the root on the sand and right glass, while giving this long-leaf
  // plant more vertical presence than the surrounding round leaves.
  { source: "./assets/animation/plant-grass-ai.png", box: [.767, .4626, .1232, .3224], offsetX: 20, offsetY: -10, phase: 5.2, amplitude: .014 },
].map(layer => {
  const image = new Image()
  image.src = layer.source
  return { ...layer, image }
})
const lotusLeaves = new Image()
lotusLeaves.src = "./assets/animation/lotus-leaves-cropped.png"
const lotusPetal = new Image()
lotusPetal.src = "./assets/animation/lotus-petal-cropped.png"
const lotusBud = new Image()
lotusBud.src = "./assets/animation/lotus-bud-cropped.png"
const crabSprite = new Image()
crabSprite.src = "./assets/animation/crab-watercolor-v1.png"

const fish = []
const bubbles = []
const pointer = { x: .66, y: .45, active: false }
const fishTraits = [
  { curiosity: 1.05, speedScale: 1, warmup: 260, startleRadius: 1, burst: 1, sizeScale: 1.08 },
  { curiosity: .96, speedScale: .94, warmup: 300, startleRadius: 1, burst: .96, sizeScale: .92 },
  { curiosity: .58, speedScale: .82, warmup: 220, startleRadius: 1.65, burst: 1.22, sizeScale: .80 },
  { curiosity: 1.55, speedScale: 1.14, warmup: 110, startleRadius: .72, burst: .82, sizeScale: 1.20 },
  { curiosity: .46, speedScale: .72, warmup: 820, startleRadius: 1.05, burst: .94, sizeScale: .72 },
  { curiosity: 1.16, speedScale: .88, warmup: 280, startleRadius: 1, burst: 1, sizeScale: .98 },
  // The two dialogue-page fish add more colour variety: orange explores
  // quickly while the blue-grey one keeps a little more personal space.
  { curiosity: 1.42, speedScale: 1.08, warmup: 145, startleRadius: .78, burst: .9, sizeScale: 1.04 },
  { curiosity: .64, speedScale: .8, warmup: 360, startleRadius: 1.48, burst: 1.18, sizeScale: .94 },
]
let calm = false
let bearAwake = 0
let bearWaveStartedAt = -Infinity
let bearHovering = false
const bearGreetings = [
  "我在这儿陪你看鱼。",
  "今天的水光很好看呀。",
  "小鱼刚刚偷偷靠近你了。",
  "慢一点，也没关系。",
  "要不要一起看看水草后面？",
]
let bearGreetingIndex = -1
let lotusClosed = 0
let lotusClosedTarget = 0
let crabEscapeStartedAt = -Infinity
let lastTime = performance.now()
let lastFleePointer = { x: -1, y: -1 }

// All bear-owned UI and illustration layers share this grounded rig. That
// keeps the speech bubble attached to the character when its overall size
// changes instead of leaving it at an old canvas coordinate.
const bearRig = {
  anchorX: .215,
  anchorY: .89,
  baseScale: .765,
  // Shoulder position in the original bear coordinate space. It is converted
  // through the exact same ground-anchored transform as the body, so scaling
  // the bear cannot make the separate arm drift away from its shoulder.
  armPivotX: .237,
  armPivotY: .682,
  messageOriginX: .27,
  // This is the upper edge of the bubble at the original bear size. It sits
  // just above the head rather than overlapping the ears.
  messageOriginY: .29,
}

function scaleFromBearGround(x, y, scale = bearRig.baseScale) {
  const offsetX = bearLocalOffsetX()
  const anchorX = bearRig.anchorX + offsetX
  return {
    x: anchorX + (x + offsetX - anchorX) * scale,
    y: bearRig.anchorY + (y - bearRig.anchorY) * scale,
  }
}

function positionBearMessage() {
  const point = scaleFromBearGround(bearRig.messageOriginX, bearRig.messageOriginY)
  bearMessage.style.setProperty("--bear-message-x", `${point.x * 100}%`)
  bearMessage.style.setProperty("--bear-message-y", `${point.y * 100}%`)
  // The speech bubble had already been deliberately reduced to 90%. Keep it
  // in the same scaled character group when the bear itself gets resized.
  bearMessage.style.setProperty("--bear-message-scale", String(.9 * bearRig.baseScale / .85))
}

function seedFish() {
  fish.length = 0
  // Give each colour room to read. Yellow is now deliberately a minority
  // rather than the repeating default in the aquarium.
  const fishKindPlan = [0, 1, 2, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6]
  for (const kind of fishKindPlan) {
    const trait = fishTraits[kind]
    fish.push({
      x: .39 + Math.random() * .45,
      y: .44 + Math.random() * .21,
      vx: (Math.random() - .5) * .000035,
      vy: (Math.random() - .5) * .000026,
      // Colour personality also defines a clear large / medium / small read.
      size: (.0064 + Math.random() * .0055) * trait.sizeScale * 1.176,
      alpha: 1,
      kind,
      ...trait,
      phase: Math.random() * Math.PI * 2,
      orbit: Math.random() * Math.PI * 2,
      pointerMix: 0,
      fleeUntil: 0,
    })
  }
}

function resetBubble(bubble, startInWater = false) {
  bubble.x = .39 + Math.random() * .47
  bubble.y = startInWater ? .43 + Math.random() * .25 : .71 + Math.random() * .08
  bubble.radius = .0024 + Math.random() * .0058
  bubble.speed = .000014 + Math.random() * .000024
  bubble.phase = Math.random() * Math.PI * 2
  bubble.drift = .0012 + Math.random() * .0028
}

function seedBubbles() {
  bubbles.length = 0
  for (let index = 0; index < 15; index += 1) {
    const bubble = {}
    resetBubble(bubble, true)
    bubbles.push(bubble)
  }
}

function resize() {
  const rect = canvas.getBoundingClientRect()
  // The dashboard mounts this scene while its pane may still be hidden. Keep
  // the last drawable bitmap until the container receives a real size.
  if (!rect.width || !rect.height) return
  const ratio = Math.min(devicePixelRatio || 1, 2)
  canvas.width = Math.round(rect.width * ratio)
  canvas.height = Math.round(rect.height * ratio)
  positionBearMessage()
}

// This is the water volume, not the whole glass tank.  Fish and mouse
// interaction stay beneath the visible waterline and above the sand.
function waterContains(x, y) { return x > .365 && x < .89 && y > .405 && y < .69 }
function bearLocalOffsetX() {
  const displayScale = Math.min(devicePixelRatio || 1, 2)
  return 20 * displayScale / canvas.width
}
function bearContains(x, y) {
  const offsetX = bearLocalOffsetX()
  const anchorX = bearRig.anchorX + offsetX
  const scale = bearRig.baseScale
  return x > anchorX + (.09 + offsetX - anchorX) * scale
    && x < anchorX + (.43 + offsetX - anchorX) * scale
    && y > bearRig.anchorY + (.34 - bearRig.anchorY) * scale
    && y < .90
}
function lotusContains(x, y) { return x > .455 && x < .545 && y > .655 && y < .79 }
function canvasXForCssPixels(pixels) {
  return pixels * Math.min(devicePixelRatio || 1, 2) / canvas.width
}
function canvasYForCssPixels(pixels) {
  return pixels * Math.min(devicePixelRatio || 1, 2) / canvas.height
}
// The tall right-hand plant hides the crab's little starting spot.
function crabPlantContains(x, y) {
  const offsetX = canvasXForCssPixels(20)
  const offsetY = canvasYForCssPixels(-10)
  return x > .767 + offsetX && x < .90 + offsetX && y > .46 + offsetY && y < .79 + offsetY
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

function swimBounds(f) {
  const sprite = fishSprites[f.kind]
  const aspect = sprite?.naturalWidth ? sprite.naturalHeight / sprite.naturalWidth : .42
  const width = f.size * canvas.width * (f.kind === 5 ? 5.45 : 5.1)
  const horizontalPadding = width / canvas.width / 2 + .008
  const verticalPadding = width * aspect / canvas.height / 2 + f.size * canvas.width * .15 / canvas.height + .008
  return {
    left: .365 + horizontalPadding,
    right: .89 - horizontalPadding,
    top: .405 + verticalPadding,
    bottom: .69 - verticalPadding,
  }
}

function fishTouchRadius(f) {
  return f.size * (f.kind === 5 ? 5.45 : 5.1) / 2 + .008
}

function triggerFishEscape(time) {
  if (!pointer.active || !waterContains(pointer.x, pointer.y) || lotusContains(pointer.x, pointer.y) || crabPlantContains(pointer.x, pointer.y)) return
  if (Math.hypot(pointer.x - lastFleePointer.x, pointer.y - lastFleePointer.y) < .05) return

  let closest = null
  let closestDistance = Infinity
  for (const f of fish) {
    if (time < f.fleeUntil) continue
    const distance = Math.hypot(f.x - pointer.x, f.y - pointer.y)
    if (distance < fishTouchRadius(f) * f.startleRadius && distance < closestDistance) {
      closest = f
      closestDistance = distance
    }
  }
  if (!closest) return

  let dx = closest.x - pointer.x
  let dy = closest.y - pointer.y
  const distance = Math.hypot(dx, dy)
  if (distance < .004) {
    dx = Math.cos(closest.phase + closest.orbit)
    dy = Math.sin(closest.phase + closest.orbit) * .65
  }
  const direction = Math.hypot(dx, dy) || 1
  const burst = .00015 * closest.speedScale * closest.burst * (calm ? .72 : 1)
  closest.vx = dx / direction * burst
  closest.vy = dy / direction * burst
  closest.pointerMix = 0
  closest.fleeUntil = time + 520
  lastFleePointer = { x: pointer.x, y: pointer.y }
}

function drawSceneBackground() {
  const w = canvas.width
  const h = canvas.height
  if (background.complete) ctx.drawImage(background, 0, 0, w, h)
}

function drawPlantLayer(layer, time) {
  const { image, box, offsetX = 0, offsetY = 0, phase, amplitude } = layer
  if (!image.complete || !image.naturalWidth) return
  const w = canvas.width
  const h = canvas.height
  const displayScale = Math.min(devicePixelRatio || 1, 2)
  const slices = 18
  const [x, y, width, height] = box
  for (let index = 0; index < slices; index += 1) {
    const progress = index / slices
    const sourceY = progress * image.naturalHeight
    const sourceHeight = image.naturalHeight / slices + 1
    const destinationY = (y + height * progress) * h + offsetY * displayScale
    const destinationHeight = height / slices * h + 1
    const flexibility = 1 - progress
    const offset = Math.sin(time * .00135 + phase + progress * 1.45) * amplitude * w * flexibility
    ctx.drawImage(
      image,
      0,
      sourceY,
      image.naturalWidth,
      sourceHeight,
      x * w + offsetX * displayScale + offset,
      destinationY,
      width * w,
      destinationHeight,
    )
  }
}

function drawAquariumPlants(time) {
  for (const layer of plantLayers) drawPlantLayer(layer, time)
}

function drawLotusSprite(image, pivotX, pivotY, width, rotation = 0, flip = false, opacity = 1) {
  if (!image.complete || !image.naturalWidth) return
  const height = width * (image.naturalHeight / image.naturalWidth)
  ctx.save()
  ctx.translate(pivotX, pivotY)
  ctx.rotate(rotation)
  ctx.scale(flip ? -1 : 1, 1)
  ctx.globalAlpha = opacity
  ctx.drawImage(image, -width / 2, -height, width, height)
  ctx.restore()
}

function drawInteractiveLotus() {
  const w = canvas.width
  const h = canvas.height
  const centerX = .50 * w
  const lotusScale = .7
  const leavesWidth = .105 * w * lotusScale
  const leavesHeight = leavesWidth * (lotusLeaves.naturalHeight / lotusLeaves.naturalWidth)
  const leavesBottom = .783 * h
  if (lotusLeaves.complete && lotusLeaves.naturalWidth) {
    ctx.drawImage(lotusLeaves, centerX - leavesWidth / 2, leavesBottom - leavesHeight, leavesWidth, leavesHeight)
  }

  // Three mirrored pairs share one flower-base point. They only rotate around
  // that point, so the open flower reads as petals growing from one base.
  const openness = 1 - lotusClosed
  const baseY = .748 * h
  // The complete closed flower keeps a total 20° opening: ±10° per side.
  const closedAngle = Math.PI / 18
  // Centre (0°), inner (28°), middle (56°), outer (84°): every visible
  // petal slot is one identical angular step from the next.
  const openAngleStep = Math.PI * 7 / 45
  const petals = [
    // Sizes taper gently from the centre toward the outside, while the slots
    // themselves stay strictly even.
    { width: .029, slot: 3, opacity: .82 },
    { width: .035, slot: 2, opacity: .92 },
    { width: .041, slot: 1, opacity: 1 },
  ]
  for (const petal of petals) {
    const width = petal.width * w * lotusScale
    for (const side of [-1, 1]) {
      drawLotusSprite(
        lotusPetal,
        centerX,
        baseY,
        width,
        side * (closedAngle + (petal.slot * openAngleStep - closedAngle) * openness),
        side === -1,
        petal.opacity,
      )
    }
  }
  // A single largest centre petal stays still with the flower core. The
  // mirrored side petals open and close around this stable middle layer.
  drawLotusSprite(lotusPetal, centerX, baseY, .044 * w * lotusScale, 0, false, 1)
  // The flower centre is intentionally independent: it stays fixed while
  // the surrounding orange petals open and close around it.
  const budWidth = .049 * w * lotusScale
  drawLotusSprite(lotusBud, centerX, baseY + h * .005, budWidth)
}

function crabCanvasPose(time) {
  const elapsed = time - crabEscapeStartedAt
  const innerRailTop = .398 - canvasYForCssPixels(60)
  if (elapsed < 0 || elapsed >= 1600) return null
  if (elapsed < 560) {
    const progress = smoothstep(0, 560, elapsed)
    return {
      x: .846 + progress * .028,
      y: .754 - progress * .070,
      rotation: -.06 - progress * .18,
      opacity: Math.min(1, elapsed / 180),
    }
  }
  const progress = smoothstep(560, 1600, elapsed)
  return {
    x: .874,
    y: .684 + (innerRailTop - .684) * progress,
    rotation: -.24 - progress * 1.22,
    opacity: 1,
  }
}

function drawCrab(time, behindPlants) {
  if (!crabSprite.complete || !crabSprite.naturalWidth) return
  const elapsed = time - crabEscapeStartedAt
  const emerging = elapsed >= 0 && elapsed < 560
  if (behindPlants !== emerging) return
  const pose = crabCanvasPose(time)
  if (!pose) return
  const width = canvas.width * .086
  const bounce = Math.sin(elapsed * .026) * width * .025
  ctx.save()
  ctx.translate(pose.x * canvas.width, pose.y * canvas.height + bounce)
  ctx.rotate(pose.rotation + Math.sin(elapsed * .032) * .025)
  ctx.scale(1 + Math.sin(elapsed * .026) * .018, 1 - Math.sin(elapsed * .026) * .014)
  ctx.globalAlpha = pose.opacity
  ctx.drawImage(crabSprite, -width / 2, -width / 2, width, width)
  ctx.restore()
}

function updateCrabEscapeOverlay(time) {
  const elapsed = time - crabEscapeStartedAt
  const overlayStart = 1600
  const overlayDuration = 3300
  if (elapsed < overlayStart || elapsed > overlayStart + overlayDuration) {
    crabEscapeOverlay.style.opacity = "0"
    return
  }
  const stageRect = canvas.getBoundingClientRect()
  const size = stageRect.width * .086
  const innerRailTop = stageRect.top + stageRect.height * (.398 - canvasYForCssPixels(60))
  // The hand-painted tank's actual outer rail is near x=93.2%, with the
  // bottom edge near y=84%. These image coordinates keep both display modes
  // on the same illustrated route.
  const tankOuterRight = stageRect.left + stageRect.width * .932
  const outerRailX = tankOuterRight + 30
  const tankBottom = stageRect.top + stageRect.height * .84
  const outerRailBottom = tankBottom + 100
  const progress = clamp((elapsed - overlayStart) / overlayDuration, 0, 1)
  // The canvas leg first climbs upward. The overlay then moves right across
  // the rim, down the real outer rail, and right again to leave the page.
  // This keeps
  // the crab reading as a crawler crossing the page rather than a sprite
  // flying through empty space.
  const path = [
    { x: stageRect.left + stageRect.width * .874, y: innerRailTop },
    { x: outerRailX, y: innerRailTop },
    { x: outerRailX, y: outerRailBottom },
    { x: window.innerWidth + size, y: outerRailBottom },
  ]
  const segments = path.slice(1).map((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y))
  const totalLength = segments.reduce((sum, length) => sum + length, 0) || 1
  let travelled = progress * totalLength
  let segmentIndex = 0
  while (segmentIndex < segments.length - 1 && travelled > segments[segmentIndex]) {
    travelled -= segments[segmentIndex]
    segmentIndex += 1
  }
  const from = path[segmentIndex]
  const to = path[segmentIndex + 1]
  const segmentProgress = segments[segmentIndex] ? travelled / segments[segmentIndex] : 1
  const x = from.x + (to.x - from.x) * segmentProgress - size / 2
  const y = from.y + (to.y - from.y) * segmentProgress - size / 2 + Math.sin(elapsed * .031) * size * .022
  const rotation = Math.atan2(to.y - from.y, to.x - from.x)
  crabEscapeOverlay.style.width = `${size}px`
  crabEscapeOverlay.style.opacity = String(Math.min(1, progress / .08) * (1 - Math.max(0, progress - .9) / .1))
  crabEscapeOverlay.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotation}rad)`
}

function startCrabEscape(time) {
  crabEscapeStartedAt = time
  crabEscapeOverlay.style.opacity = "0"
}

function drawHandDrawnBubbleContour(x, y, radius, phase, variation = 0) {
  const points = 13
  for (let index = 0; index <= points; index += 1) {
    const angle = index / points * Math.PI * 2
    const wobble = 1
      + Math.sin(angle * 3 + phase + variation) * .045
      + Math.cos(angle * 5 - phase * .7 + variation) * .022
    const px = x + Math.cos(angle) * radius * wobble
    const py = y + Math.sin(angle) * radius * wobble
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
}

function drawBubbles(time, dt) {
  const w = canvas.width
  const h = canvas.height
  for (const bubble of bubbles) {
    bubble.y -= bubble.speed * dt
    if (bubble.y + bubble.radius < .405) resetBubble(bubble)
    const x = (bubble.x + Math.sin(time * .0012 + bubble.phase) * bubble.drift) * w
    const y = bubble.y * h
    const radius = bubble.radius * w
    const fade = clamp((bubble.y - .405) / .05, 0, 1) * clamp((.79 - bubble.y) / .08, 0, 1)
    ctx.save()
    // Two soft, imperfect brown outlines make the bubbles read as part of
    // the illustration instead of as crisp UI circles.
    ctx.globalAlpha = .16 + fade * .48
    ctx.strokeStyle = "rgba(118, 83, 48, .88)"
    ctx.lineWidth = Math.max(1, radius * .115)
    ctx.beginPath()
    drawHandDrawnBubbleContour(x, y, radius, bubble.phase)
    ctx.stroke()
    ctx.globalAlpha = .1 + fade * .24
    ctx.lineWidth = Math.max(.75, radius * .052)
    ctx.beginPath()
    drawHandDrawnBubbleContour(x + radius * .025, y - radius * .018, radius * .94, bubble.phase, 1.6)
    ctx.stroke()
    ctx.globalAlpha = .22 + fade * .34
    ctx.fillStyle = "rgba(255, 255, 248, .9)"
    ctx.beginPath()
    ctx.arc(x - radius * .28, y - radius * .28, Math.max(1, radius * .16), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function drawPuppetPart(image, box, pivot, rotation, lift, scale = 1) {
  if (!image.complete || !image.naturalWidth) return
  const w = canvas.width
  const h = canvas.height
  ctx.save()
  ctx.translate(pivot[0] * w, pivot[1] * h + lift)
  ctx.rotate(rotation)
  ctx.scale(scale, scale)
  ctx.drawImage(
    image,
    (box[0] - pivot[0]) * w,
    (box[1] - pivot[1]) * h,
    box[2] * w,
    box[3] * h,
  )
  ctx.restore()
}

function smoothstep(start, end, value) {
  const progress = clamp((value - start) / (end - start), 0, 1)
  return progress * progress * (3 - 2 * progress)
}

function armPlumpWeight(progress) {
  // Keep all visible hand and forearm pixels at their original shape. Only
  // the shoulder root opens more, then tapers gradually toward the hand.
  return .26 * (1 - smoothstep(.06, .58, progress))
}

function drawWarpedTriangle(context, image, source, destination) {
  const [s0, s1, s2] = source
  const [d0, d1, d2] = destination
  const sx1 = s1.x - s0.x
  const sy1 = s1.y - s0.y
  const sx2 = s2.x - s0.x
  const sy2 = s2.y - s0.y
  const determinant = sx1 * sy2 - sx2 * sy1
  if (Math.abs(determinant) < .0001) return
  const dx1 = d1.x - d0.x
  const dy1 = d1.y - d0.y
  const dx2 = d2.x - d0.x
  const dy2 = d2.y - d0.y
  const a = (dx1 * sy2 - dx2 * sy1) / determinant
  const b = (dy1 * sy2 - dy2 * sy1) / determinant
  const c = (dx2 * sx1 - dx1 * sx2) / determinant
  const d = (dy2 * sx1 - dy1 * sx2) / determinant
  const e = d0.x - a * s0.x - c * s0.y
  const f = d0.y - b * s0.x - d * s0.y

  context.save()
  context.beginPath()
  context.moveTo(d0.x, d0.y)
  context.lineTo(d1.x, d1.y)
  context.lineTo(d2.x, d2.y)
  context.closePath()
  context.clip()
  context.setTransform(a, b, c, d, e, f)
  context.drawImage(image, 0, 0)
  context.restore()
}

function buildBearFishArmMesh() {
  const sourceWidth = bearFishArm.naturalWidth
  const sourceHeight = bearFishArm.naturalHeight
  if (!sourceWidth || !sourceHeight) return
  const padding = bearFishArmMeshPadding
  bearFishArmWarped.width = sourceWidth + padding * 2
  bearFishArmWarped.height = sourceHeight + padding * 2
  const meshContext = bearFishArmWarped.getContext("2d")
  meshContext.imageSmoothingEnabled = true

  const shoulder = { x: 0, y: sourceHeight }
  const direction = { x: sourceWidth, y: -sourceHeight }
  const lengthSquared = direction.x ** 2 + direction.y ** 2
  const length = Math.sqrt(lengthSquared)
  const normal = { x: -direction.y / length, y: direction.x / length }
  const warpPoint = (x, y) => {
    const relativeX = x - shoulder.x
    const relativeY = y - shoulder.y
    const progress = clamp((relativeX * direction.x + relativeY * direction.y) / lengthSquared, 0, 1)
    const lateral = relativeX * normal.x + relativeY * normal.y
    const amount = armPlumpWeight(progress)
    return {
      x: x + normal.x * lateral * amount + padding,
      y: y + normal.y * lateral * amount + padding,
    }
  }

  const columns = 14
  const rows = 12
  const sourceGrid = []
  const destinationGrid = []
  for (let row = 0; row <= rows; row += 1) {
    sourceGrid[row] = []
    destinationGrid[row] = []
    for (let column = 0; column <= columns; column += 1) {
      const point = { x: column / columns * sourceWidth, y: row / rows * sourceHeight }
      sourceGrid[row][column] = point
      destinationGrid[row][column] = warpPoint(point.x, point.y)
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = sourceGrid[row][column]
      const topRight = sourceGrid[row][column + 1]
      const bottomLeft = sourceGrid[row + 1][column]
      const bottomRight = sourceGrid[row + 1][column + 1]
      const targetTopLeft = destinationGrid[row][column]
      const targetTopRight = destinationGrid[row][column + 1]
      const targetBottomLeft = destinationGrid[row + 1][column]
      const targetBottomRight = destinationGrid[row + 1][column + 1]
      drawWarpedTriangle(meshContext, bearFishArm, [topLeft, topRight, bottomRight], [targetTopLeft, targetTopRight, targetBottomRight])
      drawWarpedTriangle(meshContext, bearFishArm, [topLeft, bottomRight, bottomLeft], [targetTopLeft, targetBottomRight, targetBottomLeft])
    }
  }
  bearFishArmWarpedReady = true
}

function buildBearBodyMesh() {
  const sourceWidth = bearBody.naturalWidth
  const sourceHeight = bearBody.naturalHeight
  if (!sourceWidth || !sourceHeight) return
  const padding = bearBodyMeshPadding
  bearBodyWarped.width = sourceWidth + padding * 2
  bearBodyWarped.height = sourceHeight + padding * 2
  const meshContext = bearBodyWarped.getContext("2d")
  meshContext.imageSmoothingEnabled = true

  const warpPoint = (x, y) => {
    const nx = x / sourceWidth
    const ny = y / sourceHeight
    // A fuller local belly: the mesh expands the middle torso more strongly,
    // then feathers out before the face, feet and side seams.
    const verticalWeight = smoothstep(.58, .67, ny) * (1 - smoothstep(.87, .95, ny))
    const horizontalWeight = smoothstep(.14, .31, nx) * (1 - smoothstep(.69, .86, nx))
    // Do not pull the centre down: that made the torso read flattened. The
    // rounded read comes from an even, symmetric expansion of its silhouette.
    const outward = Math.sign(nx - .5) * 94 * verticalWeight * horizontalWeight
    return { x: x + outward + padding, y: y + padding }
  }

  const columns = 20
  const rows = 26
  const sourceGrid = []
  const destinationGrid = []
  for (let row = 0; row <= rows; row += 1) {
    sourceGrid[row] = []
    destinationGrid[row] = []
    for (let column = 0; column <= columns; column += 1) {
      const point = { x: column / columns * sourceWidth, y: row / rows * sourceHeight }
      sourceGrid[row][column] = point
      destinationGrid[row][column] = warpPoint(point.x, point.y)
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = sourceGrid[row][column]
      const topRight = sourceGrid[row][column + 1]
      const bottomLeft = sourceGrid[row + 1][column]
      const bottomRight = sourceGrid[row + 1][column + 1]
      const targetTopLeft = destinationGrid[row][column]
      const targetTopRight = destinationGrid[row][column + 1]
      const targetBottomLeft = destinationGrid[row + 1][column]
      const targetBottomRight = destinationGrid[row + 1][column + 1]
      drawWarpedTriangle(meshContext, bearBody, [topLeft, topRight, bottomRight], [targetTopLeft, targetTopRight, targetBottomRight])
      drawWarpedTriangle(meshContext, bearBody, [topLeft, bottomRight, bottomLeft], [targetTopLeft, targetBottomRight, targetBottomLeft])
    }
  }
  bearBodyWarpedReady = true
}

function drawBearBody(box, pivot, rotation, lift, scale) {
  const image = bearBodyWarpedReady ? bearBodyWarped : bearBody
  if (!bearBody.complete || !bearBody.naturalWidth) return
  const padding = bearBodyWarpedReady ? bearBodyMeshPadding : 0
  const w = canvas.width
  const h = canvas.height
  const paddingX = padding / bearBody.naturalWidth * box[2] * w
  const paddingY = padding / bearBody.naturalHeight * box[3] * h
  ctx.save()
  ctx.translate(pivot[0] * w, pivot[1] * h + lift)
  ctx.rotate(rotation)
  ctx.scale(scale, scale)
  // The unwarped body is a seamless watercolor underlay. It fills the tiny
  // anti-aliased joins between mesh triangles while the warped layer changes
  // only the belly silhouette above it.
  if (bearBodyWarpedReady) {
    ctx.drawImage(
      bearBody,
      (box[0] - pivot[0]) * w,
      (box[1] - pivot[1]) * h,
      box[2] * w,
      box[3] * h,
    )
  }
  ctx.drawImage(
    image,
    (box[0] - pivot[0]) * w - paddingX,
    (box[1] - pivot[1]) * h - paddingY,
    box[2] * w + paddingX * 2,
    box[3] * h + paddingY * 2,
  )
  ctx.restore()
}

function drawBearArm(time, lift, scale) {
  if (!bearFishArm.complete || !bearFishArm.naturalWidth) return
  const w = canvas.width
  const h = canvas.height
  const elapsed = time - bearWaveStartedAt
  const duration = 1360
  const waving = elapsed >= 0 && elapsed < duration
  const progress = waving ? elapsed / duration : 0
  // The source arm already points from its lower-left shoulder joint to the
  // upper-right fish. Keep that direction intact: no horizontal mirroring.
  const liftAmount = waving ? Math.sin(progress * Math.PI) : 0
  const wave = waving ? Math.sin(progress * Math.PI * 7) * .16 * liftAmount : 0
  // Keep the fish visibly held up, but lower the relaxed pose so it rests
  // closer to the cheek/chest instead of appearing raised beside the ear.
  const rotation = .11 - liftAmount * .18 + wave
  // The arm uses the same grounded character transform as the body. Keeping
  // this anchor in bear-local coordinates prevents scale-dependent drift.
  const pivot = scaleFromBearGround(bearRig.armPivotX, bearRig.armPivotY, scale)
  const pivotX = pivot.x
  const pivotY = pivot.y + canvasYForCssPixels(5)
  const armWidth = .146 * w * scale
  const armHeight = armWidth * (bearFishArm.naturalHeight / bearFishArm.naturalWidth)

  ctx.save()
  ctx.translate(pivotX * w, pivotY * h + lift)
  ctx.rotate(rotation)
  if (bearFishArmWarpedReady) {
    const scaleX = armWidth / bearFishArm.naturalWidth
    const scaleY = armHeight / bearFishArm.naturalHeight
    const paddingX = bearFishArmMeshPadding * scaleX
    const paddingY = bearFishArmMeshPadding * scaleY
    ctx.drawImage(
      bearFishArmWarped,
      -paddingX,
      -armHeight - paddingY,
      armWidth + paddingX * 2,
      armHeight + paddingY * 2,
    )
  } else ctx.drawImage(bearFishArm, 0, -armHeight, armWidth, armHeight)
  ctx.restore()
}

function drawBearPuppet(time) {
  if (!bearBody.complete || !bearBody.naturalWidth) return
  const horizontalAttention = pointer.active ? Math.max(-1, Math.min(1, (pointer.x - (.25 + bearLocalOffsetX())) * 6)) : 0
  const verticalAttention = pointer.active ? Math.max(-1, Math.min(1, (pointer.y - .52) * 5)) : 0
  const breathing = Math.sin(time * .004) * .003
  const attention = bearAwake * (horizontalAttention * .018 + breathing)
  const baseScale = bearRig.baseScale
  const lift = bearAwake * (-2.8 - verticalAttention * 1.2) * (canvas.height / 660) * baseScale
  const scale = baseScale * (1 + breathing * .65 + bearAwake * .012)
  // Preserve the native body ratio. This layer contains no arm or fish,
  // leaving a clean surface for the independently rigged front arm.
  const box = [.10 + bearLocalOffsetX(), .365, .23, .526]
  // Shrink from the feet, rather than the centre, so the seated bear remains
  // naturally grounded on the aquarium floor.
  const pivot = [bearRig.anchorX + bearLocalOffsetX(), bearRig.anchorY]

  drawBearBody(box, pivot, attention, lift, scale)
  drawBearArm(time, lift, scale)
}

function drawFish(f, time) {
  const fishSprite = fishSprites[f.kind]
  if (!fishSprite?.complete || !fishSprite.naturalWidth) return
  const w = canvas.width
  const speed = Math.hypot(f.vx, f.vy)
  const facing = f.vx < 0 ? -1 : 1
  const s = f.size * w
  const fishWidth = s * (f.kind === 5 ? 5.45 : 5.1)
  const fishHeight = fishWidth * (fishSprite.naturalHeight / fishSprite.naturalWidth)
  const bob = Math.sin(time * .0035 + f.phase) * s * .14
  ctx.save()
  ctx.translate(f.x * w, f.y * canvas.height + bob)
  ctx.scale(facing, 1)
  ctx.rotate(Math.max(-.35, Math.min(.35, f.vy / Math.max(speed, .00001) * .15)))
  ctx.globalAlpha = f.alpha
  ctx.drawImage(fishSprite, -fishWidth / 2, -fishHeight / 2, fishWidth, fishHeight)
  ctx.restore()
}

function update(f, dt, time) {
  const factor = calm ? .48 : 1
  f.phase += dt * .002
  f.vx += Math.sin(f.phase) * .000000018 * dt
  f.vy += Math.cos(f.phase * .83) * .000000014 * dt
  const pointerInTank = pointer.active && waterContains(pointer.x, pointer.y) && !lotusContains(pointer.x, pointer.y)
  const fleeing = time < f.fleeUntil
  if (fleeing) {
    f.pointerMix = 0
    if (pointerInTank) {
      const dx = f.x - pointer.x
      const dy = f.y - pointer.y
      const distance = Math.hypot(dx, dy) || 1
      f.vx += dx / distance * .0000034 * dt
      f.vy += dy / distance * .0000034 * dt
    }
  } else if (pointerInTank) f.pointerMix = Math.min(1, f.pointerMix + dt / f.warmup)
  else f.pointerMix = 0
  if (!fleeing && f.pointerMix > 0) {
    const orbitRadius = .025 + (f.kind % 4) * .012
    const bounds = swimBounds(f)
    const targetX = clamp(pointer.x + Math.cos(f.orbit + f.phase * .24) * orbitRadius, bounds.left, bounds.right)
    const targetY = clamp(pointer.y + Math.sin(f.orbit + f.phase * .31) * orbitRadius * .65, bounds.top, bounds.bottom)
    const dx = targetX - f.x
    const dy = targetY - f.y
    const pull = .0000048 * dt * f.pointerMix * f.curiosity
    f.vx += dx * pull * factor
    f.vy += dy * pull * factor
  }
  for (const other of fish) {
    if (other === f) continue
    const dx = f.x - other.x
    const dy = f.y - other.y
    const d = Math.hypot(dx, dy)
    if (d < .038 && d > 0) { f.vx += dx / d * .00000011 * dt; f.vy += dy / d * .000000085 * dt }
  }
  const max = fleeing
    ? .00016 * factor * f.speedScale
    : .00006 * factor * f.speedScale * (1 + f.pointerMix * .2)
  const speed = Math.hypot(f.vx, f.vy)
  if (speed > max) { f.vx = f.vx / speed * max; f.vy = f.vy / speed * max }
  f.x += f.vx * dt; f.y += f.vy * dt
  const bounds = swimBounds(f)
  if (f.x < bounds.left || f.x > bounds.right) { f.vx *= -1; f.x = clamp(f.x, bounds.left, bounds.right) }
  if (f.y < bounds.top || f.y > bounds.bottom) { f.vy *= -1; f.y = clamp(f.y, bounds.top, bounds.bottom) }
}

function scatterFish(time, x, y) {
  for (const f of fish) {
    let dx = f.x - x
    let dy = f.y - y
    if (Math.hypot(dx, dy) < .004) {
      dx = Math.cos(f.phase + f.orbit)
      dy = Math.sin(f.phase + f.orbit) * .65
    }
    const direction = Math.hypot(dx, dy) || 1
    const burst = .00017 * f.speedScale * f.burst * (calm ? .7 : 1)
    f.vx = dx / direction * burst
    f.vy = dy / direction * burst
    f.pointerMix = 0
    f.fleeUntil = time + 520 + Math.random() * 180
  }
  lastFleePointer = { x, y }
}

function drawPointerSignal(time) {
  if (!pointer.active || !waterContains(pointer.x, pointer.y) || lotusContains(pointer.x, pointer.y) || crabPlantContains(pointer.x, pointer.y)) return
  const w = canvas.width
  const h = canvas.height
  const pulse = .5 + .5 * Math.sin(time * .004)
  ctx.save()
  ctx.strokeStyle = `rgba(232, 177, 92, ${.18 + pulse * .12})`
  ctx.lineWidth = Math.max(1, w / 900)
  ctx.beginPath()
  ctx.arc(pointer.x * w, pointer.y * h, w * (.012 + pulse * .004), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function frame(time) {
  const dt = Math.min(32, time - lastTime); lastTime = time
  lotusClosed += (lotusClosedTarget - lotusClosed) * Math.min(1, dt / (lotusClosedTarget ? 180 : 300))
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawSceneBackground()
  drawBubbles(time, dt)
  drawCrab(time, true)
  drawAquariumPlants(time)
  drawInteractiveLotus()
  drawPointerSignal(time)
  triggerFishEscape(time)
  for (const f of fish) { update(f, dt, time); drawFish(f, time) }
  drawCrab(time, false)
  drawBearPuppet(time)
  updateCrabEscapeOverlay(time)
  if (bearAwake > 0) {
    bearAwake = Math.max(0, bearAwake - dt / 1100)
    const pulse = Math.sin(time * .012) * 5 + 16
    ctx.strokeStyle = `rgba(238,176,106,${bearAwake * .35})`; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(canvas.width * (.285 + bearLocalOffsetX()), canvas.height * .54, pulse, 0, Math.PI * 2); ctx.stroke()
  }
  requestAnimationFrame(frame)
}

function positionFromEvent(event) {
  const rect = canvas.getBoundingClientRect()
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
}

function positionHint(x, y) {
  // Keep the label near the pointer but flip its side before it can overlap
  // the aquarium edge or the waterline.
  const hintX = clamp(x + (x > .72 ? -.105 : .105), .14, .86)
  const hintY = clamp(y + (y < .49 ? .048 : -.048), .44, .66)
  hint.style.left = `${hintX * 100}%`
  hint.style.top = `${hintY * 100}%`
}

function releaseFish() {
  for (const f of fish) {
    f.pointerMix = 0
    const angle = f.phase + f.orbit
    const cruise = .000028 * f.speedScale
    f.vx = Math.cos(angle) * cruise
    f.vy = Math.sin(angle) * cruise * .58
  }
}

function startBearWave() {
  bearAwake = 1
  bearWaveStartedAt = performance.now()
}

function showNextBearGreeting() {
  bearGreetingIndex = (bearGreetingIndex + 1) % bearGreetings.length
  bearMessage.textContent = bearGreetings[bearGreetingIndex]
  bearMessage.classList.add("is-visible")
}

canvas.addEventListener("pointermove", event => {
  Object.assign(pointer, positionFromEvent(event), { active: true })
  const overLotus = lotusContains(pointer.x, pointer.y)
  const overCrabPlant = crabPlantContains(pointer.x, pointer.y)
  lotusClosedTarget = overLotus ? 1 : 0
  const inTank = waterContains(pointer.x, pointer.y) && !overLotus && !overCrabPlant
  if (!inTank) releaseFish()
  const overBear = bearContains(pointer.x, pointer.y)
  canvas.style.cursor = overBear || overLotus || overCrabPlant ? "pointer" : waterContains(pointer.x, pointer.y) ? "crosshair" : "default"
  if (overBear) {
    bearAwake = 1
    // Entering the bear zone starts one complete wave. Moving around inside
    // it does not restart the animation on every pointer event.
    if (!bearHovering) {
      startBearWave()
      showNextBearGreeting()
    }
  } else {
    // Leaving the bear zone gives a small goodbye wave before the character
    // settles back into its resting pose.
    if (bearHovering) startBearWave()
    bearMessage.classList.remove("is-visible")
  }
  bearHovering = overBear
  if (inTank || overCrabPlant) positionHint(pointer.x, pointer.y)
  hint.classList.toggle("is-visible", inTank || overCrabPlant)
  hint.classList.toggle("is-water-hint", inTank)
  hint.classList.toggle("is-grass-hint", overCrabPlant)
  hint.textContent = overCrabPlant ? "点一点水草，看看谁躲在后面" : inTank ? "它们发现你了 · 轻点水面试试看" : "把鼠标轻轻移进鱼缸水面下方"
})
canvas.addEventListener("pointerleave", () => {
  pointer.active = false
  lotusClosedTarget = 0
  if (bearHovering) startBearWave()
  bearHovering = false
  releaseFish()
  hint.classList.remove("is-visible")
  hint.classList.remove("is-water-hint", "is-grass-hint")
  bearMessage.classList.remove("is-visible")
})
canvas.addEventListener("click", event => {
  const p = positionFromEvent(event)
  if (crabPlantContains(p.x, p.y)) {
    startCrabEscape(performance.now())
    hint.textContent = "小螃蟹溜出去啦～"
    hint.classList.add("is-visible")
    return
  }
  if (waterContains(p.x, p.y) && !lotusContains(p.x, p.y)) {
    scatterFish(performance.now(), p.x, p.y)
    hint.textContent = "呀，它们一下躲开了"
    hint.classList.add("is-visible")
    return
  }
  if (!bearContains(p.x, p.y)) return
  bearAwake = 1
  bearMessage.classList.add("is-visible")
})
if (calmToggle) calmToggle.addEventListener("click", () => { calm = !calm; calmToggle.setAttribute("aria-pressed", String(calm)); calmToggle.textContent = calm ? "安静模式 · 开" : "安静模式" })
document.getElementById("reset-fish")?.addEventListener("click", seedFish)
window.addEventListener("resize", resize)
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resize).observe(canvas)
}
background.addEventListener("load", () => { resize(); hint.classList.add("is-visible"); setTimeout(() => hint.classList.remove("is-visible"), 2400) })
seedFish(); seedBubbles(); resize(); requestAnimationFrame(frame)
