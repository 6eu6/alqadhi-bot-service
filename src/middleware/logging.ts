/**
 * AlQadi Store — Update Logging Middleware
 * Logs all incoming updates with timing information.
 */

import { Telegraf } from 'telegraf'
import { log } from '../helpers.js'
import { getEffectiveChatId } from '../admin.js'

export function registerLoggingMiddleware(bot: Telegraf<any>) {
  bot.use(async (ctx, next) => {
    const startTime = Date.now()

    // Determine update type
    let updateType = 'unknown'
    if (ctx.updateType) updateType = ctx.updateType
    if (ctx.update?.message) updateType = `message:${ctx.update.message.text ? 'text' : ctx.update.message.photo ? 'photo' : 'other'}`
    if (ctx.update?.callback_query) updateType = `callback_query`
    if (ctx.update?.inline_query) updateType = `inline_query`

    const chatId = getEffectiveChatId(ctx)
    const fromId = ctx.from?.id

    log('update', `[${updateType}] from=${fromId} chat=${chatId || 'N/A'}`)

    // Execute the handler chain
    await next()

    const elapsed = Date.now() - startTime
    if (elapsed > 3000) {
      log('update', `SLOW [${updateType}] took ${elapsed}ms`)
    }
  })
}
