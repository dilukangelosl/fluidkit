# fluidkit — instructions for AI coding agents

You are working with **fluidkit**, a zero-dependency WebGL2 fluid simulation library.
Use it to add interactive fluid effects to landing pages, hero sections, and creative sites.
This file tells you everything you need — you should not need to read the library source.

## Setup

```sh
npm install @dilukangelo/fluidkit
```

```ts
import { createFluid, dye, threshold, custom } from '@dilukangelo/fluidkit'

const fluid = createFluid(canvas, options)
```

The canvas must have CSS size (e.g. `width: 100vw; height: 100vh; display: block`).
Add `touch-action: none` if pointer interaction is enabled. The library handles
device-pixel-ratio, resize, tab-visibility pause, off-viewport pause, context-loss
recovery, and `prefers-reduced-motion` automatically.

**SSR frameworks (Next.js, Nuxt, SvelteKit):** importing fluidkit is safe on the server,
but only call `createFluid` in browser lifecycle hooks (`useEffect`, `onMounted`).
Always call `fluid.destroy()` on unmount.

```tsx
// React: use the built-in wrapper
import { FluidCanvas } from '@dilukangelo/fluidkit/react'
<FluidCanvas render={threshold({ ... })} emitters={{ pointer: true }} className="hero-bg"
  onReady={fluid => { /* splats, fluid.params, masks */ }} />
// Options are read at mount; tune live via onReady. Or manage createFluid/destroy yourself.
```

Other adapters: `@dilukangelo/fluidkit/vue` (FluidCanvas component, `:options` + `@ready`),
`@dilukangelo/fluidkit/svelte` (`use:fluid={{ ...options, onReady }}` action),
CDN script tag `https://unpkg.com/@dilukangelo/fluidkit/dist/fluidkit.iife.js` → `window.fluidkit`.

Sound reactivity: `const a = await createAudioEmitter(fluid, { source: mediaElement })` from
`@dilukangelo/fluidkit/audio` — omit source for the microphone (prompts). `a.destroy()` to stop.

Bubbles (soda carbonation): `threshold({ ..., bubbles: { density: 0.55, rise: 1, size: 0.035 } })`.
Animated masks: pass a video (auto) or `{ live: true }` with a canvas you redraw —
`fluid.setEmitterMask(videoEl)` re-uploads every frame.

## API surface

```ts
createFluid(canvas, {
  render?: RenderMode   // dye() | threshold() | displacement() | custom(); default dye()
  emitters?: {
    pointer?: boolean | {
      color?: Color | Color[]  // fixed color or palette cycled per pointer; omit = rainbow
      intensity?: number       // dye per splat, default 0.15 (raise for threshold looks)
      radius?: number          // multiplier on splatRadius, default 1
      dragOnly?: boolean       // true = only while pressed; default false (hover emits)
    }
    ambient?: boolean | {      // autonomous wanderers, motion without interaction
      strength?: number        // ~0.2–0.5
      count?: number           // default 3
      colors?: Color[]         // palette; omit = rainbow drift
      radius?: number          // multiplier on splatRadius, default 0.6
    }
  }
  onFrame?: (t, dt) => void    // per-frame hook — drive emitters here, no own rAF needed
  respectReducedMotion?: boolean // default true — leave it on
  // ...plus any sim param below as an initial value
})

fluid.splat(x, y, dx, dy, { color, radius })  // x,y in [0,1], y UP (0 = bottom). dx,dy ≈ ±800
fluid.params.curl = 45                        // every sim param is live-tunable
fluid.setRenderMode(mode)                     // swap looks at runtime
fluid.setAmbient({ strength, colors } | null)  // reconfigure/disable ambient wanderers live
fluid.setEmitterMask(src, { color, strength })// dye pours from a text/image mask; null = off
fluid.setObstacle(src)                        // fluid flows AROUND the mask; null = off
fluid.reset()                                 // clear the fields
fluid.screenshot()                            // PNG data URL of the current look
fluid.getTexture('dye' | 'velocity' | 'pressure') // WebGLTexture for three.js/pixi
fluid.pause(); fluid.resume(); fluid.destroy()

textMask('your brand', { size: 0.35, weight: 900, font: 'system-ui', aspect: 2 })
// → white-on-transparent canvas for setEmitterMask/setObstacle
```

Sim params (defaults): `simResolution` 128, `dyeResolution` 1024, `curl` 30,
`pressureIterations` 20, `pressure` 0.8, `velocityDissipation` 0.2,
`densityDissipation` 1.0, `gravity` 0, `wind` 0 (horizontal dye drift, ± texels/s),
`speed` 1 (time scale — 0.5 = slow motion), `splatRadius` 0.25, `splatForce` 6000.

WebGPU (experimental): `const f = await createFluidGPU(canvas, opts)` from
`@dilukangelo/fluidkit/webgpu` — dye look + splats + live params only; feature-detect with
`isWebGPUSupported()` and fall back to `createFluid`. Prefer the WebGL2 core for anything styled.

## Choosing a look — the two aesthetics

**Smoke/plasma (soft, glowy):** `dye()` render, `dyeResolution` 1024, `curl` 30–50.
Good for dark hero backgrounds and cursor trails.

