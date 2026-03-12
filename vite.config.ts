import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@dimforge/rapier3d/rapier_wasm3d_bg.wasm',
          dest: '.'
        }
      ]
    })
  ],
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d']
  }
})
