import { createFluid, dye, threshold, custom, displacement, DEFAULTS, type RenderMode } from '../src/index.js'

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
  overlay?: boolean
  light?: boolean // light background — flips nav/footer chrome for contrast
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

const glslHeader = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uVelocity;
uniform float uTime;
float lum() { return dot(texture(uDye, vUv).rgb, vec3(0.299, 0.587, 0.114)); }
`

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
      frag: glslHeader + `
void main () {
    float speed = length(texture(uVelocity, vUv).xy) * 0.02;
    vec3 slow = vec3(0.98, 0.95, 0.88);           // paper
    vec3 fast = vec3(0.10, 0.15, 0.35);           // ink
    float ink = smoothstep(0.03, 0.35, lum() + speed);
    vec3 col = mix(slow, fast, ink);
    col += 0.12 * ink * vec3(sin(uTime * 0.8), sin(uTime * 1.1), cos(uTime * 0.7));
    fragColor = vec4(col, 1.0);
}`,
    }),
    light: true, // shader paints paper-white over the whole canvas
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
    light: true,
    // low dyeResolution = linear filtering smooths the field into metaball-like blobs
    params: { dyeResolution: 256, densityDissipation: 0.3, velocityDissipation: 0.1, curl: 3, gravity: 220 },
    tick(t) {
      const x = 0.5 + 0.05 * Math.sin(t * 0.9) // the pour sways gently
      fluid.splat(x, 0.97, 20 * Math.sin(t * 2.3), -380, { color: [0.5, 0.2, 0.3], radius: 0.25 })
    },
  },

  // Streams of water raining from the top edge into a pool.
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

  // Gooey metaball cursor — chunky blobs chase the pointer and melt away.
  goo: {
    render: threshold({
      levels: [
        { cutoff: 0.06, color: '#3b1f5e' },
        { cutoff: 0.16, color: '#8a4fff' },
        { cutoff: 0.4, color: '#f0e9ff' },
      ],
      background: 'transparent',
      outline: { color: '#16091f', width: 3 }, // sticker stroke — crisp on metaball edges
    }),
    background: 'radial-gradient(circle at 30% 20%, #17102a, #0a0710)',
    params: { dyeResolution: 128, curl: 0, densityDissipation: 2.2, velocityDissipation: 0.6, splatRadius: 0.6, splatForce: 4000 },
  },

  // Hover reveal: the cursor paints a drifting aurora out of the darkness.
  aurora: {
    render: custom({
      frag: glslHeader + `
void main () {
    float w = 0.5 * sin(vUv.x * 4.0 + uTime * 0.4) + 0.5 * sin(vUv.y * 3.0 - uTime * 0.23);
    vec3 a = mix(vec3(0.05, 0.65, 0.55), vec3(0.15, 0.25, 0.85), 0.5 + 0.5 * w);
    a = mix(a, vec3(0.75, 0.3, 0.85), 0.5 + 0.5 * sin(vUv.y * 5.0 + uTime * 0.31));
    float reveal = smoothstep(0.01, 0.35, lum());
    fragColor = vec4(mix(vec3(0.015, 0.015, 0.03), a, reveal), 1.0);
}`,
    }),
    params: { densityDissipation: 0.25, velocityDissipation: 0.15, curl: 35 },
  },

  // Liquid chrome: thin-film iridescence driven by dye density and flow speed.
  chrome: {
    render: custom({
      frag: glslHeader + `
void main () {
    float l = lum();
    float t = l * 1.2 + length(texture(uVelocity, vUv).xy) * 0.004 + uTime * 0.03;
    vec3 film = 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
    float mask = smoothstep(0.03, 0.35, l);
    fragColor = vec4(film * mask, 1.0);
}`,
    }),
    params: { curl: 45, densityDissipation: 0.8 },
  },

  // Living topographic map: contour lines around the flowing dye, ink on paper.
  contour: {
    render: custom({
      frag: glslHeader + `
void main () {
    float l = lum();
    float f = abs(fract(l * 6.0 - uTime * 0.25) - 0.5);
    float line = 1.0 - smoothstep(0.03, 0.09, f);
    vec3 col = mix(vec3(0.96, 0.94, 0.89), vec3(0.85, 0.88, 0.9), clamp(l, 0.0, 1.0) * 0.5);
    col = mix(col, vec3(0.15, 0.17, 0.2), line * smoothstep(0.02, 0.1, l));
    fragColor = vec4(col, 1.0);
}`,
    }),
    background: '#f5f0e4',
    light: true,
    params: { curl: 20, densityDissipation: 0.4, velocityDissipation: 0.1 },
  },

  // Refraction: the flow field distorts a poster texture with chromatic aberration.
  refract: {
    render: displacement({ source: makePoster(), strength: 12, chromatic: 0.6 }),
    params: { curl: 4, velocityDissipation: 0.3 }, // low curl = glassy ripples, not shredding
  },

  // Landing-page hero: buoyant liquid blobs drift behind big typography.
  hero: {
    render: threshold({
      levels: [
        { cutoff: 0.25, color: '#3b1f5e' },
        { cutoff: 0.6, color: '#8a4fff' },
        { cutoff: 1.3, color: '#ee5a95' },
      ],
      background: 'transparent',
    }),
    background: '#0b0b12',
    overlay: true,
    params: { dyeResolution: 256, curl: 2, densityDissipation: 0.2, velocityDissipation: 0.2 },
    tick(t) {
      if (Math.floor(t * 2) % 3 === 0) {
        // lazy lava-lamp: slow fat blobs released from the bottom
        fluid.splat(rnd(0.15, 0.85), 0.05, rnd(-40, 40), rnd(120, 260),
          { color: [0.4, 0.18, 0.28], radius: rnd(0.3, 0.6) })
      }
    },
  },
}

// Procedural poster for the displacement demo — any image/canvas/URL works.
function makePoster(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 1024
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 1024, 1024)
  grad.addColorStop(0, '#1a1040')
  grad.addColorStop(0.5, '#4a1f7a')
  grad.addColorStop(1, '#0b3954')
  g.fillStyle = grad
  g.fillRect(0, 0, 1024, 1024)
  g.font = '900 175px system-ui'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i % 2 ? '#ffffffde' : '#ee5a95cc'
    g.fillText('FLUID', 512, 105 + i * 165)
  }
  return c
}

function hsv015(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return 0.2 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return [f(5), f(3), f(1)]
}

// ---- navigation (built from the examples table) ----
const nav = document.getElementById('modes')!
const overlay = document.getElementById('hero-overlay') as HTMLElement
let active: Example = examples.dye

function select(name: string) {
  active = examples[name]
  fluid.setRenderMode(active.render)
  Object.assign(fluid.params, DEFAULTS, active.params)
  document.body.style.background = active.background ?? '#0b0b12'
  document.body.classList.toggle('light', !!active.light)
  overlay.hidden = !active.overlay
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.name === name))
}

for (const name of Object.keys(examples)) {
  const b = document.createElement('button')
  b.textContent = name
  b.dataset.name = name
  b.addEventListener('click', () => select(name))
  nav.appendChild(b)
}
select('dye')

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
