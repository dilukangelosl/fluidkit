// Host-side math/API checks (PRD 6.6: unit tests on math/host API).
// GPU passes are eyeballed via `npm run dev`; pixel-diff CI comes later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseColor, hsv, computeResolution, DEFAULTS } from '../src/utils.ts'

test('parseColor handles hex and tuples', () => {
  assert.deepEqual(parseColor('#ff0000'), [1, 0, 0])
  assert.deepEqual(parseColor('#0f0'), [0, 1, 0])
  assert.deepEqual(parseColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3])
  assert.throws(() => parseColor('#nope'))
})

test('hsv produces rgb in range', () => {
  for (const h of [0, 0.25, 0.5, 0.99, 1.5, -0.3]) {
    const rgb = hsv(h, 1, 1)
    assert.equal(rgb.length, 3)
    for (const c of rgb) assert.ok(c >= 0 && c <= 1, `channel ${c} out of range at h=${h}`)
  }
  assert.deepEqual(hsv(0, 1, 1), [1, 0, 0])
})

test('computeResolution follows aspect, shorter edge = base', () => {
  assert.deepEqual(computeResolution(128, 1920, 1080), { width: 228, height: 128 })
  assert.deepEqual(computeResolution(128, 1080, 1920), { width: 128, height: 228 })
  assert.deepEqual(computeResolution(128, 0, 0), { width: 128, height: 128 }) // degenerate canvas
})

test('defaults are sane', () => {
  assert.ok(DEFAULTS.simResolution <= DEFAULTS.dyeResolution)
  assert.ok(DEFAULTS.pressureIterations > 0)
})
