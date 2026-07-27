import { createFluid, dye, threshold, custom, DEFAULTS, type RenderMode } from '../src/index.js'

const canvas = document.getElementById('c') as HTMLCanvasElement

const fluid = createFluid(canvas, {
  emitters: { pointer: true, ambient: { strength: 0.3 } },
})
;(window as unknown as { fluid: typeof fluid }).fluid = fluid // debug handle

// Each example = a render mode + optional per-frame emitter script + param overrides.
// This is the pattern apps use: drive fluid.splat() from their own loop (or GSAP/scroll).
interface Example {
  render: RenderMode
  params?: Partial<typeof fluid.params>
  tick?(t: number): void
  background?: string
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

const examples: Record<string, Example> = {
  dye: { render: dye() },

  threshold: {
    render: threshold({
      levels: [
        { cutoff: 0.02, color: '#2e1a47' },
        { cutoff: 0.08, color: '#7b2fbf' },
        { cutoff: 0.25, color: '#ffc7ff' },
      ],
      background: '#0b0b12',
    }),
  },

  // custom() example: ink look driven by the velocity field — dye picks the paper color,
  // speed shifts hue. Shows the uDye/uVelocity texture contract.
  custom: {
    render: custom({
      frag: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uVelocity;
uniform float uTime;

void main () {
    vec2 vel = texture(uVelocity, vUv).xy;
    float speed = length(vel) * 0.02;
    float lum = dot(texture(uDye, vUv).rgb, vec3(0.299, 0.587, 0.114));
    vec3 slow = vec3(0.98, 0.95, 0.88);           // paper
    vec3 fast = vec3(0.10, 0.15, 0.35);           // ink
    float ink = smoothstep(0.03, 0.35, lum + speed);
    vec3 col = mix(slow, fast, ink);
    col += 0.12 * ink * vec3(sin(uTime * 0.8), sin(uTime * 1.1), cos(uTime * 0.7)); // slow tint drift
    fragColor = vec4(col, 1.0);
}`,
    }),
  },

  // Pink soda poured from the top — flat sticker-liquid look, sloshseltzer style.
  soda: {
    render: threshold({
      // high cutoffs cut the smoky wisps; only dense fluid renders → cohesive liquid shapes
      levels: [
        { cutoff: 0.35, color: '#f4a8c6' },
        { cutoff: 0.7, color: '#ee5a95' },
        { cutoff: 1.6, color: '#fff3f8' }, // foam core
      ],
      background: '#f6eee3',
    }),
    background: '#f6eee3',
    // low dyeResolution = linear filtering smooths the field into metaball-like blobs
    params: { dyeResolution: 256, densityDissipation: 0.3, velocityDissipation: 0.1, curl: 3, gravity: 220 },
    tick(t) {
      const x = 0.5 + 0.05 * Math.sin(t * 0.9) // the pour sways gently
      fluid.splat(x, 0.97, 20 * Math.sin(t * 2.3), -380, { color: [0.5, 0.2, 0.3], radius: 0.25 })
    },
  },

  // Full-width curtain of water falling from the top edge.
  waterfall: {
    render: threshold({
      levels: [
        { cutoff: 0.03, color: '#123a5e' },
        { cutoff: 0.1, color: '#2e7dbd' },
        { cutoff: 0.3, color: '#bfe8ff' },
      ],
      background: '#08121f',
    }),
    background: '#08121f',
    params: { densityDissipation: 1.1, velocityDissipation: 0.05, curl: 25, gravity: 320 },
    tick() {
      for (let i = 0; i < 2; i++) {
        fluid.splat(rnd(0.15, 0.85), 0.95, rnd(-30, 30), rnd(-700, -400),
          { color: [0.05, 0.09, 0.13], radius: 0.1 })
      }
    },
  },

  // Rainbow jet from the bottom, smoky render.
  fountain: {
    render: dye(),
    params: { densityDissipation: 1.5, curl: 40, gravity: 100 }, // jets rise, arcs fall back
    tick(t) {
      const hue = (t * 0.1) % 1
      const spread = 0.12 * Math.sin(t * 1.7)
      fluid.splat(0.5, 0.03, spread * 900, rnd(500, 700), { color: hsv015(hue), radius: 0.2 })
    },
  },
}

function hsv015(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return 0.2 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return [f(5), f(3), f(1)]
}

let active: Example = examples.dye
function select(name: string) {
  active = examples[name]
  fluid.setRenderMode(active.render)
  Object.assign(fluid.params, DEFAULTS, active.params)
  document.body.style.background = active.background ?? '#0b0b12'
  document.querySelectorAll('.ui button').forEach(b => b.classList.toggle('active', b.id === name))
}

for (const name of Object.keys(examples))
  document.getElementById(name)!.addEventListener('click', () => select(name))

function drive(now: number) {
  active.tick?.(now / 1000)
  requestAnimationFrame(drive)
}
requestAnimationFrame(drive)

// A few droplets on load so the canvas isn't empty before the first interaction.
for (let i = 0; i < 6; i++) {
  fluid.splat(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6,
    (Math.random() - 0.5) * 800, (Math.random() - 0.5) * 800)
}
