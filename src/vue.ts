// Vue 3 wrapper. Import from '@dilukangelo/fluidkit/vue'. vue is an optional peer dep.

import { defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import { createFluid, type Fluid, type FluidOptions } from './index.js'

/**
 * <FluidCanvas :options="{ render: threshold({...}) }" @ready="f => ..." />
 * ponytail: options are read once at mount — tune live via the ready event + fluid.params.
 */
export const FluidCanvas = defineComponent({
  name: 'FluidCanvas',
  props: {
    options: { type: Object as PropType<FluidOptions>, default: () => ({}) },
  },
  emits: ['ready'],
  setup(props, { emit }) {
    const el = ref<HTMLCanvasElement>()
    let fluid: Fluid | undefined
    onMounted(() => {
      fluid = createFluid(el.value!, props.options)
      emit('ready', fluid)
    })
    onBeforeUnmount(() => fluid?.destroy())
    return () => h('canvas', { ref: el, style: { display: 'block', touchAction: 'none' } })
  },
})
