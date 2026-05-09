/**
 * AlQadi Store — Telegram Bot Service
 * Entry point — imports and starts the bot.
 */

import { startup } from './src/bot.js'

startup().catch((err) => {
  console.error('[FATAL] Bot startup failed:', err)
  process.exit(1)
})
