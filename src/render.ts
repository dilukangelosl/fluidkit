// Render modes consume the sim's field textures (uDye / uVelocity / uPressure) — that
// texture contract is what decouples rendering from simulation.

import { parseColor, type Color } from './utils.js'

export interface RenderMode {
  name: string
  /** GLSL ES 3.00 fragment shader. May sample uDye, uVelocity, uPressure; gets uTime + texelSize. */
  frag: string
  /** Set mode-specific uniforms; called every frame after the core binds textures. */
  apply?(gl: WebGL2RenderingContext, uniforms: Record<string, WebGLUniformLocation>): void
}

const dyeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;

void main () {
    vec3 c = texture(uDye, vUv).rgb;
    float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
    // Dye is additive-on-black, which is already premultiplied-friendly.
    fragColor = vec4(c, a);
}`

/** Classic smoky multicolor dye. */
export function dye(): RenderMode {
  return { name: 'dye', frag: dyeFrag }
}

const thresholdFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform int uCount;
uniform float uCutoff[8];
uniform vec4 uColor[8];
uniform vec4 uBackground;

void main () {
    float lum = dot(texture(uDye, vUv).rgb, vec3(0.299, 0.587, 0.114));
    float aa = fwidth(lum) + 1e-4; // screen-space edge anti-aliasing
    vec4 col = uBackground;
    for (int i = 0; i < 8; i++) {
        if (i >= uCount) break;
        col = mix(col, uColor[i], smoothstep(uCutoff[i] - aa, uCutoff[i] + aa, lum));
    }
    fragColor = vec4(col.rgb * col.a, col.a); // premultiply for canvas compositing
}`

export interface ThresholdLevel {
  /** Dye luminance cutoff (0..1+, dye is additive so >1 near splats). */
  cutoff: number
  color: Color
}

export interface ThresholdOptions {
  /** Up to 8 levels; drawn lowest cutoff first. */
  levels: ThresholdLevel[]
  background?: Color | 'transparent'
}

/** Posterized flat "sticker liquid" look (the Slosh effect). */
export function threshold(opts: ThresholdOptions): RenderMode {
  // ponytail: bubbles/speck compositing from the PRD not implemented yet — add as an overlay pass when a design asks for it
  const levels = [...opts.levels].sort((a, b) => a.cutoff - b.cutoff).slice(0, 8)
  const cutoffs = new Float32Array(8)
  const colors = new Float32Array(32)
  levels.forEach((l, i) => {
    cutoffs[i] = l.cutoff
    const [r, g, b] = parseColor(l.color)
    colors.set([r, g, b, 1], i * 4)
  })
  const bg: number[] =
    !opts.background || opts.background === 'transparent'
      ? [0, 0, 0, 0]
      : [...parseColor(opts.background), 1]
  return {
    name: 'threshold',
    frag: thresholdFrag,
    apply(gl, u) {
      gl.uniform1i(u.uCount, levels.length)
      gl.uniform1fv(u.uCutoff, cutoffs)
      gl.uniform4fv(u.uColor, colors)
      gl.uniform4f(u.uBackground, bg[0], bg[1], bg[2], bg[3])
    },
  }
}

export interface CustomOptions {
  frag: string
  /** Static float uniforms set each frame (number → uniform1f, number[] → uniformNfv). */
  uniforms?: Record<string, number | number[]>
}

/** Bring your own fragment shader. Receives uDye, uVelocity, uPressure, uTime, texelSize. */
export function custom(opts: CustomOptions): RenderMode {
  return {
    name: 'custom',
    frag: opts.frag,
    apply(gl, u) {
      for (const [name, v] of Object.entries(opts.uniforms ?? {})) {
        const loc = u[name]
        if (!loc) continue
        if (typeof v === 'number') gl.uniform1f(loc, v)
        else if (v.length === 2) gl.uniform2fv(loc, v)
        else if (v.length === 3) gl.uniform3fv(loc, v)
        else if (v.length === 4) gl.uniform4fv(loc, v)
        else gl.uniform1fv(loc, v)
      }
    },
  }
}
