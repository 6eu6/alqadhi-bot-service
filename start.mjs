import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Polyfill __dirname for ESM
globalThis.__dirname = dirname(fileURLToPath(import.meta.url))

// Now import the main file
await import('./index.ts')
