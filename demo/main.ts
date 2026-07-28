import { createFluid, dye, threshold, custom, displacement, ramp, textMask, DEFAULTS, type RenderMode } from '../src/index.js'

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
  overlay?: 'hero' | 'logo'
  light?: boolean // light background — flips nav/footer chrome for contrast
  ambient?: false // opt out of the rainbow wanderers (tick-driven scenes keep their palette clean)
  enter?(): void // set masks/obstacles; select() clears them before calling
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
      bubbles: { density: 0.55, rise: 1, size: 0.035, brightness: 0.3 }, // carbonation
    }),
    background: '#f6eee3',
    light: true,
    // low dyeResolution = linear filtering smooths the field into metaball-like blobs
    ambient: false,
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
    ambient: false,
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

  // Gray smoke plume rising off an ember, drifting with the wind.
  smoke: {
    render: dye({ brightness: 1.1 }),
    ambient: false,
    params: { curl: 50, densityDissipation: 0.7, velocityDissipation: 0.15, wind: 40 },
    tick(t) {
      const x = 0.35 + 0.04 * Math.sin(t * 1.3)
      fluid.splat(x, 0.06, rnd(-20, 60), rnd(280, 460),
        { color: [0.11, 0.11, 0.12], radius: rnd(0.12, 0.22) })
    },
  },

  // Fire: dense rising jets mapped through a flame ramp — fast fade gives the licking tips.
  fire: {
    render: ramp({ colors: ['#0a0302', '#571e07', '#c1400b', '#ff9d1c', '#ffe9b0'], scale: 1.1 }),
    ambient: false,
    params: { curl: 38, densityDissipation: 2.2, velocityDissipation: 0.5 },
    tick() {
      for (let i = 0; i < 2; i++) {
        fluid.splat(0.5 + rnd(-0.09, 0.09), 0.04, rnd(-80, 80), rnd(550, 850),
          { color: [0.5, 0.34, 0.16], radius: rnd(0.1, 0.18) })
      }
    },
  },

  // Fizz: amber seltzer pooled at the bottom, carbonation streaming upward.
  fizz: {
    render: threshold({
      levels: [
        { cutoff: 0.1, color: '#b95d13' },
        { cutoff: 0.3, color: '#f4881f' },
        { cutoff: 0.75, color: '#ffe8b8' },
      ],
      background: '#160c04',
      bubbles: { density: 0.85, rise: 1.6, size: 0.03, brightness: 0.4 },
    }),
    background: '#160c04',
    ambient: false,
    // gentle gravity: enough to settle, weak enough that the pool builds instead of draining
    params: { dyeResolution: 256, curl: 4, gravity: 60, densityDissipation: 0.1, velocityDissipation: 0.3 },
    tick() {
      fluid.splat(rnd(0.1, 0.9), rnd(0.05, 0.28), rnd(-40, 40), rnd(-30, 30),
        { color: [0.5, 0.27, 0.08], radius: 0.5 }) // keep the glass topped up
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

  // Neon: the classic look with a glow halo.
  neon: {
    render: dye({ glow: 1.4, glowRadius: 48, brightness: 1.3 }),
    params: { curl: 45, densityDissipation: 1.6 }, // fast fade = thin bright trails, big halo
  },

  // Gradient-map: dye density drives a lava color ramp.
  lava: {
    render: ramp({ colors: ['#0b0212', '#4a0f5e', '#c0245e', '#ff8a5c', '#ffe8d6'], scale: 1.4 }),
    params: { curl: 25, densityDissipation: 0.4 },
  },

  // Wet-jelly slime: threshold + gradient-normal lighting.
  jelly: {
    render: threshold({
      levels: [
        { cutoff: 0.12, color: '#1d5c14' },
        { cutoff: 0.35, color: '#3fae3f' },
        { cutoff: 0.8, color: '#a5e87b' },
      ],
      background: '#0a0f08',
      lighting: { strength: 8, specular: 1.1 },
    }),
    background: '#0a0f08',
    // dissipation keeps blobs finite — saturated flat sheets have no gradient for the lighting to shade
    params: { dyeResolution: 192, curl: 1, densityDissipation: 1.2, velocityDissipation: 0.3, splatRadius: 0.5 },
  },

  // "Pour from a logo": the word itself bleeds liquid, pulled down by gravity.
  logo: {
    render: threshold({
      levels: [
        { cutoff: 0.15, color: '#f4a8c6' },
        { cutoff: 0.4, color: '#ee5a95' },
        { cutoff: 1.0, color: '#fff3f8' },
      ],
      background: '#f6eee3',
    }),
    background: '#f6eee3',
    light: true,
    overlay: 'logo', // the crisp SVG logo sits on top; liquid bleeds out from behind it
    ambient: false,
    params: { dyeResolution: 256, curl: 3, gravity: 120, densityDissipation: 0.45, velocityDissipation: 0.2 },
    enter() {
      // a real image logo as the emitter mask — any white-on-transparent SVG/PNG works
      fluid.setEmitterMask('/logo.svg', { color: [0.5, 0.18, 0.3], strength: 8 })
    },
  },

  // Obstacle: water pours over the invisible word FLOW — the letters appear as negative space.
  collide: {
    render: threshold({
      levels: [
        { cutoff: 0.06, color: '#123a5e' },
        { cutoff: 0.18, color: '#2e7dbd' },
        { cutoff: 0.45, color: '#bfe8ff' },
      ],
      background: '#08121f',
    }),
    background: '#08121f',
    ambient: false,
    params: { dyeResolution: 512, curl: 8, gravity: 240, densityDissipation: 0.3, velocityDissipation: 0.1 },
    enter() {
      fluid.setObstacle(textMask('FLOW', { size: 0.42, weight: 900 }))
    },
    tick() {
      for (let i = 0; i < 2; i++) {
        fluid.splat(rnd(0.2, 0.8), 0.95, rnd(-20, 20), rnd(-500, -300),
          { color: [0.08, 0.13, 0.18], radius: 0.12 })
      }
    },
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
    overlay: 'hero',
    ambient: false,
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
const overlays = {
  hero: document.getElementById('hero-overlay') as HTMLElement,
  logo: document.getElementById('logo-overlay') as HTMLElement,
}
let active: Example = examples.dye

function select(name: string) {
  active = examples[name]
  fluid.setRenderMode(active.render)
  fluid.setEmitterMask(null)
  fluid.setObstacle(null)
  Object.assign(fluid.params, DEFAULTS, active.params)
  fluid.setAmbient(active.ambient === false ? null : { strength: 0.3 })
  fluid.reset() // each example starts from clean fluid, not the previous mode's leftovers
  active.enter?.()
  document.body.style.background = active.background ?? '#0b0b12'
  document.body.classList.toggle('light', !!active.light)
  for (const [k, el] of Object.entries(overlays)) el.hidden = active.overlay !== k
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.name === name))
  syncPanel()
}

for (const name of Object.keys(examples)) {
  const b = document.createElement('button')
  b.textContent = name
  b.dataset.name = name
  b.addEventListener('click', () => select(name))
  nav.appendChild(b)
}

// ---- playground panel: live sliders for every sim param + copy-config ----
const SLIDERS: [keyof typeof fluid.params, number, number, number][] = [
  ['curl', 0, 60, 1],
  ['pressureIterations', 1, 60, 1],
  ['velocityDissipation', 0, 4, 0.05],
  ['densityDissipation', 0, 4, 0.05],
  ['gravity', 0, 600, 10],
  ['wind', -400, 400, 10],
  ['speed', 0.1, 2, 0.05],
  ['splatRadius', 0.05, 1, 0.01],
  ['splatForce', 1000, 12000, 100],
]
const panel = document.getElementById('panel')!
const sliderEls = new Map<string, { input: HTMLInputElement; label: HTMLElement }>()
for (const [key, min, max, step] of SLIDERS) {
  const label = document.createElement('label')
  const nameSpan = document.createElement('span')
  nameSpan.textContent = key
  const valSpan = document.createElement('span')
  label.append(nameSpan, valSpan)
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.addEventListener('input', () => {
    fluid.params[key] = Number(input.value)
    valSpan.textContent = input.value
  })
  panel.append(label, input)
  sliderEls.set(key, { input, label: valSpan })
}
const copyBtn = document.createElement('button')
copyBtn.className = 'copy'
copyBtn.textContent = 'copy config'
copyBtn.addEventListener('click', () => {
  const diff: Record<string, number> = {}
  for (const [k, v] of Object.entries(fluid.params))
    if (v !== DEFAULTS[k as keyof typeof DEFAULTS]) diff[k] = v
  navigator.clipboard.writeText(JSON.stringify(diff, null, 2))
  copyBtn.textContent = 'copied!'
  setTimeout(() => { copyBtn.textContent = 'copy config' }, 1200)
})
panel.append(copyBtn)

function syncPanel() {
  for (const [key, { input, label }] of sliderEls) {
    const v = fluid.params[key as keyof typeof fluid.params]
    input.value = String(v)
    label.textContent = String(Math.round(v * 100) / 100)
  }
}
document.getElementById('tune-toggle')!.addEventListener('click', () => {
  panel.hidden = !panel.hidden
  if (!panel.hidden) syncPanel()
})
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
