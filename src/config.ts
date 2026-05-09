/**
 * AlQadi Store — Bot Configuration
 * Loads and validates environment variables.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-compatible __dirname polyfill
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const LOCAL_ENV_PATH = join(__dirname, '..', '.env') // Local .env for standalone deployment

// ★ SECURITY: Only load the environment variables the bot actually needs.
const BOT_REQUIRED_KEYS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ADMIN_CHAT_ID',
  'SUPABASE_DATABASE_URL',
  'SUPABASE_DIRECT_URL',
  'INTERNAL_API_SECRET',
  'API_BASE_URL',
  'BOT_WEBHOOK_SECRET',
  'NODE_ENV',
])

try {
  const envContent = readFileSync(LOCAL_ENV_PATH, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // ★ Only set if the key is in the whitelist AND not already set by the system
    if (BOT_REQUIRED_KEYS.has(key) && !process.env[key]) {
      process.env[key] = value
    }
  }
  console.log('[env] Loaded environment from local .env (filtered: only bot-required keys)')
} catch (err) {
  // In production (Railway/Render), env vars come from the platform directly
  console.log('[env] No local .env found — using platform environment variables')
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
export const SUPER_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID
export const SERVICE_PORT = parseInt(process.env.PORT || '3099', 10)
export const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
export const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000'
// Secret for authenticating webhook calls from the store
// Falls back to INTERNAL_API_SECRET for simplicity (same secret used both ways)
export const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET || INTERNAL_SECRET

if (!BOT_TOKEN) {
  console.error('[FATAL] TELEGRAM_BOT_TOKEN is not configured')
  process.exit(1)
}

if (!SUPER_ADMIN_CHAT_ID) {
  console.error('[FATAL] TELEGRAM_ADMIN_CHAT_ID is not configured')
  process.exit(1)
}
