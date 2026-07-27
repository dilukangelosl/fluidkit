# fluidkit

Framework-agnostic GPU fluid simulation for the web. The sim engine (Stable Fluids on WebGL2)
produces velocity/dye field textures; pluggable render modes consume them — smoky dye, flat
posterized "sticker" liquid, or your own fragment shader.

**Status: v0.1** — WebGL2 backend, `dye` / `threshold` / `custom` render modes, pointer +
programmatic + ambient emitters. WebGPU backend, displacement mode, and a React wrapper
are on the roadmap.

> **Building with an AI coding agent?** Point it at [AGENTS.md](./AGENTS.md) — a complete
> guide with landing-page recipes, the liquid-vs-smoke look formula, and pitfalls.

## Quickstart

```ts
import { createFluid, threshold } from 'fluidkit'

const fluid = createFluid(canvas, {
  emitters: { pointer: true, ambient: { strength: 0.2 } },
  render: threshold({
    levels: [{ cutoff: 0.1, color: '#ffc7ff' }],
    background: 'transparent',
  }),
})
```

That's it — interactive fluid on your canvas. Omit `render` for the classic smoky dye look.

## API

```ts
fluid.splat(x, y, dx, dy, { color: '#ffc7ff', radius: 0.25 }) // programmatic droplet, x/y in [0,1], y up
fluid.params.curl = 45                                        // all sim params live-tunable
fluid.setRenderMode(dye())                                    // swap looks at runtime
const tex = fluid.getTexture('dye')                           // raw WebGLTexture for three.js/pixi
fluid.pause(); fluid.resume(); fluid.destroy()
```

Sim params (all optional in `createFluid` options, all live-tunable via `fluid.params`):
`simResolution` (128), `dyeResolution` (1024), `curl` (30), `pressureIterations` (20),
`pressure` (0.8), `velocityDissipation` (0.2), `densityDissipation` (1.0),
`gravity` (0 — set 100–400 for pours/waterfalls), `splatRadius` (0.25), `splatForce` (6000).

### Render modes

- `dye()` — classic smoky multicolor.
- `threshold({ levels, background })` — up to 8 posterized levels with edge AA (the "Slosh" look).
- `custom({ frag, uniforms })` — your GLSL ES 3.00 fragment shader; sample `uDye`, `uVelocity`,
  `uPressure`, use `uTime` and `texelSize`.

### Behavior you get for free

- Pauses when the tab is hidden or the canvas scrolls off-viewport.
- Respects `prefers-reduced-motion` (opt out with `respectReducedMotion: false`).
- Recovers from WebGL context loss; resizes with the canvas; multiple instances per page;
  `destroy()` releases all GPU resources.
- SSR-safe: importing the package touches no browser globals.

## Develop

```sh
npm install
npm run dev    # live demo at localhost:5173 with mode switcher
npm test       # host-side unit tests (node 22.6+ / 24)
npm run build  # ESM + .d.ts to dist/
```

Requires WebGL2 with `EXT_color_buffer_float` (any non-ancient device).

MIT
