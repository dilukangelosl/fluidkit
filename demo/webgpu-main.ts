import { createFluidGPU, isWebGPUSupported } from '../src/webgpu.js'

const badge = document.getElementById('badge')!
const canvas = document.getElementById('c') as HTMLCanvasElement

if (!isWebGPUSupported()) {
  badge.textContent = 'webgpu: not supported here — see the WebGL2 demo'
} else {
  try {
    const fluid = await createFluidGPU(canvas, {
      emitters: { pointer: true, ambient: { strength: 0.3 } },
      brightness: 1.1,
    })
    ;(window as unknown as { fluid: typeof fluid }).fluid = fluid
    badge.textContent = 'webgpu: running ✓ (experimental backend)'
    for (let i = 0; i < 6; i++) {
      fluid.splat(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6,
        (Math.random() - 0.5) * 800, (Math.random() - 0.5) * 800)
    }
  } catch (e) {
    badge.textContent = 'webgpu failed: ' + (e as Error).message
  }
}