**Liquid/sticker (flat, posterized — the "soda" look):** `threshold()` render. The recipe
that makes it read as *liquid* instead of smoke — use all three together:
- `dyeResolution: 256` (or 128) — low res + linear filtering = smooth metaball outlines
- high cutoffs (0.3–1.6) — culls thin wisps so only dense fluid renders
- `curl: 0–5` — low vorticity flows in sheets instead of billowing

```ts
threshold({
  levels: [                      // up to 8, lowest cutoff first = outermost color
    { cutoff: 0.35, color: '#f4a8c6' },
    { cutoff: 0.7,  color: '#ee5a95', alpha: 0.9 },  // per-level opacity
    { cutoff: 1.6,  color: '#fff3f8' },  // dense core reads as foam/highlight
  ],
  background: 'transparent',     // or any hex — transparent composites over page content
  outline: { color: '#16091f', width: 3, opacity: 1 }, // comic/sticker stroke on level edges
  softness: 1,                   // 1 = crisp edges (default); 3–8 = soft blobby edges
})
```
Outline looks best with the metaball recipe (low dyeResolution) — on high-res turbulent
dye it traces every wisp and reads as scribble.

**Refraction (`displacement()`):** the flow distorts an image/canvas — glassy hover effects:
```ts
displacement({
  source: '/poster.jpg',   // URL (CORS) or any TexImageSource (canvas, img, bitmap)
  strength: 12,            // distortion amount; >30 shreds the image
  chromatic: 0.6,          // 0..1 RGB fringe separation
})
// pair with params { curl: 4, velocityDissipation: 0.3 } for glassy ripples
```

**Dye options:** `dye({ brightness: 1.4, glow: 0.9, glowRadius: 32, background: '#0b0b12' })` —
brightness multiplies the smoke, glow adds a neon halo, background composites in-shader.

**Gradient-map (`ramp()`):** `ramp(['#0b0212', '#4a0f5e', '#c0245e', '#ffe8d6'])` — dye
density mapped through a color ramp (first color = background). The easiest way to hit
exact brand colors. `ramp({ colors, scale: 1.4 })` boosts contrast.

**Wet-jelly lighting:** `threshold({ ..., lighting: { strength: 5, specular: 0.9 } })` —
fakes a 3D surface from the dye gradient. Turns flat liquid into glossy slime.

**Logo effects (the signature moves):**
```ts
// The wordmark bleeds/melts liquid:
fluid.setEmitterMask(textMask('brandname', { size: 0.32, weight: 900 }),
  { color: [0.5, 0.18, 0.3], strength: 8 })
fluid.params.gravity = 120
// Pour dye over invisible text — letters appear as negative space:
fluid.setObstacle(textMask('FLOW', { size: 0.42 }))
// + emit splats from the top with gravity ~240
```
Mask emitter tuning: strength must outpace both densityDissipation and gravity
(strength 5–10 with gravity 100–200). The mask stretches to the canvas — match
`aspect` to your canvas shape for undistorted letterforms.

## Recipes for landing pages

**Hero background (interactive, subtle):**
```ts
createFluid(canvas, {
  emitters: { pointer: true, ambient: { strength: 0.25 } },
  render: threshold({ levels: [...brand colors...], background: 'transparent' }),
})
```
Position the canvas absolutely behind content, `pointer-events: none` on overlaying text.

**Pouring liquid (soda/drink brands):** emit continuously from a point with `gravity`:
```ts
const fluid = createFluid(canvas, { dyeResolution: 256, curl: 3, gravity: 220,
  densityDissipation: 0.3, velocityDissipation: 0.1, render: threshold({ ... }) })
function pour(t: number) {
  fluid.splat(0.5 + 0.05 * Math.sin(t * 0.9), 0.97, 0, -380, { color: [0.5, 0.2, 0.3], radius: 0.25 })
  requestAnimationFrame(now => pour(now / 1000))
}
```
`gravity` 100–400 makes dye fall and pool at the floor. Waterfall = same idea, emit at
several x positions across the top. Fountain = emit from the bottom with positive dy.

**Scroll-driven effects:** drive splats from your scroll handler (GSAP/Lenis) — e.g.
`fluid.splat(0.5, 1 - scrollProgress, 0, -300, {...})`. The library deliberately has no
built-in scroll logic.

**Custom shader look:** `custom({ frag })` — GLSL ES 3.00 fragment shader with `in vec2 vUv`,
`out vec4 fragColor`; sample `uDye`, `uVelocity`, `uPressure`; uniforms `uTime`, `texelSize`
are provided. Map velocity magnitude or dye luminance to your palette.

## Pitfalls

- Splat color is dye *amount*, not display color: values ~0.1–0.2 per channel for smoke
  (accumulates additively), 0.3–0.6 for threshold looks that need dense fluid fast.
- y axis is UP in `splat()` coordinates: top of screen is y=1, negative dy falls.
- Don't create the fluid on a canvas with zero size (display:none parent) — mount first.
- Multiple instances per page are fine; each owns its canvas.
- Requires WebGL2 + `EXT_color_buffer_float`; `createFluid` throws a clear error otherwise —
  wrap in try/catch and fall back to a static image/gradient for very old devices.
- Performance on mobile: keep defaults or lower (`simResolution` 96, `dyeResolution` 512).
