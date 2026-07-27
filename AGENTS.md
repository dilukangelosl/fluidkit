# fluidkit — instructions for AI coding agents

You are working with **fluidkit**, a zero-dependency WebGL2 fluid simulation library.
Use it to add interactive fluid effects to landing pages, hero sections, and creative sites.
This file tells you everything you need — you should not need to read the library source.

## Setup

```ts
import { createFluid, dye, threshold, custom } from 'fluidkit'

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
// React pattern (no wrapper package yet)
useEffect(() => {
  const fluid = createFluid(canvasRef.current, { render: threshold({ ... }) })
  return () => fluid.destroy()
}, [])
```

## API surface

```ts
createFluid(canvas, {
  render?: RenderMode            // dye() | threshold({...}) | custom({...}); default dye()
  emitters?: {
    pointer?: boolean            // mouse/touch splats, default true
    ambient?: { strength: number } // autonomous motion, ~0.2–0.5; default off
  }
  respectReducedMotion?: boolean // default true — leave it on
  // ...plus any sim param below as an initial value
})

fluid.splat(x, y, dx, dy, { color, radius })  // x,y in [0,1], y UP (0 = bottom). dx,dy ≈ ±800
fluid.params.curl = 45                        // every sim param is live-tunable
fluid.setRenderMode(mode)                     // swap looks at runtime
fluid.getTexture('dye' | 'velocity' | 'pressure') // WebGLTexture for three.js/pixi
fluid.pause(); fluid.resume(); fluid.destroy()
```

Sim params (defaults): `simResolution` 128, `dyeResolution` 1024, `curl` 30,
`pressureIterations` 20, `pressure` 0.8, `velocityDissipation` 0.2,
`densityDissipation` 1.0, `gravity` 0, `splatRadius` 0.25, `splatForce` 6000.

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
    { cutoff: 0.7,  color: '#ee5a95' },
    { cutoff: 1.6,  color: '#fff3f8' },  // dense core reads as foam/highlight
  ],
  background: 'transparent',     // or any hex — transparent composites over page content
})
```

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
