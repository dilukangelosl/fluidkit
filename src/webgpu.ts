// EXPERIMENTAL WebGPU backend — import from '@dilukangelo/fluidkit/webgpu'.
// Same Stable Fluids pass graph as the WebGL2 core, ported to WGSL compute.
// v0 scope: dye rendering, pointer/ambient/programmatic splats, live params
// (curl, pressureIterations, dissipations, gravity, wind, speed, splat*).
// Not yet here: threshold/ramp/displacement/custom modes, masks, obstacles,
// getTexture interop. Use the WebGL2 core for those.
// ponytail: host lifecycle is duplicated from index.ts rather than abstracted —
// unify behind one backend interface when this graduates from experimental.

import { DEFAULTS, parseColor, hsv, computeResolution, type FluidParams, type Color } from './utils.js'

export interface FluidGPUOptions extends Partial<FluidParams> {
  emitters?: {
    pointer?: boolean
    ambient?: boolean | { strength?: number }
  }
  /** Dye brightness multiplier. */
  brightness?: number
  respectReducedMotion?: boolean
}

export interface FluidGPU {
  params: FluidParams
  splat(x: number, y: number, dx: number, dy: number, opts?: { color?: Color; radius?: number }): void
  pause(): void
  resume(): void
  destroy(): void
  readonly canvas: HTMLCanvasElement
  readonly backend: 'webgpu'
}

export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

// ---------------------------------------------------------------- WGSL

const WG = 8

const splatWGSL = /* wgsl */ `
struct U { point: vec2f, value: vec4f, radius: f32, aspect: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(src);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var p = uv - u.point;
  p.x *= u.aspect;
  let add = exp(-dot(p, p) / u.radius) * u.value.xyz;
  let base = textureLoad(src, vec2i(id.xy), 0).xyz;
  textureStore(dst, vec2i(id.xy), vec4f(base + add, 1.0));
}`

const curlWGSL = /* wgsl */ `
@group(0) @binding(0) var vel: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(vel));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  let L = textureLoad(vel, clamp(c + vec2i(-1, 0), vec2i(0), size - 1), 0).y;
  let R = textureLoad(vel, clamp(c + vec2i( 1, 0), vec2i(0), size - 1), 0).y;
  let T = textureLoad(vel, clamp(c + vec2i(0,  1), vec2i(0), size - 1), 0).x;
  let B = textureLoad(vel, clamp(c + vec2i(0, -1), vec2i(0), size - 1), 0).x;
  textureStore(dst, c, vec4f(0.5 * (R - L - T + B), 0.0, 0.0, 1.0));
}`

const vorticityWGSL = /* wgsl */ `
struct U { curl: f32, dt: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var crl: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(vel));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  let L = textureLoad(crl, clamp(c + vec2i(-1, 0), vec2i(0), size - 1), 0).x;
  let R = textureLoad(crl, clamp(c + vec2i( 1, 0), vec2i(0), size - 1), 0).x;
  let T = textureLoad(crl, clamp(c + vec2i(0,  1), vec2i(0), size - 1), 0).x;
  let B = textureLoad(crl, clamp(c + vec2i(0, -1), vec2i(0), size - 1), 0).x;
  let C = textureLoad(crl, c, 0).x;
  var force = 0.5 * vec2f(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= u.curl * C;
  force.y *= -1.0;
  let v = textureLoad(vel, c, 0).xy + force * u.dt;
  textureStore(dst, c, vec4f(clamp(v, vec2f(-1000.0), vec2f(1000.0)), 0.0, 1.0));
}`

