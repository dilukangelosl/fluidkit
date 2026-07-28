// Svelte action. Import from '@dilukangelo/fluidkit/svelte'. No svelte dependency needed.
//
//   <canvas use:fluid={{ render: threshold({...}), onReady: f => ... }} />

import { createFluid, type Fluid, type FluidOptions } from './index.js'

export interface FluidActionOptions extends FluidOptions {
  onReady?: (fluid: Fluid) => void
}

export function fluid(node: HTMLCanvasElement, options: FluidActionOptions = {}) {
  const { onReady, ...rest } = options
  const instance = createFluid(node, rest)
  onReady?.(instance)
  return {
    destroy() {
      instance.destroy()
    },
  }
}
