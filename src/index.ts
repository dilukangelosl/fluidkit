// fluidkit — framework-agnostic GPU fluid simulation.
// SSR-safe: nothing here touches window/document until createFluid() is called.

import { createProgram, createFBO, createDoubleFBO, type Program, type FBO, type DoubleFBO } from './webgl.js'
import * as sh from './shaders.js'
import { dye, type RenderMode } from './render.js'
import { DEFAULTS, parseColor, hsv, computeResolution, type FluidParams, type Color } from './utils.js'

export { dye, threshold, custom } from './render.js'
export type { RenderMode, ThresholdLevel, ThresholdOptions, CustomOptions } from './render.js'
export { DEFAULTS, parseColor, computeResolution } from './utils.js'
export type { FluidParams, Color } from './utils.js'

export interface EmitterOptions {
  /** Mouse/touch splats (multi-touch aware). Default true. */
  pointer?: boolean
  /** Curl-ish ambient wander for motion without interaction. Default off. */
  ambient?: boolean | { strength?: number }
}

export interface FluidOptions extends Partial<FluidParams> {
  /** 'webgpu' is not implemented yet (PRD P1); 'auto' currently resolves to webgl2. */
  backend?: 'auto' | 'webgl2' | 'webgpu'
  render?: RenderMode
  emitters?: EmitterOptions
  /** When the user prefers reduced motion, stay paused (default true). */
  respectReducedMotion?: boolean
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
    velocity?.dispose(); dyeField?.dispose(); pressure?.dispose()
    divergence?.dispose(); curl?.dispose()
    const simRes = computeResolution(params.simResolution, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
    const dyeRes = computeResolution(params.dyeResolution, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
    const HF = gl!.HALF_FLOAT
    velocity = createDoubleFBO(gl!, simRes.width, simRes.height, gl!.RG16F, gl!.RG, HF, gl!.LINEAR)
    dyeField = createDoubleFBO(gl!, dyeRes.width, dyeRes.height, gl!.RGBA16F, gl!.RGBA, HF, gl!.LINEAR)
    pressure = createDoubleFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
    divergence = createFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
    curl = createFBO(gl!, simRes.width, simRes.height, gl!.R16F, gl!.RED, HF, gl!.NEAREST)
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
    gl!.uniform1f(un.sink, 0)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    gl!.uniform1i(un.uSource, velocity.read.attach(0))
    gl!.uniform1f(un.dissipation, params.velocityDissipation)
    blit(velocity.write)
    velocity.swap()

    gl!.uniform1f(un.sink, params.gravity)
    gl!.uniform1i(un.uVelocity, velocity.read.attach(0))
    gl!.uniform1i(un.uSource, dyeField.read.attach(1))
    gl!.uniform1f(un.dissipation, params.densityDissipation)
    blit(dyeField.write)
    dyeField.swap()
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
  const ambientStrength =
    emitterOpts.ambient === true ? 0.2
    : typeof emitterOpts.ambient === 'object' ? (emitterOpts.ambient.strength ?? 0.2)
    : 0

  const pointers = new Map<number, { x: number; y: number }>()
  function pointerColor(id: number): [number, number, number] {
    const [r, g, b] = hsv(performance.now() * 0.00005 + id * 0.61, 1, 1)
    return [r * 0.15, g * 0.15, b * 0.15]
  }
  function onPointerMove(e: PointerEvent) {
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
      splatQueue.push({ x, y, dx, dy, color: pointerColor(e.pointerId), radius: params.splatRadius })
  }
  function onPointerEnd(e: PointerEvent) { pointers.delete(e.pointerId) }

  // ponytail: 3 lissajous wanderers stand in for curl noise — swap in simplex-curl if the paths read as too orbital
  const agents = [0, 1, 2].map(i => ({ seed: 17.3 * (i + 1), px: NaN, py: NaN }))
  function ambientStep(t: number) {
    for (const a of agents) {
      const x = 0.5 + 0.38 * Math.sin(t * 0.21 + a.seed) * Math.sin(t * 0.117 + a.seed * 2.7)
      const y = 0.5 + 0.38 * Math.sin(t * 0.163 + a.seed * 1.9) * Math.cos(t * 0.141 + a.seed)
      if (!Number.isNaN(a.px)) {
        const dx = (x - a.px) * params.splatForce * ambientStrength * 8
        const dy = (y - a.py) * params.splatForce * ambientStrength * 8
        const [r, g, b] = hsv(t * 0.02 + a.seed, 0.9, 1)
        splatQueue.push({ x, y, dx, dy, color: [r * 0.08, g * 0.08, b * 0.08], radius: params.splatRadius * 0.6 })
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

  function frame(now: number) {
    raf = shouldRun() ? requestAnimationFrame(frame) : 0
    const dt = lastTime < 0 ? 0 : Math.min(Math.max((now - lastTime) / 1000, 0), 1 / 30)
    lastTime = now
    // ponytail: resize recreates FBOs and drops the current dye — copy-resize like Pavel's if the flash ever matters
    if (resizeIfNeeded()) initFramebuffers()
    if (ambientStrength > 0) ambientStep(now / 1000)
    for (const s of splatQueue) applySplat(s)
    splatQueue.length = 0
    if (dt > 0) step(dt)
    render(now / 1000)
  }

  const onVisibility = () => ensureLoop()
  const onReducedChange = () => ensureLoop()
  const onContextLost = (e: Event) => { e.preventDefault(); contextLost = true; ensureLoop() }
  const onContextRestored = () => { contextLost = false; initGL(); ensureLoop() }

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
      for (const p of Object.values(progs)) gl!.deleteProgram(p.program)
      if (displayProg) gl!.deleteProgram(displayProg.program)
      gl!.deleteBuffer(quadBuf)
      gl!.deleteBuffer(idxBuf)
    },
  }
}
