// GPU pixel-smoke test: serves the built demo, loads it in headless Chrome (SwiftShader),
// and asserts several modes actually put pixels on screen with zero console errors.
// Locally: uses your installed Chrome. CI: CHROME_PATH is set by browser-actions/setup-chrome.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const PORT = 4179
const server = spawn('npx', ['vite', 'preview', 'demo', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: false,
})
const kill = () => { try { server.kill() } catch {} }
process.on('exit', kill)

// wait for the server
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://localhost:${PORT}/`)
    break
  } catch {
    if (i === 59) { console.error('FAIL: preview server never came up'); process.exit(1) }
    await new Promise(r => setTimeout(r, 500))
  }
}

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
await page.waitForTimeout(800)

async function nonBgRatio() {
  const png = (await page.screenshot()).toString('base64')
  return page.evaluate(async dataUrl => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const x = c.getContext('2d')
    x.drawImage(img, 0, 0)
    const d = x.getImageData(0, 0, c.width, c.height).data
    const counts = new Map()
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const total = d.length / 4
    const dominant = Math.max(...counts.values())
    return 1 - dominant / total // fraction of pixels differing from the single dominant color
  }, 'data:image/png;base64,' + png)
}

let failed = false
for (const [mode, wait] of [['dye', 2500], ['soda', 5000], ['jelly', 2500], ['neon', 2500], ['collide', 5000]]) {
  await page.click(`[data-name="${mode}"]`)
  if (mode === 'jelly' || mode === 'neon') {
    for (let i = 0; i < 25; i++) { await page.mouse.move(100 + i * 18, 240 + Math.sin(i * 0.4) * 120); await page.waitForTimeout(16) }
  }
  await page.waitForTimeout(wait)
  const ratio = await nonBgRatio()
  const ok = ratio > 0.02
  console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}: ${(ratio * 100).toFixed(1)}% non-background pixels`)
  if (!ok) failed = true
}
if (errors.length) { console.error('FAIL: console errors:', errors); failed = true }
await browser.close()
kill()
process.exit(failed ? 1 : 0)
