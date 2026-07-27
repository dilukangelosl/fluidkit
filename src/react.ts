// Thin React lifecycle wrapper. Import from '@dilukangelo/fluidkit/react'.
// react is an optional peer dependency — the core package never touches it.

import { createElement, useEffect, useRef, type CSSProperties } from 'react'
import { createFluid, type Fluid, type FluidOptions } from './index.js'

export interface FluidCanvasProps extends FluidOptions {
  className?: string
  style?: CSSProperties
  /** Grab the instance for splats and live param tuning. */
  onReady?: (fluid: Fluid) => void
}

/**
 * Full-bleed fluid canvas with managed lifecycle.
 * ponytail: options are read once at mount — tune at runtime via onReady + fluid.params,
 * or key the component to force a remount.
 */
export function FluidCanvas(props: FluidCanvasProps) {
  const { className, style, onReady, ...options } = props
  const ref = useRef<HTMLCanvasElement | null>(null)
  const init = useRef({ options, onReady })
  useEffect(() => {
    const fluid = createFluid(ref.current!, init.current.options)
    init.current.onReady?.(fluid)
    return () => fluid.destroy()
  }, [])
  return createElement('canvas', {
    ref,
    className,
    style: { display: 'block', touchAction: 'none', ...style },
  })
}