const divergenceWGSL = /* wgsl */ `
@group(0) @binding(0) var vel: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(vel));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  let Cv = textureLoad(vel, c, 0).xy;
  var L = textureLoad(vel, clamp(c + vec2i(-1, 0), vec2i(0), size - 1), 0).x;
  var R = textureLoad(vel, clamp(c + vec2i( 1, 0), vec2i(0), size - 1), 0).x;
  var T = textureLoad(vel, clamp(c + vec2i(0,  1), vec2i(0), size - 1), 0).y;
  var B = textureLoad(vel, clamp(c + vec2i(0, -1), vec2i(0), size - 1), 0).y;
  if (c.x == 0) { L = -Cv.x; }
  if (c.x == size.x - 1) { R = -Cv.x; }
  if (c.y == size.y - 1) { T = -Cv.y; }
  if (c.y == 0) { B = -Cv.y; }
  textureStore(dst, c, vec4f(0.5 * (R - L + T - B), 0.0, 0.0, 1.0));
}`

const clearWGSL = /* wgsl */ `
struct U { value: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(src);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(dst, vec2i(id.xy), textureLoad(src, vec2i(id.xy), 0) * u.value);
}`

const pressureWGSL = /* wgsl */ `
@group(0) @binding(0) var prs: texture_2d<f32>;
@group(0) @binding(1) var div: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(prs));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  let L = textureLoad(prs, clamp(c + vec2i(-1, 0), vec2i(0), size - 1), 0).x;
  let R = textureLoad(prs, clamp(c + vec2i( 1, 0), vec2i(0), size - 1), 0).x;
  let T = textureLoad(prs, clamp(c + vec2i(0,  1), vec2i(0), size - 1), 0).x;
  let B = textureLoad(prs, clamp(c + vec2i(0, -1), vec2i(0), size - 1), 0).x;
  let d = textureLoad(div, c, 0).x;
  textureStore(dst, c, vec4f((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0));
}`

const gradientWGSL = /* wgsl */ `
@group(0) @binding(0) var prs: texture_2d<f32>;
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(prs));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  let L = textureLoad(prs, clamp(c + vec2i(-1, 0), vec2i(0), size - 1), 0).x;
  let R = textureLoad(prs, clamp(c + vec2i( 1, 0), vec2i(0), size - 1), 0).x;
  let T = textureLoad(prs, clamp(c + vec2i(0,  1), vec2i(0), size - 1), 0).x;
  let B = textureLoad(prs, clamp(c + vec2i(0, -1), vec2i(0), size - 1), 0).x;
  let v = textureLoad(vel, c, 0).xy - vec2f(R - L, T - B);
  textureStore(dst, c, vec4f(v, 0.0, 1.0));
}`

const advectWGSL = /* wgsl */ `
struct U { texel: vec2f, drift: vec2f, dt: f32, dissipation: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var v = textureSampleLevel(vel, smp, uv, 0.0).xy;
  v.x += u.drift.x;
  v.y -= u.drift.y * smoothstep(0.0, 0.05, uv.y);
  let coord = uv - u.dt * v * u.texel;
  let result = textureSampleLevel(src, smp, coord, 0.0) / (1.0 + u.dissipation * u.dt);
  textureStore(dst, vec2i(id.xy), result);
}`

const renderWGSL = /* wgsl */ `
struct U { brightness: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var dye: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = array(vec2f(-1.0, -1.0), vec2f(-1.0, 3.0), vec2f(3.0, -1.0))[i];
  var out: VSOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  return out;
}
@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSampleLevel(dye, smp, in.uv, 0.0).rgb * u.brightness;
  let a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  return vec4f(c, a);
}`

// ---------------------------------------------------------------- host

