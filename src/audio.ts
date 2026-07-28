// Sound-reactive emitter. Import from '@dilukangelo/fluidkit/audio'.
// Splats scale with bass/mid/treble energy from any audio element, stream, or the mic.

import type { Fluid } from './index.js'
import { hsv } from './utils.js'

export interface AudioEmitterOptions {
  /** An <audio>/<video> element or MediaStream. Omit for microphone (prompts the user). */
  source?: HTMLMediaElement | MediaStream
  /** Splat force multiplier. Default 1. */
  strength?: number
  /** Energy gate 0..1 — below this, no splats. Default 0.1. */
  threshold?: number
}

export interface AudioEmitter {
  analyser: AnalyserNode
  destroy(): void
}

/** Drive fluid splats from audio energy: bass erupts from the bottom, treble sparkles on top. */
export async function createAudioEmitter(fluid: Fluid, opts: AudioEmitterOptions = {}): Promise<AudioEmitter> {
  const ctx = new AudioContext()
  let node: AudioNode
  if (!opts.source) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    node = ctx.createMediaStreamSource(stream)
  } else if (opts.source instanceof MediaStream) {
    node = ctx.createMediaStreamSource(opts.source)
  } else {
    const src = ctx.createMediaElementSource(opts.source)
    src.connect(ctx.destination) // keep the element audible
    node = src
  }
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.7
  node.connect(analyser)

  const data = new Uint8Array(analyser.frequencyBinCount)
  const strength = opts.strength ?? 1
  const threshold = opts.threshold ?? 0.1
  const band = (a: number, b: number) => {
    let sum = 0
    for (let i = a; i < b; i++) sum += data[i]
    return sum / (b - a) / 255
  }

  let raf = requestAnimationFrame(function loop(now) {
    raf = requestAnimationFrame(loop)
    analyser.getByteFrequencyData(data)
    const bass = band(0, 8)
    const treble = band(40, 100)
    const t = now / 1000
    if (bass > threshold) {
      const x = 0.5 + 0.25 * Math.sin(t * 3.1)
      fluid.splat(x, 0.08, 0, bass * 900 * strength,
        { color: hsv(t * 0.1, 1, 1).map(c => c * bass * 0.4) as [number, number, number], radius: 0.2 + bass * 0.3 })
    }
    if (treble > threshold) {
      fluid.splat(Math.random(), 0.9, (Math.random() - 0.5) * 300 * treble, -100 * treble,
        { color: hsv(0.55 + treble * 0.2, 0.6, 1).map(c => c * treble * 0.25) as [number, number, number], radius: 0.08 })
    }
  })

  return {
    analyser,
    destroy() {
      cancelAnimationFrame(raf)
      ctx.close()
    },
  }
}
