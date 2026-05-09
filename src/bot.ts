/**
 * AlQadi Store — Bot Instance & Startup
 * Creates the Telegraf bot, registers all middleware and handlers,
 * sets up error handling, and provides the startup function.
 */

import { Telegraf } from 'telegraf'
import { BOT_TOKEN, SUPER_ADMIN_CHAT_ID, SERVICE_PORT, WEBHOOK_SECRET } from './config.js'
import { db } from './database.js'
import { log } from './helpers.js'
import { adminCache } from './admin.js'
import { conversations } from './conversations.js'
import { initNotifications } from './notifications.js'
import { registerLoggingMiddleware } from './middleware/logging.js'
import { registerAuthMiddleware } from './middleware/auth.js'
import { registerKeyboardHandlers } from './handlers/keyboard.js'
import { registerCallbackHandlers } from './handlers/callbacks.js'
import { registerTextHandler } from './handlers/text.js'
import { registerCommandHandlers } from './handlers/commands.js'
import { createHttpServer } from './server.js'
import { ensureSuperAdmin, refreshAdminCache } from './admin.js'

// =============================================================================
// §9  BOT INITIALIZATION
// =============================================================================

export const bot = new Telegraf(BOT_TOKEN!, {
  telegram: {
    // Increase API retry timeouts for reliability
    apiRoot: 'https://api.telegram.org/bot',
  },
})

// Initialize the notifications module with the bot instance
initNotifications(bot)

// =============================================================================
// §10 MIDDLEWARE — Register logging + auth
// =============================================================================

registerLoggingMiddleware(bot)
registerAuthMiddleware(bot)

// =============================================================================
// §11-13 HANDLERS — Register all handlers
// =============================================================================

registerKeyboardHandlers(bot)
registerCallbackHandlers(bot)
registerTextHandler(bot)
registerCommandHandlers(bot)

// =============================================================================
// §14 ERROR HANDLING — bot.catch() + process handlers
// =============================================================================

// --- 14a. Global bot error handler (catches ALL unhandled Telegraf errors) ---
bot.catch((err: any) => {
  log('bot.catch', 'UNHANDLED ERROR in bot handler:')
  log('bot.catch', `  Message: ${err?.message || 'Unknown'}`)
  log('bot.catch', `  Code: ${err?.code || 'N/A'}`)
  log('bot.catch', `  on: ${err?.on || 'unknown handler'}`)
  log('bot.catch', `  Stack: ${err?.stack || 'N/A'}`)
  // Do NOT rethrow — this keeps the bot alive
})

// --- 14b. Process-level error handlers (keep the process alive) ---
process.on('unhandledRejection', (reason, promise) => {
  log('process', 'UNHANDLED REJECTION at:', promise, 'reason:', reason)
  // Do NOT exit — keep the bot running
})

process.on('uncaughtException', (err) => {
  log('process', 'UNCAUGHT EXCEPTION:', err?.message || err)
  log('process', `  Stack: ${err?.stack || 'N/A'}`)
  // Exit to let the process manager (Render/Railway) restart cleanly
  process.exit(1)
})

// =============================================================================
// §16 LAUNCH — Bootstrap, start polling, graceful shutdown
// =============================================================================

export async function startup() {
  // Create HTTP server for health check + webhook endpoint
  const server = createHttpServer(bot)

  // Start health check + webhook server
  server.listen(SERVICE_PORT, () => {
    log('health', `Server running on port ${SERVICE_PORT}`)
    log('health', `Endpoints: GET /health, POST /webhook/orders`)
    if (WEBHOOK_SECRET) {
      log('health', `Webhook authentication: enabled`)
    } else {
      log('health', `WARN Webhook authentication: DISABLED (no BOT_WEBHOOK_SECRET or INTERNAL_API_SECRET)`)
    }
  })

  // Test database connection
  try {
    await db.$connect()
    log('db', 'Connected to Supabase (PostgreSQL)')
  } catch (dbErr) {
    log('db', 'FATAL Failed to connect to database:', dbErr)
    process.exit(1)
  }

  // Initialize admin system
  await ensureSuperAdmin()
  await refreshAdminCache()

  // Register bot commands with Telegram
  bot.telegram.setMyCommands([
    { command: 'start', description: 'بدء المحادثة مع البوت' },
    { command: 'orders', description: 'عرض الطلبات المعلقة' },
    { command: 'stats', description: 'إحصائيات سريعة' },
  ])

  // Launch bot with long-polling
  bot.launch({
    dropPendingUpdates: true,
    // Telegraf v4 polling options for stability
    allowedUpdates: ['message', 'callback_query'],
  })

  log('bot', '✅ AlQadi Store bot is running')
  log('bot', `👑 Super Admin: ${SUPER_ADMIN_CHAT_ID}`)
  log('bot', `👥 Total Admins: ${adminCache.size}`)
  log('bot', `🔔 Webhook: ${WEBHOOK_SECRET ? 'enabled' : 'disabled'}`)
  log('bot', '📡 Polling updates...')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log('shutdown', `Received ${signal} — shutting down gracefully...`)
    try {
      bot.stop('Shutting down')
      server.close()
      // Clean up all conversation timeouts to prevent memory leaks
      for (const state of conversations.values()) {
        if (state.timeout) clearTimeout(state.timeout)
      }
      conversations.clear()
      await db.$disconnect()
      log('shutdown', 'All connections closed, state cleaned up')
      process.exit(0)
    } catch (err) {
      log('shutdown', 'Error during shutdown:', err)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
