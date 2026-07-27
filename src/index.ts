// fluidkit — framework-agnostic GPU fluid simulation.
// SSR-safe: nothing here touches window/document until createFluid() is called.

import { createProgram, createFBO, createDoubleFBO, type Program, type FBO, type DoubleFBO } from './webgl.js'
import * as sh from './shaders.js'
import { dye, type RenderMode } from './render.js'
import { DEFAULTS, parseColor, hsv, computeResolution, type FluidParams, type Color } from './utils.js'

export { dye, threshold, custom, displacement, ramp } from './render.js'
export type {
  RenderMode, ThresholdLevel, ThresholdOptions, CustomOptions,
  DyeOptions, DisplacementOptions, RampOptions,
} from './render.js'
export { DEFAULTS, parseColor, computeResolution } from './utils.js'
export type { FluidParams, Color } from './utils.js'

export interface PointerOptions {
  /** Fixed color, palette cycled per pointer, or omit for rainbow. */
  color?: Color | Color[]
  /** Dye amount per splat (default 0.15). Higher = denser trails. */
  intensity?: number
  /** Multiplier on params.splatRadius for pointer splats. Default 1. */
  radius?: number
  /** Only emit while a button/finger is down (default false = emit on hover too). */
  dragOnly?: boolean
}

export interface AmbientOptions {
  /** Force of the wandering emitters. ~0.2–0.5. */
  strength?: number
  /** Number of wanderers. Default 3. */
  count?: number
  /** Palette cycled across wanderers; omit for rainbow drift. */
  colors?: Color[]
  /** Multiplier on params.splatRadius for ambient splats. Default 0.6. */
  radius?: number
}

export type MaskSource = TexImageSource | string

export interface MaskEmitterOptions {
  /** White-on-transparent (or white-on-black) mask: canvas, image, bitmap, or URL. See textMask(). */
  source: MaskSource
  /** Dye color emitted from the mask. Default soft white. */
  color?: Color
  /** Dye per second emitted where the mask is opaque. Default 1. */
  strength?: number
}

export interface EmitterOptions {
  /** Mouse/touch splats (multi-touch aware). Default true. Pass an object for full control. */
  pointer?: boolean | PointerOptions
  /** Wandering emitters for motion without interaction. Default off. */
  ambient?: boolean | AmbientOptions
  /** Emit dye from a text/image mask ("pour from a logo"). Also settable via fluid.setEmitterMask(). */
  mask?: MaskEmitterOptions
}

