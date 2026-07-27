// Pure host-side helpers. No DOM/GL access — keep this file dependency-free so it
// can be unit-tested in node and imported during SSR.

export interface FluidParams {
  /** Velocity grid resolution (shorter canvas edge, texels). */
  simResolution: number
  /** Dye grid resolution (shorter canvas edge, texels). */
  dyeResolution: number
  /** Vorticity confinement strength. */
  curl: number
  /** Jacobi pressure solve iterations. */
  pressureIterations: number
  /** Pressure retained between frames (0..1). */
  pressure: number
  /** Velocity fade rate. */
  velocityDissipation: number
  /** Dye fade rate. */
  densityDissipation: number
  /** Downward drift of dye (sim texels/s) + mass-weighted pull on velocity. 0 = off; try 100–400 for pours. */
  gravity: number
  /** Default splat radius (fraction of canvas). */
  splatRadius: number
  /** Pointer delta → velocity multiplier. */
  splatForce: number
}

export const DEFAULTS: FluidParams = {
  simResolution: 128,
  dyeResolution: 1024,
  curl: 30,
  pressureIterations: 20,
  pressure: 0.8,
  velocityDissipation: 0.2,
  densityDissipation: 1.0,
  gravity: 0,
  splatRadius: 0.25,
  splatForce: 6000,
}

export type Color = string | [number, number, number]

/** '#rgb' | '#rrggbb' | [r,g,b] (0..1) → [r,g,b] (0..1) */
export function parseColor(c: Color): [number, number, number] {
  if (Array.isArray(c)) return c
  let hex = c.replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('')
  const n = parseInt(hex, 16)
  if (hex.length !== 6 || Number.isNaN(n)) throw new Error(`fluidkit: cannot parse color "${c}"`)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function hsv(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 1) + 1) % 1
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  const table: [number, number, number][] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ]
  return table[i % 6]
}

/** Grid size for a base resolution, matching the canvas aspect ratio. */
export function computeResolution(base: number, w: number, h: number): { width: number; height: number } {
  w = Math.max(1, w)
  h = Math.max(1, h)
  let aspect = w / h
  if (aspect < 1) aspect = 1 / aspect
  const min = Math.round(base)
  const max = Math.round(base * aspect)
  return w > h ? { width: max, height: min } : { width: min, height: max }
}