export async function createFluidGPU(canvas: HTMLCanvasElement, options: FluidGPUOptions = {}): Promise<FluidGPU> {
  if (!isWebGPUSupported()) throw new Error('fluidkit/webgpu: WebGPU not available in this browser')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('fluidkit/webgpu: no GPU adapter')
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu')
  if (!context) throw new Error('fluidkit/webgpu: cannot get webgpu context')
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })

  const params: FluidParams = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof FluidParams)[])
    if (options[k] !== undefined) params[k] = options[k]!

  // ---- textures ----
  interface Field { a: GPUTexture; b: GPUTexture; w: number; h: number; swap(): void }
  function makeTex(w: number, h: number) {
    return device.createTexture({
      size: { width: w, height: h },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    })
  }
  function makeField(w: number, h: number): Field {
    const f = { a: makeTex(w, h), b: makeTex(w, h), w, h, swap() { const t = f.a; f.a = f.b; f.b = t } }
    return f
  }

  function resizeCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true }
    return false
  }
  resizeCanvas()

  let velocity!: Field, dye!: Field, pressure!: Field, divergence!: GPUTexture, curl!: GPUTexture
  let appliedSim = 0, appliedDye = 0
  function initFields() {
    velocity?.a.destroy(); velocity?.b.destroy(); dye?.a.destroy(); dye?.b.destroy()
    pressure?.a.destroy(); pressure?.b.destroy(); divergence?.destroy(); curl?.destroy()
    const simRes = computeResolution(params.simResolution, canvas.width, canvas.height)
    const dyeRes = computeResolution(params.dyeResolution, canvas.width, canvas.height)
    velocity = makeField(simRes.width, simRes.height)
    dye = makeField(dyeRes.width, dyeRes.height)
    pressure = makeField(simRes.width, simRes.height)
    divergence = makeTex(simRes.width, simRes.height)
    curl = makeTex(simRes.width, simRes.height)
    appliedSim = params.simResolution; appliedDye = params.dyeResolution
  }
  initFields()

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })

  // ---- pipelines ----
  function computePipeline(code: string) {
    return device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } })
  }
  const pSplat = computePipeline(splatWGSL)
  const pCurl = computePipeline(curlWGSL)
  const pVort = computePipeline(vorticityWGSL)
  const pDiv = computePipeline(divergenceWGSL)
  const pClear = computePipeline(clearWGSL)
  const pPress = computePipeline(pressureWGSL)
  const pGrad = computePipeline(gradientWGSL)
  const pAdvect = computePipeline(advectWGSL)
  const renderModule = device.createShaderModule({ code: renderWGSL })
  const pRender = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'vs' },
    fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })

  // small pool of uniform buffers (created per use is fine at this scale)
  function ubuf(data: Float32Array) {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
    frameBuffers.push(b)
    return b
  }
  let frameBuffers: GPUBuffer[] = []

  const dispatch = (pass: GPUComputePassEncoder, w: number, h: number) =>
    pass.dispatchWorkgroups(Math.ceil(w / WG), Math.ceil(h / WG))

  function bind(pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]) {
    return device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
  }
  const view = (t: GPUTexture) => t.createView()

  // ---- splats ----
  interface Q { x: number; y: number; dx: number; dy: number; color: [number, number, number]; radius: number }
  const queue: Q[] = []
  function correctRadius(r: number) {
    const aspect = canvas.width / canvas.height
    return (aspect > 1 ? r * aspect : r) / 100
  }

  function encodeSplat(pass: GPUComputePassEncoder, s: Q) {
    const aspect = canvas.width / canvas.height
    // velocity
    const uv = new Float32Array([s.x, s.y, 0, 0, s.dx, s.dy, 0, 0, correctRadius(s.radius), aspect, 0, 0])
    pass.setPipeline(pSplat)
    pass.setBindGroup(0, bind(pSplat, [
      { binding: 0, resource: { buffer: ubuf(uv) } },
      { binding: 1, resource: view(velocity.a) },
      { binding: 2, resource: view(velocity.b) },
    ]))
    dispatch(pass, velocity.w, velocity.h)
    velocity.swap()
    // dye
    const ud = new Float32Array([s.x, s.y, 0, 0, s.color[0], s.color[1], s.color[2], 0, correctRadius(s.radius), aspect, 0, 0])
    pass.setBindGroup(0, bind(pSplat, [
      { binding: 0, resource: { buffer: ubuf(ud) } },
      { binding: 1, resource: view(dye.a) },
      { binding: 2, resource: view(dye.b) },
    ]))
    dispatch(pass, dye.w, dye.h)
    dye.swap()
  }

  // ---- frame ----
  function step(pass: GPUComputePassEncoder, dt: number) {
    pass.setPipeline(pCurl)
    pass.setBindGroup(0, bind(pCurl, [
      { binding: 0, resource: view(velocity.a) },
      { binding: 1, resource: view(curl) },
    ]))
    dispatch(pass, velocity.w, velocity.h)

    pass.setPipeline(pVort)
    pass.setBindGroup(0, bind(pVort, [
      { binding: 0, resource: { buffer: ubuf(new Float32Array([params.curl, dt])) } },
      { binding: 1, resource: view(velocity.a) },
      { binding: 2, resource: view(curl) },
      { binding: 3, resource: view(velocity.b) },
    ]))
    dispatch(pass, velocity.w, velocity.h)
    velocity.swap()

    pass.setPipeline(pDiv)
    pass.setBindGroup(0, bind(pDiv, [
      { binding: 0, resource: view(velocity.a) },
      { binding: 1, resource: view(divergence) },
    ]))
    dispatch(pass, velocity.w, velocity.h)

    pass.setPipeline(pClear)
    pass.setBindGroup(0, bind(pClear, [
      { binding: 0, resource: { buffer: ubuf(new Float32Array([params.pressure])) } },
      { binding: 1, resource: view(pressure.a) },
      { binding: 2, resource: view(pressure.b) },
    ]))
    dispatch(pass, pressure.w, pressure.h)
    pressure.swap()

    pass.setPipeline(pPress)
    for (let i = 0; i < params.pressureIterations; i++) {
      pass.setBindGroup(0, bind(pPress, [
        { binding: 0, resource: view(pressure.a) },
        { binding: 1, resource: view(divergence) },
        { binding: 2, resource: view(pressure.b) },
      ]))
      dispatch(pass, pressure.w, pressure.h)
      pressure.swap()
    }

    pass.setPipeline(pGrad)
    pass.setBindGroup(0, bind(pGrad, [
      { binding: 0, resource: view(pressure.a) },
      { binding: 1, resource: view(velocity.a) },
      { binding: 2, resource: view(velocity.b) },
    ]))
    dispatch(pass, velocity.w, velocity.h)
    velocity.swap()

    pass.setPipeline(pAdvect)
    const vTexel = new Float32Array([1 / velocity.w, 1 / velocity.h, 0, 0, dt, params.velocityDissipation, 0, 0])
    pass.setBindGroup(0, bind(pAdvect, [
      { binding: 0, resource: { buffer: ubuf(vTexel) } },
      { binding: 1, resource: view(velocity.a) },
      { binding: 2, resource: view(velocity.a) },
      { binding: 3, resource: sampler },
      { binding: 4, resource: view(velocity.b) },
    ]))
    dispatch(pass, velocity.w, velocity.h)
    velocity.swap()

    const dTexel = new Float32Array([1 / velocity.w, 1 / velocity.h, params.wind, params.gravity, dt, params.densityDissipation, 0, 0])
    pass.setBindGroup(0, bind(pAdvect, [
      { binding: 0, resource: { buffer: ubuf(dTexel) } },
      { binding: 1, resource: view(velocity.a) },
      { binding: 2, resource: view(dye.a) },
      { binding: 3, resource: sampler },
      { binding: 4, resource: view(dye.b) },
    ]))
    dispatch(pass, dye.w, dye.h)
    dye.swap()
  }

  // ---- emitters (mirrors the WebGL2 host) ----
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
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = (e.clientX - rect.left) / rect.width
    const y = 1 - (e.clientY - rect.top) / rect.height
    const p = pointers.get(e.pointerId)
    if (!p) { pointers.set(e.pointerId, { x, y }); return }
    const dx = (x - p.x) * params.splatForce
    const dy = (y - p.y) * params.splatForce
    p.x = x; p.y = y
    if (dx || dy) queue.push({ x, y, dx, dy, color: pointerColor(e.pointerId), radius: params.splatRadius })
  }
  const onPointerEnd = (e: PointerEvent) => pointers.delete(e.pointerId)
  const agents = [0, 1, 2].map(i => ({ seed: 17.3 * (i + 1), px: NaN, py: NaN }))
  function ambientStep(t: number) {
    for (const a of agents) {
      const x = 0.5 + 0.38 * Math.sin(t * 0.21 + a.seed) * Math.sin(t * 0.117 + a.seed * 2.7)
      const y = 0.5 + 0.38 * Math.sin(t * 0.163 + a.seed * 1.9) * Math.cos(t * 0.141 + a.seed)
      if (!Number.isNaN(a.px)) {
        const dx = (x - a.px) * params.splatForce * ambientStrength * 8
        const dy = (y - a.py) * params.splatForce * ambientStrength * 8
        const [r, g, b] = hsv(t * 0.02 + a.seed, 0.9, 1)
        queue.push({ x, y, dx, dy, color: [r * 0.08, g * 0.08, b * 0.08], radius: params.splatRadius * 0.6 })
      }
      a.px = x; a.py = y
    }
  }

  // ---- loop ----
  let raf = 0
  let lastTime = -1
  let paused = false
  let destroyed = false
  let intersecting = true
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  const respectReduced = options.respectReducedMotion !== false
  const brightness = options.brightness ?? 1

  function shouldRun() {
    return !destroyed && !paused && intersecting && !document.hidden
      && !(respectReduced && reducedMotion?.matches)
  }
  function ensureLoop() {
    if (shouldRun() && !raf) { lastTime = -1; raf = requestAnimationFrame(frame) }
    else if (!shouldRun() && raf) { cancelAnimationFrame(raf); raf = 0 }
  }

  function frame(now: number) {
    raf = shouldRun() ? requestAnimationFrame(frame) : 0
    const dt = lastTime < 0 ? 0 : Math.min(Math.max((now - lastTime) / 1000, 0), 1 / 30)
    lastTime = now
    if (resizeCanvas() || params.simResolution !== appliedSim || params.dyeResolution !== appliedDye) initFields()
    if (ambientStrength > 0) ambientStep(now / 1000)

    const encoder = device.createCommandEncoder()
    const cpass = encoder.beginComputePass()
    for (const s of queue) encodeSplat(cpass, s)
    queue.length = 0
    const sdt = dt * params.speed
    if (sdt > 0) step(cpass, sdt)
    cpass.end()

    const rpass = encoder.beginRenderPass({
      colorAttachments: [{ view: context!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    rpass.setPipeline(pRender)
    rpass.setBindGroup(0, device.createBindGroup({
      layout: pRender.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf(new Float32Array([brightness])) } },
        { binding: 1, resource: view(dye.a) },
        { binding: 2, resource: sampler },
      ],
    }))
    rpass.draw(3)
    rpass.end()
    device.queue.submit([encoder.finish()])
    for (const b of frameBuffers) b.destroy()
    frameBuffers = []
  }

  const onVisibility = () => ensureLoop()
  document.addEventListener('visibilitychange', onVisibility)
  reducedMotion?.addEventListener?.('change', ensureLoop)
  if (pointerEnabled) {
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerEnd)
    canvas.addEventListener('pointerleave', onPointerEnd)
  }
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(es => { intersecting = es[es.length - 1].isIntersecting; ensureLoop() })
    : null
  observer?.observe(canvas)
  ensureLoop()

  return {
    params,
    canvas,
    backend: 'webgpu',
    splat(x, y, dx, dy, opts = {}) {
      queue.push({ x, y, dx, dy, color: opts.color ? parseColor(opts.color) : pointerColor(0), radius: opts.radius ?? params.splatRadius })
    },
    pause() { paused = true; ensureLoop() },
    resume() { paused = false; ensureLoop() },
    destroy() {
      destroyed = true
      ensureLoop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerEnd)
      canvas.removeEventListener('pointerleave', onPointerEnd)
      velocity.a.destroy(); velocity.b.destroy(); dye.a.destroy(); dye.b.destroy()
      pressure.a.destroy(); pressure.b.destroy(); divergence.destroy(); curl.destroy()
      device.destroy()
    },
  }
}