/** Rasterize text to a white-on-transparent canvas, for setEmitterMask()/setObstacle(). */
export function textMask(
  text: string,
  opts: { font?: string; weight?: string | number; size?: number; aspect?: number } = {},
): HTMLCanvasElement {
  const aspect = opts.aspect ?? 2 // width/height of the mask canvas — stretched to fit yours
  const w = 1024
  const h = Math.round(w / aspect)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.font = `${opts.weight ?? 800} ${Math.round((opts.size ?? 0.35) * h)}px ${opts.font ?? 'system-ui, sans-serif'}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#fff'
  g.fillText(text, w / 2, h / 2)
  return c
}

export interface FluidOptions extends Partial<FluidParams> {
  /** 'webgpu' is not implemented yet (PRD P1); 'auto' currently resolves to webgl2. */
  backend?: 'auto' | 'webgl2' | 'webgpu'
  render?: RenderMode
  emitters?: EmitterOptions
  /** When the user prefers reduced motion, stay paused (default true). */
  respectReducedMotion?: boolean
  /** Called every frame before the sim step — the place to drive emitters. */
  onFrame?: (t: number, dt: number) => void
  /** Halve dyeResolution (floor 256) under sustained frame overruns. Default true. */
  autoQuality?: boolean
}

export interface SplatOptions {
  color?: Color
  radius?: number
}

export interface Fluid {
  /** Live-tunable simulation parameters. */
  params: FluidParams
  /** Inject a droplet. x/y in [0,1] (y up), dx/dy velocity (pointer-flick scale ≈ 0–1000). */
  splat(x: number, y: number, dx: number, dy: number, opts?: SplatOptions): void
  setRenderMode(mode: RenderMode): void
  /** Emit dye continuously from a mask's opaque pixels; null disables. */
  setEmitterMask(source: MaskSource | null, opts?: { color?: Color; strength?: number }): void
  /** Fluid flows around the mask's opaque pixels; null disables. */
  setObstacle(source: MaskSource | null): void
  /** Clear all fields back to still, empty fluid. */
  reset(): void
  /** Render a frame and return it as a PNG data URL. */
  screenshot(): string
  /** Raw field texture for three.js/pixi interop. */
  getTexture(field: 'dye' | 'velocity' | 'pressure'): WebGLTexture
  pause(): void
  resume(): void
  destroy(): void
  readonly canvas: HTMLCanvasElement
}

export function createFluid(canvas: HTMLCanvasElement, options: FluidOptions = {}): Fluid {
  if (options.backend === 'webgpu')
    throw new Error("fluidkit: webgpu backend not implemented yet — use 'auto' or 'webgl2'")

  const params: FluidParams = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof FluidParams)[])
    if (options[k] !== undefined) params[k] = options[k]!

  const gl = canvas.getContext('webgl2', {
    alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false,
  })
  if (!gl) throw new Error('fluidkit: WebGL2 not supported')

  // ---- GL state (rebuilt on context restore) ----
  let progs: Record<string, Program>
  let displayProg: Program | null = null
  let quadBuf: WebGLBuffer, idxBuf: WebGLBuffer
  let velocity: DoubleFBO, dyeField: DoubleFBO, pressure: DoubleFBO
  let divergence: FBO, curl: FBO
  let renderMode: RenderMode = options.render ?? dye()
  let appliedSimRes = 0, appliedDyeRes = 0

  function initGL() {
    if (!gl!.getExtension('EXT_color_buffer_float'))
      // ponytail: no 8-bit fallback path — every WebGL2 device we care about has this; add fallback formats if the field disagrees
      throw new Error('fluidkit: EXT_color_buffer_float unavailable')
    gl!.disable(gl!.BLEND)

    quadBuf = gl!.createBuffer()!
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuf)
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl!.STATIC_DRAW)
    idxBuf = gl!.createBuffer()!
    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, idxBuf)
    gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl!.STATIC_DRAW)
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0)
    gl!.enableVertexAttribArray(0)

    progs = {
      copy: createProgram(gl!, sh.baseVertex, sh.copyFrag),
      maskEmit: createProgram(gl!, sh.baseVertex, sh.maskEmitFrag),
      obstacle: createProgram(gl!, sh.baseVertex, sh.obstacleFrag),
      splat: createProgram(gl!, sh.baseVertex, sh.splatFrag),
      gravity: createProgram(gl!, sh.baseVertex, sh.gravityFrag),
      advection: createProgram(gl!, sh.baseVertex, sh.advectionFrag),
      curl: createProgram(gl!, sh.baseVertex, sh.curlFrag),
      vorticity: createProgram(gl!, sh.baseVertex, sh.vorticityFrag),
      divergence: createProgram(gl!, sh.baseVertex, sh.divergenceFrag),
      clear: createProgram(gl!, sh.baseVertex, sh.clearFrag),
      pressure: createProgram(gl!, sh.baseVertex, sh.pressureFrag),
      gradient: createProgram(gl!, sh.baseVertex, sh.gradientSubtractFrag),
    }
    displayProg = null
    setRenderMode(renderMode)
    initFramebuffers()
  }

  function initFramebuffers() {
    const simRes = computeResolution(params.simResolution, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
    const dyeRes = computeResolution(params.dyeResolution, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
    const HF = gl!.HALF_FLOAT
    const oldVelocity = velocity, oldDye = dyeField
    pressure?.dispose(); divergence?.dispose(); curl?.dispose()
    velocity = createDoubleFBO(gl!, simRes.width, simRes.height, gl!.RG16F, gl!.RG, HF, gl!.LINEAR)
    dyeField = createDoubleFBO(gl!, dyeRes.width, dyeRes.height, gl!.RGBA16F, gl!.RGBA, HF, gl!.LINEAR)
    pressure = createDoubleFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
    divergence = createFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
    curl = createFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
    if (oldVelocity) {
      // carry the fields across resize/resolution changes instead of flashing to empty
      const un = progs.copy.uniforms
      gl!.useProgram(progs.copy.program)
      gl!.uniform1i(un.uTexture, oldVelocity.read.attach(0))
      blit(velocity.write); velocity.swap()
      gl!.uniform1i(un.uTexture, oldDye.read.attach(0))
      blit(dyeField.write); dyeField.swap()
      oldVelocity.dispose(); oldDye.dispose()
    }
    appliedSimRes = params.simResolution
    appliedDyeRes = params.dyeResolution
  }

  function blit(target: FBO | null) {
    if (target) {
      gl!.viewport(0, 0, target.width, target.height)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.fbo)
    } else {
      gl!.viewport(0, 0, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
    }
    gl!.drawElements(gl!.TRIANGLES, 6, gl!.UNSIGNED_SHORT, 0)
  }

  function setRenderMode(mode: RenderMode) {
    if (displayProg) gl!.deleteProgram(displayProg.program)
    if (renderMode !== mode) renderMode.dispose?.(gl!)
    displayProg = createProgram(gl!, sh.baseVertex, mode.frag)
    renderMode = mode
  }

  // ---- simulation step ----
  function step(dt: number) {
    const u = (p: Program) => (gl!.useProgram(p.program), p.uniforms)
    const simTexel = (un: Record<string, WebGLUniformLocation>) =>
      gl!.uniform2f(un.texelSize, velocity.texelSizeX, velocity.texelSizeY)

    let un: Record<string, WebGLUniformLocation>
    if (params.gravity !== 0) {
      un = u(progs.gravity)
      gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
      gl!.uniform1i(un.uDye, dyeField.read.attach(1))
      gl!.uniform1f(un.gravity, params.gravity)
      gl!.uniform1f(un.dt, dt)
      blit(velocity.write)
      velocity.swap()
    }

    un = u(progs.curl)
    simTexel(un)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    blit(curl)

    un = u(progs.vorticity)
    simTexel(un)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    gl!.uniform1i(un.uCurl, curl.attach(1))
    gl!.uniform1f(un.curl, params.curl)
    gl!.uniform1f(un.dt, dt)
    blit(velocity.write)
    velocity.swap()

    un = u(progs.divergence)
    simTexel(un)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    blit(divergence)

    un = u(progs.clear)
    gl!.uniform1i(un.uTexture, pressure.read.attach(0))
    gl!.uniform1f(un.value, params.pressure)
    blit(pressure.write)
    pressure.swap()

    un = u(progs.pressure)
    simTexel(un)
    gl!.uniform1i(un.uDivergence, divergence.attach(0))
    for (let i = 0; i < params.pressureIterations; i++) {
      gl!.uniform1i(un.uPressure, pressure.read.attach(1))
      blit(pressure.write)
      pressure.swap()
    }

    un = u(progs.gradient)
    simTexel(un)
    gl!.uniform1i(un.uPressure, pressure.read.attach(0))
    gl!.uniform1i(un.uVelocity, velocity.read.attach(1))
    blit(velocity.write)
    velocity.swap()

    un = u(progs.advection)
    simTexel(un)
    gl!.uniform1f(un.dt, dt)
    gl!.uniform2f(un.drift, 0, 0)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    gl!.uniform1i(un.uSource, velocity.read.attach(0))
    gl!.uniform1f(un.dissipation, params.velocityDissipation)
    blit(velocity.write)
    velocity.swap()

    gl!.uniform2f(un.drift, params.wind, params.gravity)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    gl!.uniform1i(un.uSource, dyeField.read.attach(1))
    gl!.uniform1f(un.dissipation, params.densityDissipation)
    blit(dyeField.write)
    dyeField.swap()

    if (obstacleMask) {
      // ponytail: velocity-only obstacle — gravity/wind drift can still seep dye through slowly;
      // mask the drift in the advection shader if that ever shows
      un = u(progs.obstacle)
      gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
      gl!.activeTexture(gl!.TEXTURE1)
      gl!.bindTexture(gl!.TEXTURE_2D, obstacleMask.tex)
      gl!.uniform1i(un.uMask, 1)
      blit(velocity.write)
      velocity.swap()
    }
  }

  function render(time: number) {
    const un = displayProg!.uniforms
    gl!.useProgram(displayProg!.program)
    gl!.uniform2f(un.texelSize, 1 / gl!.drawingBufferWidth, 1 / gl!.drawingBufferHeight)
    if (un.uDye) gl!.uniform1i(un.uDye, dyeField.read.attach(0))
    if (un.uVelocity) gl!.uniform1i(un.uVelocity, velocity.read.attach(1))
    if (un.uPressure) gl!.uniform1i(un.uPressure, pressure.read.attach(2))
    if (un.uTime) gl!.uniform1f(un.uTime, time)
    renderMode.apply?.(gl!, un)
    blit(null)
  }

  // ---- masks (emitter + obstacle) ----
  interface MaskState { tex: WebGLTexture; color: [number, number, number]; strength: number }
  let emitterMask: MaskState | null = null
  let obstacleMask: { tex: WebGLTexture } | null = null

  function uploadMask(source: TexImageSource): WebGLTexture {
    const tex = gl!.createTexture()!
    gl!.activeTexture(gl!.TEXTURE0)
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true) // mask uv matches the y-up field uv
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source)
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false)
    return tex
  }

  function withMaskSource(source: MaskSource, cb: (s: TexImageSource) => void) {
    if (typeof source === 'string') {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => cb(img)
      img.src = source
    } else cb(source)
  }

  function setEmitterMask(source: MaskSource | null, opts: { color?: Color; strength?: number } = {}) {
    if (emitterMask) { gl!.deleteTexture(emitterMask.tex); emitterMask = null }
    if (!source) return
    withMaskSource(source, s => {
      emitterMask = {
        tex: uploadMask(s),
        color: opts.color ? parseColor(opts.color) : [0.4, 0.4, 0.4],
        strength: opts.strength ?? 1,
      }
    })
  }

  function setObstacle(source: MaskSource | null) {
    if (obstacleMask) { gl!.deleteTexture(obstacleMask.tex); obstacleMask = null }
    if (!source) return
    withMaskSource(source, s => { obstacleMask = { tex: uploadMask(s) } })
  }

  function applyMaskEmission(dt: number) {
    if (!emitterMask) return
    const un = progs.maskEmit.uniforms
    gl!.useProgram(progs.maskEmit.program)
    gl!.uniform1i(un.uTarget, dyeField.read.attach(0))
    gl!.activeTexture(gl!.TEXTURE1)
    gl!.bindTexture(gl!.TEXTURE_2D, emitterMask.tex)
    gl!.uniform1i(un.uMask, 1)
    const [r, g, b] = emitterMask.color
    gl!.uniform3f(un.color, r, g, b)
    gl!.uniform1f(un.amount, emitterMask.strength * dt)
    blit(dyeField.write)
    dyeField.swap()
  }

  // ---- splats ----
  interface QueuedSplat { x: number; y: number; dx: number; dy: number; color: [number, number, number]; radius: number }
  const splatQueue: QueuedSplat[] = []

  function correctRadius(r: number) {
    const aspect = canvas.width / canvas.height
    return aspect > 1 ? r * aspect : r
  }

  function applySplat(s: QueuedSplat) {
    let un = progs.splat.uniforms
    gl!.useProgram(progs.splat.program)
    gl!.uniform1i(un.uTarget, velocity.read.attach(0))
    gl!.uniform1f(un.aspectRatio, canvas.width / canvas.height)
    gl!.uniform2f(un.point, s.x, s.y)
    gl!.uniform3f(un.color, s.dx, s.dy, 0)
    gl!.uniform1f(un.radius, correctRadius(s.radius / 100))
    blit(velocity.write)
    velocity.swap()

    gl!.uniform1i(un.uTarget, dyeField.read.attach(0))
    gl!.uniform3f(un.color, s.color[0], s.color[1], s.color[2])
    blit(dyeField.write)
    dyeField.swap()
  }

  // ---- emitters ----
  const emitterOpts = options.emitters ?? {}
  const pointerEnabled = emitterOpts.pointer !== false
  const pOpts: PointerOptions = typeof emitterOpts.pointer === 'object' ? emitterOpts.pointer : {}
  const pIntensity = pOpts.intensity ?? 0.15
  const pRadiusMul = pOpts.radius ?? 1
  const pPalette: [number, number, number][] | null = pOpts.color
    ? (Array.isArray(pOpts.color) && Array.isArray(pOpts.color[0])
        ? (pOpts.color as Color[]).map(parseColor)
        : typeof pOpts.color === 'string' || typeof pOpts.color[0] === 'number'
          ? [parseColor(pOpts.color as Color)]
          : (pOpts.color as Color[]).map(parseColor))
    : null

  const aOpts: AmbientOptions | null =
    emitterOpts.ambient === true ? {}
    : typeof emitterOpts.ambient === 'object' ? emitterOpts.ambient
    : null
  const ambientStrength = aOpts ? (aOpts.strength ?? 0.2) : 0
  const ambientRadiusMul = aOpts?.radius ?? 0.6
  const ambientPalette = aOpts?.colors?.map(parseColor)

  const pointers = new Map<number, { x: number; y: number }>()
  function pointerColor(id: number): [number, number, number] {
    const [r, g, b] = pPalette
      ? pPalette[id % pPalette.length]
      : hsv(performance.now() * 0.00005 + id * 0.61, 1, 1)
    return [r * pIntensity, g * pIntensity, b * pIntensity]
  }
  function onPointerMove(e: PointerEvent) {
    if (pOpts.dragOnly && e.buttons === 0) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = (e.clientX - rect.left) / rect.width
    const y = 1 - (e.clientY - rect.top) / rect.height
    const p = pointers.get(e.pointerId)
    if (!p) { pointers.set(e.pointerId, { x, y }); return }
    const dx = (x - p.x) * params.splatForce
    const dy = (y - p.y) * params.splatForce
    p.x = x; p.y = y
    if (dx !== 0 || dy !== 0)
      splatQueue.push({ x, y, dx, dy, color: pointerColor(e.pointerId), radius: params.splatRadius * pRadiusMul })
  }
  function onPointerEnd(e: PointerEvent) { pointers.delete(e.pointerId) }

  // ponytail: lissajous wanderers stand in for curl noise — swap in simplex-curl if the paths read as too orbital
  const agents = Array.from({ length: aOpts?.count ?? 3 }, (_, i) => ({ seed: 17.3 * (i + 1), px: NaN, py: NaN }))
  function ambientStep(t: number) {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]
      const x = 0.5 + 0.38 * Math.sin(t * 0.21 + a.seed) * Math.sin(t * 0.117 + a.seed * 2.7)
      const y = 0.5 + 0.38 * Math.sin(t * 0.163 + a.seed * 1.9) * Math.cos(t * 0.141 + a.seed)
      if (!Number.isNaN(a.px)) {
        const dx = (x - a.px) * params.splatForce * ambientStrength * 8
        const dy = (y - a.py) * params.splatForce * ambientStrength * 8
        const [r, g, b] = ambientPalette
          ? ambientPalette[i % ambientPalette.length]
          : hsv(t * 0.02 + a.seed, 0.9, 1)
        splatQueue.push({ x, y, dx, dy, color: [r * 0.08, g * 0.08, b * 0.08], radius: params.splatRadius * ambientRadiusMul })
      }
      a.px = x; a.py = y
    }
  }

  // ---- loop & lifecycle ----
  let raf = 0
  let lastTime = -1 // rAF timebase; -1 = no previous frame (skip step, just render)
  let paused = false
  let intersecting = true
  let contextLost = false
  let destroyed = false
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  const respectReduced = options.respectReducedMotion !== false

  function shouldRun() {
    return !destroyed && !paused && !contextLost && intersecting && !document.hidden
      && !(respectReduced && reducedMotion?.matches)
  }
  function ensureLoop() {
    if (shouldRun() && !raf) {
      lastTime = -1 // dt restarts from the next rAF timestamp — never mix in performance.now()
      raf = requestAnimationFrame(frame)
    } else if (!shouldRun() && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  function resizeIfNeeded(): boolean {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      return true
    }
    return params.simResolution !== appliedSimRes || params.dyeResolution !== appliedDyeRes
  }

  let frameEma = 0
  let qualityCounter = 0
  function frame(now: number) {
    raf = shouldRun() ? requestAnimationFrame(frame) : 0
    const rawDt = lastTime < 0 ? 0 : Math.max((now - lastTime) / 1000, 0)
    const dt = Math.min(rawDt, 1 / 30)
    lastTime = now
    if (options.autoQuality !== false && rawDt > 0) {
      frameEma = frameEma ? frameEma * 0.95 + rawDt * 0.05 : rawDt
      // ponytail: downscale only, no recovery — upscaling oscillates on thermally-throttled phones
      if (++qualityCounter > 180 && frameEma > 0.03 && params.dyeResolution > 256) {
        params.dyeResolution = Math.max(256, Math.floor(params.dyeResolution / 2))
        qualityCounter = 0
      }
    }
    // ponytail: resize recreates FBOs and drops the current dye — copy-resize like Pavel's if the flash ever matters
    if (resizeIfNeeded()) initFramebuffers()
    options.onFrame?.(now / 1000, dt)
    if (ambientStrength > 0) ambientStep(now / 1000)
    for (const s of splatQueue) applySplat(s)
    splatQueue.length = 0
    const sdt = dt * params.speed
    if (sdt > 0) {
      applyMaskEmission(sdt)
      step(sdt)
    }
    render(now / 1000)
  }

  const onVisibility = () => ensureLoop()
  const onReducedChange = () => ensureLoop()
  const onContextLost = (e: Event) => { e.preventDefault(); contextLost = true; ensureLoop() }
  const onContextRestored = () => {
    contextLost = false
    // old FBO handles died with the context — clear them so initFramebuffers doesn't copy from ghosts
    velocity = dyeField = pressure = undefined as unknown as DoubleFBO
    divergence = curl = undefined as unknown as FBO
    initGL()
    ensureLoop()
  }

  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)
  document.addEventListener('visibilitychange', onVisibility)
  reducedMotion?.addEventListener?.('change', onReducedChange)
  if (pointerEnabled) {
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerEnd)
    canvas.addEventListener('pointerleave', onPointerEnd)
    canvas.addEventListener('pointercancel', onPointerEnd)
  }
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        intersecting = entries[entries.length - 1].isIntersecting
        ensureLoop()
      })
    : null
  observer?.observe(canvas)

  // Size the canvas before first FBO allocation so grids match the real aspect.
  resizeIfNeeded()
  initGL()
  if (emitterOpts.mask) setEmitterMask(emitterOpts.mask.source, emitterOpts.mask)
  ensureLoop()

  return {
    params,
    canvas,
    splat(x, y, dx, dy, opts = {}) {
      splatQueue.push({
        x, y, dx, dy,
        color: opts.color ? parseColor(opts.color) : pointerColor(0),
        radius: opts.radius ?? params.splatRadius,
      })
    },
    setRenderMode(mode) { setRenderMode(mode) },
    setEmitterMask,
    setObstacle,
    reset() {
      gl!.clearColor(0, 0, 0, 0)
      for (const f of [velocity.read, velocity.write, dyeField.read, dyeField.write,
                       pressure.read, pressure.write, divergence, curl]) {
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, f.fbo)
        gl!.clear(gl!.COLOR_BUFFER_BIT)
      }
    },
    screenshot() {
      // draw + read in the same task, before the compositor clears the (non-preserved) buffer
      render(performance.now() / 1000)
      return canvas.toDataURL('image/png')
    },
    getTexture(field) {
      const map = { dye: dyeField, velocity, pressure } as const
      return map[field].read.texture
    },
    pause() { paused = true; ensureLoop() },
    resume() { paused = false; ensureLoop() },
    destroy() {
      destroyed = true
      ensureLoop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reducedMotion?.removeEventListener?.('change', onReducedChange)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerEnd)
      canvas.removeEventListener('pointerleave', onPointerEnd)
      canvas.removeEventListener('pointercancel', onPointerEnd)
      velocity.dispose(); dyeField.dispose(); pressure.dispose()
      divergence.dispose(); curl.dispose()
      renderMode.dispose?.(gl!)
      setEmitterMask(null)
      setObstacle(null)
      for (const p of Object.values(progs)) gl!.deleteProgram(p.program)
      if (displayProg) gl!.deleteProgram(displayProg.program)
      gl!.deleteBuffer(quadBuf)
      gl!.deleteBuffer(idxBuf)
    },
  }
}
