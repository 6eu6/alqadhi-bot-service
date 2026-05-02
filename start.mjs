import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This service requires the Bun runtime
if (typeof Bun === 'undefined') {
  console.error('[FATAL] This service requires the Bun runtime. Install Bun from https://bun.sh')
  process.exit(1)
}

// Polyfill __dirname for ESM
globalThis.__dirname = dirname(fileURLToPath(import.meta.url))

// Now import the main file
await import('./index.ts')
