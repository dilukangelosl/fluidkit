// Render modes consume the sim's field textures (uDye / uVelocity / uPressure) — that
// texture contract is what decouples rendering from simulation.

import { parseColor, type Color } from './utils.js'

export interface RenderMode {
  name: string
  /** GLSL ES 3.00 fragment shader. May sample uDye, uVelocity, uPressure; gets uTime + texelSize. */
  frag: string
  /** Set mode-specific uniforms; called every frame after the core binds textures. */
  apply?(gl: WebGL2RenderingContext, uniforms: Record<string, WebGLUniformLocation>): void
  /** Release mode-owned GPU resources (called on mode swap and fluid.destroy()). */
  dispose?(gl: WebGL2RenderingContext): void
}

// ---------------------------------------------------------------- dye

const dyeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform float uBrightness;
uniform vec4 uBackground; // a=1 → composite over this color, a=0 → transparent output

void main () {
    vec3 c = texture(uDye, vUv).rgb * uBrightness;
    if (uBackground.a > 0.5) {
        fragColor = vec4(uBackground.rgb + c, 1.0); // additive over background
    } else {
        float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
        fragColor = vec4(c, a); // dye is additive-on-black — premultiplied-friendly
    }
}`

export interface DyeOptions {
  /** Multiplier on dye color. Default 1. */
  brightness?: number
  /** Solid backdrop composited in-shader; 'transparent' (default) outputs alpha. */
  background?: Color | 'transparent'
}

/** Classic smoky multicolor dye. */
export function dye(opts: DyeOptions = {}): RenderMode {
  const brightness = opts.brightness ?? 1
  const bg =
    !opts.background || opts.background === 'transparent'
      ? [0, 0, 0, 0]
      : [...parseColor(opts.background), 1]
  return {
    name: 'dye',
    frag: dyeFrag,
    apply(gl, u) {
      gl.uniform1f(u.uBrightness, brightness)
      gl.uniform4f(u.uBackground, bg[0], bg[1], bg[2], bg[3])
    },
  }
}

// ---------------------------------------------------------------- threshold

const thresholdFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform int uCount;
uniform float uCutoff[8];
uniform vec4 uColor[8];
uniform vec4 uBackground;
uniform vec4 uOutline;       // rgb + opacity
uniform float uOutlineWidth; // in AA-widths; 0 = off
uniform float uSoftness;     // edge AA multiplier

void main () {
    float lum = dot(texture(uDye, vUv).rgb, vec3(0.299, 0.587, 0.114));
    float aa = (fwidth(lum) + 1e-4) * uSoftness;
    vec4 col = uBackground;
    float edge = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= uCount) break;
        col = mix(col, uColor[i], smoothstep(uCutoff[i] - aa, uCutoff[i] + aa, lum));
        if (uOutlineWidth > 0.0) {
            // stroke centered on each level boundary — comic/sticker style
            float d = abs(lum - uCutoff[i]);
            edge = max(edge, 1.0 - smoothstep(0.0, aa * uOutlineWidth, d));
        }
    }
    col = mix(col, vec4(uOutline.rgb, 1.0), edge * uOutline.a);
    fragColor = vec4(col.rgb * col.a, col.a); // premultiply for canvas compositing
}`

export interface ThresholdLevel {
  /** Dye luminance cutoff (0..1+, dye is additive so >1 near splats). */
  cutoff: number
  color: Color
  /** Level opacity (0..1). Default 1. */
  alpha?: number
}

export interface ThresholdOptions {
  /** Up to 8 levels; drawn lowest cutoff first. */
  levels: ThresholdLevel[]
  background?: Color | 'transparent'
  /** Stroke drawn on every level boundary. width is in edge-AA units (try 2–6). */
  outline?: { color: Color; width?: number; opacity?: number }
  /** Edge anti-aliasing multiplier. 1 = crisp (default), 3–8 = soft/blurry edges. */
  softness?: number
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
    colors.set([r, g, b, l.alpha ?? 1], i * 4)
  })
  const bg: number[] =
    !opts.background || opts.background === 'transparent'
      ? [0, 0, 0, 0]
      : [...parseColor(opts.background), 1]
  const oc = opts.outline ? parseColor(opts.outline.color) : [0, 0, 0]
  const outlineWidth = opts.outline ? (opts.outline.width ?? 3) : 0
  const outlineOpacity = opts.outline?.opacity ?? 1
  const softness = opts.softness ?? 1
  return {
    name: 'threshold',
    frag: thresholdFrag,
    apply(gl, u) {
      gl.uniform1i(u.uCount, levels.length)
      gl.uniform1fv(u.uCutoff, cutoffs)
      gl.uniform4fv(u.uColor, colors)
      gl.uniform4f(u.uBackground, bg[0], bg[1], bg[2], bg[3])
      gl.uniform4f(u.uOutline, oc[0], oc[1], oc[2], outlineOpacity)
      gl.uniform1f(u.uOutlineWidth, outlineWidth)
      gl.uniform1f(u.uSoftness, softness)
    },
  }
}

// ---------------------------------------------------------------- displacement

const displacementFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uStrength;
uniform float uChromatic;

void main () {
    vec2 off = texture(uVelocity, vUv).xy * uStrength * 0.0001;
    float r = texture(uSource, vUv + off * (1.0 + 0.15 * uChromatic)).r;
    float g = texture(uSource, vUv + off).g;
    float b = texture(uSource, vUv + off * (1.0 - 0.15 * uChromatic)).b;
    fragColor = vec4(r, g, b, 1.0);
}`

export interface DisplacementOptions {
  /** Image URL (CORS-enabled) or any TexImageSource (img, canvas, bitmap). */
  source: string | TexImageSource
  /** Distortion amount. Default 25. */
  strength?: number
  /** RGB channel separation on the distortion (0..1). Default 0. */
  chromatic?: number
}

/** Refraction-style mode: the velocity field distorts a texture (image/canvas). */
export function displacement(opts: DisplacementOptions): RenderMode {
  // ponytail: one texture per mode instance, still images only — re-upload each frame if you need video
  const strength = opts.strength ?? 25
  const chromatic = opts.chromatic ?? 0
  let tex: WebGLTexture | null = null
  let source: TexImageSource | null = typeof opts.source === 'string' ? null : opts.source
  let uploaded = false
  if (typeof opts.source === 'string') {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { source = img }
    img.src = opts.source
  }
  return {
    name: 'displacement',
    frag: displacementFrag,
    apply(gl, u) {
      if (!tex) {
        tex = gl.createTexture()
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([40, 40, 48, 255])) // placeholder until the image arrives
      }
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      if (source && !uploaded) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) // match uv y-up
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        uploaded = true
      }
      gl.uniform1i(u.uSource, 3)
      gl.uniform1f(u.uStrength, strength)
      gl.uniform1f(u.uChromatic, chromatic)
    },
    dispose(gl) {
      if (tex) gl.deleteTexture(tex)
      tex = null
      uploaded = false
    },
  }
}

// ---------------------------------------------------------------- custom

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
